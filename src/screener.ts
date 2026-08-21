/**
 * Scan orchestration: universe filtering, incremental bar-cache maintenance
 * through the active {@link DataSource}, and per-stock strategy evaluation
 * with bounded memory and cooperative cancellation.
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

interface BarsFile {
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
function historyStartDate(historyBars: number): string {
  return dateMinusDays(todayYmd(), Math.ceil(historyBars * 1.5) + 45)
}

/**
 * The latest day on which the market could have printed bars: today when it is
 * a weekday, otherwise the preceding Friday. Weekend scans must not trigger a
 * pointless whole-market refresh against Friday data.
 */
function expectedLastTradingDay(): string {
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
function isStale(fileData: BarsFile): boolean {
  const lastDate = fileData.bars[fileData.bars.length - 1]?.[0] ?? ''
  if (lastDate >= expectedLastTradingDay()) return false
  if ((fileData.fetchedAt ?? '') >= todayYmd()) return false
  return true
}

function isSt(name: string): boolean {
  return name.includes('ST') || name.includes('退')
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

  const cacheDir = config.cacheDir ?? defaultCacheDir()
  const signal = args.signal
  const skipped: Record<string, number> = {}
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  // ---- Stock list (cached one day) ----
  const stocksFile = join(cacheDir, 'stocks.json')
  const today = todayYmd()
  let stocksCache = await readJson<StocksCache>(stocksFile)
  if (args.refresh || !stocksCache || (stocksCache.fetchedAt ?? '') < today) {
    const stocks = await dataSource.listStocks(signal)
    stocksCache = { fetchedAt: today, stocks }
    await writeJson(stocksFile, stocksCache)
  }
  const stocks = stocksCache.stocks
  host.log('info', `universe: ${stocks.length} listed stocks from ${dataSource.id}`)

  // ---- Universe filters ----
  const minListDate = dateMinusDays(today, config.minListDays)
  let universe: StockMeta[] = []
  for (const stock of stocks) {
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

  host.log('info', `universe after filters: ${universe.length} (skipped ${JSON.stringify(skipped)})`)

  // ---- Incremental maintenance + per-stock scan ----
  const startDate = historyStartDate(config.historyBars)
  const fetchedThisRun = new Set<string>()

  const acquireBars = async (stock: StockMeta): Promise<BarsFile> => {
    const file = join(cacheDir, dataSource.id, 'bars', `${stock.fullCode}.json`)
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

  const candidates: StrategyHit[] = []
  let scanned = 0
  for (const stock of universe) {
    if (signal.aborted) throw abortError()
    let fileData: BarsFile
    try {
      fileData = await acquireBars(stock)
    } catch (err) {
      if (signal.aborted) throw abortError()
      skip('kline-fetch-failed')
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

  const klineFailures = skipped['kline-fetch-failed'] ?? 0
  if (klineFailures > Math.max(10, Math.floor(universe.length * 0.1))) {
    throw new Error(
      `aborting scan: kline fetch failed for ${klineFailures}/${universe.length} stocks — ` +
        `likely a systemic data-source outage. Fix connectivity, then retry.`,
    )
  }

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

/** Exported for tests. */
export { historyStartDate, isStale, isSt, expectedLastTradingDay }