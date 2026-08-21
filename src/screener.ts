/**
 * Scan orchestration: universe filtering, incremental bar-cache maintenance
 * through the active {@link DataSource}, and per-stock strategy evaluation
 * with bounded memory and cooperative cancellation.
 *
 * The heavy steps (universe preparation, per-stock bar acquisition) are
 * exported so the standalone CLI (`sync`/`scan`) can drive the same local
 * cache without going through the dsh tool layer.
 * @module a-share-screener/screener
 */
import { join } from 'node:path'
import { defaultCacheDir, readJson, writeJson } from './cache.js'
import type { DataSource } from './datasources/index.js'
import { abortError } from './http.js'
import type { StrategyHit, StrategyRegistry } from './strategies/registry.js'
import { barsToSeries, dateMinusDays, fromBarTuple, toBarTuple, ymd, type BarTuple, type StockMeta } from './types.js'

/** Plugin configuration fields the screener consumes. */
export interface ScreenerConfig {
  cacheDir?: string | null
  requestsPerMinute: number
  historyBars: number
  excludeST: boolean
  excludeBSE: boolean
  minListDays: number
  /** Cooperative tool timeout budget for one scan, milliseconds. */
  scanTimeoutMs: number
}

/** Host services the screener needs (implemented by the plugin entry). */
export interface ScreenerHost {
  log(level: 'info' | 'warn', message: string): void
}

export interface ScreenArgs {
  strategyId: string
  params?: unknown
  refresh?: boolean
  /** Restrict the universe to these 6-digit codes (watchlist / board members). */
  codes?: string[]
  signal: AbortSignal
}

/** A strategy match with the quantified evidence that triggered it (view form). */
export type CandidateView = {
  code: string
  fullCode: string
  name: string
  board: string
  strategy: string
  evidence: Record<string, number | string | boolean>
}

/** Canonical scan result consumed by the tool's schema and renderer. */
export type ScreenResultView = {
  strategy: string
  dataSource: string
  generatedAt: string
  scanned: number
  matched: number
  candidates: CandidateView[]
  skipped: Record<string, number>
  stocksFetched: number
  durationMs: number
  notes: string[]
  disclaimer: string
}

export const DISCLAIMER =
  'Technical screening of historical price/volume patterns. NOT investment advice; ' +
  'past patterns do not predict future returns. Verify fundamentals and do your own research before any decision.'

interface StocksCache {
  /** Local YYYYMMDD of the fetch, so freshness compares in one timezone. */
  fetchedAt: string
  stocks: StockMeta[]
}

export interface BarsFile {
  code: string
  /** Local YYYYMMDD when this file was last written; gates same-day refetches. */
  fetchedAt?: string
  /**
   * The window start (YYYYMMDD) this file was fetched for. Backfill happens
   * only when the requested window moved EARLIER than this — a young stock
   * whose first bar is naturally after the window must not refetch every scan.
   */
  startDate?: string
  bars: BarTuple[]
}

function todayYmd(): string {
  return ymd(new Date())
}

/** Calendar start date that safely covers `historyBars` trading days. A-shares
 * trade ~243 days/year (365/243 ≈ 1.5), so 1.5x plus a 45-day buffer is
 * required to never come up short when the requested window is wide. */
export function historyStartDate(historyBars: number): string {
  return dateMinusDays(todayYmd(), Math.ceil(historyBars * 1.5) + 45)
}

/**
 * The latest day on which the market could have printed bars: today when it is
 * a weekday, otherwise the preceding Friday. Weekend scans must not trigger a
 * pointless whole-market refresh against Friday data.
 */
export function expectedLastTradingDay(): string {
  const now = new Date()
  const day = now.getDay()
  if (day === 0) return dateMinusDays(ymd(now), 2) // Sunday → Friday
  if (day === 6) return dateMinusDays(ymd(now), 1) // Saturday → Friday
  return ymd(now)
}

/**
 * Whether cached bars are worth refreshing. The tail must be older than the
 * expected last trading day AND the file must not already have been (re)fetched
 * today — the second clause turns repeated same-day scans into cache hits while
 * still fetching today's post-close bar on the first scan of the day.
 */
export function isStale(fileData: BarsFile): boolean {
  const lastDate = fileData.bars[fileData.bars.length - 1]?.[0] ?? ''
  if (lastDate >= expectedLastTradingDay()) return false
  if ((fileData.fetchedAt ?? '') >= todayYmd()) return false
  return true
}

export function isSt(name: string): boolean {
  return name.includes('ST') || name.includes('退')
}

function cacheDirOf(config: ScreenerConfig): string {
  return config.cacheDir ?? defaultCacheDir()
}

/**
 * Stock list + universe filters (ST/BSE/recent-listing), refreshing the cached
 * list at most once per day. Shared by scanning and syncing.
 */
async function prepareUniverse(
  config: ScreenerConfig,
  dataSource: DataSource,
  signal: AbortSignal,
  refresh: boolean,
): Promise<{ stocks: StockMeta[]; skipped: Record<string, number>; today: string }> {
  const stocksFile = join(cacheDirOf(config), 'stocks.json')
  const today = todayYmd()
  let stocksCache = await readJson<StocksCache>(stocksFile)
  if (refresh || !stocksCache || (stocksCache.fetchedAt ?? '') < today) {
    const stocks = await dataSource.listStocks(signal)
    stocksCache = { fetchedAt: today, stocks }
    await writeJson(stocksFile, stocksCache)
  }

  const skipped: Record<string, number> = {}
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const minListDate = dateMinusDays(today, config.minListDays)
  const universe: StockMeta[] = []
  for (const stock of stocksCache.stocks) {
    if (config.excludeST && isSt(stock.name)) {
      skip('st-or-delisting')
      continue
    }
    if (stock.board === 'bse') {
      if (config.excludeBSE) {
        skip('bse')
        continue
      }
    }
    if (stock.listDate === '' || stock.listDate >= minListDate) {
      skip('recent-or-unknown-listing')
      continue
    }
    universe.push(stock)
  }
  return { stocks: universe, skipped, today }
}

/** Apply a code whitelist on top of the universe filters. */
function filterByCodes(stocks: StockMeta[], codes: string[] | undefined, skipped: Record<string, number>): StockMeta[] {
  if (codes === undefined || codes.length === 0) return stocks
  const wanted = new Set(codes)
  const kept = stocks.filter((stock) => wanted.has(stock.code))
  skipped['code-filtered'] = (skipped['code-filtered'] ?? 0) + (stocks.length - kept.length)
  return kept
}

/**
 * Bring one stock's bar cache up to date: full fetch when missing/backfill
 * needed, incremental refresh through the source when stale, cache hit
 * otherwise. Marks fetched codes in `fetchedThisRun`.
 */
export async function acquireBarsFile(
  config: ScreenerConfig,
  dataSource: DataSource,
  stock: StockMeta,
  startDate: string,
  today: string,
  signal: AbortSignal,
  fetchedThisRun: Set<string>,
): Promise<BarsFile> {
  const file = join(cacheDirOf(config), dataSource.id, 'bars', `${stock.fullCode}.json`)
  const fileData = await readJson<BarsFile>(file)
  const backfill = fileData?.startDate !== undefined && fileData.startDate > startDate

  if (!fileData || backfill) {
    const bars = await dataSource.dailyBars(stock.fullCode, startDate, signal)
    const result: BarsFile = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
    await writeJson(file, result)
    fetchedThisRun.add(stock.fullCode)
    return result
  }

  if (fileData.bars.length === 0) {
    // Empty file (suspended/stopped): refetch at most once per day.
    if (isStale(fileData)) {
      const bars = await dataSource.dailyBars(stock.fullCode, startDate, signal)
      const result: BarsFile = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
      await writeJson(file, result)
      fetchedThisRun.add(stock.fullCode)
      return result
    }
    return fileData
  }

  if (isStale(fileData)) {
    // Prefer the source's incremental path; fall back to a full refetch.
    if (dataSource.refreshBars) {
      const refreshed = await dataSource.refreshBars(stock.fullCode, startDate, fileData.bars.map(fromBarTuple), signal)
      if (refreshed !== null) {
        const result: BarsFile = { code: stock.fullCode, fetchedAt: today, startDate, bars: refreshed.map(toBarTuple) }
        await writeJson(file, result)
        fetchedThisRun.add(stock.fullCode)
        return result
      }
    } else {
      const bars = await dataSource.dailyBars(stock.fullCode, startDate, signal)
      const result: BarsFile = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
      await writeJson(file, result)
      fetchedThisRun.add(stock.fullCode)
      return result
    }
  }

  return fileData
}

/** Abort a run when kline fetching fails systemically. */
function assertHealthy(skipped: Record<string, number>, universeSize: number): void {
  const failures = skipped['kline-fetch-failed'] ?? 0
  if (failures > Math.max(10, Math.floor(universeSize * 0.1))) {
    throw new Error(
      `aborting scan: kline fetch failed for ${failures}/${universeSize} stocks — ` +
        `likely a systemic data-source outage. Fix connectivity, then retry.`,
    )
  }
}

/** Run one full screening pass. Throws loud, actionable errors on bad input. */
export async function runScreen(
  host: ScreenerHost,
  config: ScreenerConfig,
  dataSource: DataSource,
  registry: StrategyRegistry,
  args: ScreenArgs,
): Promise<ScreenResultView> {
  const startedAt = Date.now()
  const strategy = registry.get(args.strategyId)
  if (!strategy) {
    throw new Error(`unknown strategy '${args.strategyId}'. Available: ${registry.ids().join(', ')}`)
  }
  const params = registry.resolveParams(args.strategyId, args.params)

  const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, args.signal, args.refresh ?? false)
  const universe = filterByCodes(filtered, args.codes, skipped)
  host.log('info', `universe after filters: ${universe.length} (skipped ${JSON.stringify(skipped)})`)

  const startDate = historyStartDate(config.historyBars)
  const fetchedThisRun = new Set<string>()
  const candidates: StrategyHit[] = []
  let scanned = 0
  for (const stock of universe) {
    if (args.signal.aborted) throw abortError()
    let fileData: BarsFile
    try {
      fileData = await acquireBarsFile(config, dataSource, stock, startDate, today, args.signal, fetchedThisRun)
    } catch (err) {
      if (args.signal.aborted) throw abortError()
      skipped['kline-fetch-failed'] = (skipped['kline-fetch-failed'] ?? 0) + 1
      host.log('warn', `kline fetch failed for ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    scanned++
    if (scanned % 200 === 0) {
      host.log('info', `scan progress: ${scanned}/${universe.length}, matched ${candidates.length}`)
    }
    const series = barsToSeries(fileData.bars.map(fromBarTuple))
    const hit = strategy.screen({ stock, bars: series }, params)
    if (hit) candidates.push(hit)
  }
  assertHealthy(skipped, universe.length)

  candidates.sort((a, b) => a.code.localeCompare(b.code))
  return {
    strategy: strategy.id,
    dataSource: dataSource.id,
    generatedAt: new Date().toISOString(),
    scanned,
    matched: candidates.length,
    candidates: candidates.map((hit) => ({ ...hit })),
    skipped,
    stocksFetched: fetchedThisRun.size,
    durationMs: Date.now() - startedAt,
    notes: [],
    disclaimer: DISCLAIMER,
  }
}

/**
 * Warm the local bar cache without evaluating any strategy — the CLI `sync`
 * command. Fetches/refreshes bars for the (optionally code-restricted)
 * universe, honoring the per-source incremental refresh paths. When
 * `concurrency > 1`, fetches run in a bounded worker pool (safe: each stock
 * writes its own cache file atomically).
 */
export async function syncBars(
  host: ScreenerHost,
  config: ScreenerConfig,
  dataSource: DataSource,
  args: { refresh?: boolean; codes?: string[]; concurrency?: number; signal: AbortSignal },
): Promise<{ scanned: number; stocksFetched: number; skipped: Record<string, number>; startDate: string }> {
  const startedAt = Date.now()
  const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, args.signal, args.refresh ?? false)
  const universe = filterByCodes(filtered, args.codes, skipped)
  host.log('info', `sync: ${universe.length} stocks to refresh via ${dataSource.id}`)

  const startDate = historyStartDate(config.historyBars)
  const fetchedThisRun = new Set<string>()
  let scanned = 0
  const concurrency = Math.max(1, Math.floor(args.concurrency ?? 1))

  const work = async (): Promise<void> => {
    for (;;) {
      const stock = queue.shift()
      if (stock === undefined) return
      if (args.signal.aborted) throw abortError()
      try {
        await acquireBarsFile(config, dataSource, stock, startDate, today, args.signal, fetchedThisRun)
      } catch (err) {
        if (args.signal.aborted) throw abortError()
        skipped['kline-fetch-failed'] = (skipped['kline-fetch-failed'] ?? 0) + 1
        host.log('warn', `kline fetch failed for ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      scanned++
      if (scanned % 500 === 0) host.log('info', `sync progress: ${scanned}/${universe.length}, fetched ${fetchedThisRun.size}`)
    }
  }
  const queue = [...universe]
  await Promise.all(Array.from({ length: concurrency }, () => work()))
  assertHealthy(skipped, universe.length)
  host.log('info', `sync done: scanned ${scanned}, fetched ${fetchedThisRun.size} in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
  return { scanned, stocksFetched: fetchedThisRun.size, skipped, startDate }
}

/** Export for tests. */
export { prepareUniverse, filterByCodes }
