/**
 * Scan orchestration: universe filtering, incremental bar-cache maintenance
 * (tushare by-date bulk merge / eastmoney per-stock refresh), and per-stock
 * strategy evaluation with bounded memory and cooperative cancellation.
 * @module a-share-screener/screener
 */
import { join } from 'node:path'
import { defaultCacheDir, readJson, writeJson } from './cache.js'
import { eastmoneyDailyBars, eastmoneyListStocks } from './datasources/eastmoney.js'
import { tencentDailyBars } from './datasources/tencent.js'
import { RateLimiter, abortError } from './http.js'
import {
  tushareDailyForDate,
  tushareDailyForStock,
  tushareListStocks,
  tushareTradeCalendar,
  type TushareDeps,
} from './datasources/tushare.js'
import type { StrategyHit, StrategyRegistry } from './strategies/registry.js'
import { barsToSeries, fromBarTuple, toBarTuple, type Bar, type BarTuple, type StockMeta } from './types.js'

/** Plugin configuration fields the screener consumes. */
export interface ScreenerConfig {
  tokenEnv: string
  dataSource: 'auto' | 'tushare' | 'eastmoney'
  cacheDir?: string | null
  requestsPerMinute: number
  historyBars: number
  excludeST: boolean
  excludeBSE: boolean
  minListDays: number
}

/** Host services the screener needs (implemented by the plugin entry). */
export interface ScreenerHost {
  /** Resolve the tushare token: dsh credentials service first, then process env. */
  resolveToken(envName: string): Promise<string | undefined>
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
  dataSource: 'tushare' | 'eastmoney'
  tokenConfigured: boolean
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
  fetchedAt: string
  stocks: StockMeta[]
}

interface BarsFile {
  code: string
  bars: BarTuple[]
}

interface CalendarFile {
  start: string
  end: string
  dates: string[]
}

interface TushareState {
  lastDate: string
}

function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function todayYmd(): string {
  return ymd(new Date())
}

function dateMinusDays(ymdStr: string, days: number): string {
  const year = Number(ymdStr.slice(0, 4))
  const month = Number(ymdStr.slice(4, 6))
  const day = Number(ymdStr.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() - days)
  return ymd(date)
}

/** Calendar start date that safely covers `historyBars` trading days. */
function historyStartDate(historyBars: number): string {
  return dateMinusDays(todayYmd(), Math.ceil((historyBars * 7) / 5) + 30)
}

function isSt(name: string): boolean {
  return name.includes('ST') || name.includes('退')
}

function sortTuples(bars: BarTuple[]): BarTuple[] {
  return bars.sort((a, b) => a[0].localeCompare(b[0]))
}

/** Append bars, deduplicating by date (later input wins), sorted ascending. */
function mergeTuples(existing: BarTuple[], incoming: BarTuple[]): BarTuple[] {
  const byDate = new Map<string, BarTuple>()
  for (const tuple of existing) byDate.set(tuple[0], tuple)
  for (const tuple of incoming) byDate.set(tuple[0], tuple)
  return sortTuples([...byDate.values()])
}

/** Run one full screening pass. Throws loud, actionable errors on bad input. */
export async function runScreen(
  host: ScreenerHost,
  config: ScreenerConfig,
  registry: StrategyRegistry,
  args: ScreenArgs,
): Promise<ScreenResultView> {
  const startedAt = Date.now()
  const strategy = registry.get(args.strategyId)
  if (!strategy) {
    throw new Error(`unknown strategy '${args.strategyId}'. Available: ${registry.ids().join(', ')}`)
  }
  const params = registry.resolveParams(args.strategyId, args.params)

  const token = await host.resolveToken(config.tokenEnv)
  const tokenConfigured = token !== undefined && token !== ''
  let source: 'tushare' | 'eastmoney'
  const notes: string[] = []
  if (config.dataSource === 'tushare') {
    if (!tokenConfigured) {
      throw new Error(
        `dataSource is 'tushare' but no token resolved. Put your Tushare Pro token in the env var ` +
          `${config.tokenEnv} (for example in the .env file of the directory you launch dsh from, or via dsh ` +
          `credentials), or set dataSource: 'eastmoney' / 'auto' to use the free fallback.`,
      )
    }
    source = 'tushare'
  } else if (config.dataSource === 'eastmoney') {
    source = 'eastmoney'
  } else {
    source = tokenConfigured ? 'tushare' : 'eastmoney'
    if (!tokenConfigured) {
      notes.push(`no ${config.tokenEnv} configured; using the free eastmoney source`)
    }
  }

  const cacheDir = config.cacheDir ?? defaultCacheDir()
  const limiter = new RateLimiter(config.requestsPerMinute)
  const signal = args.signal
  const skipped: Record<string, number> = {}
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  // ---- Stock list (cached one day) ----
  const stocksFile = join(cacheDir, 'stocks.json')
  const today = todayYmd()
  let stocksCache = await readJson<StocksCache>(stocksFile)
  if (args.refresh || !stocksCache || stocksCache.fetchedAt.slice(0, 8) < today) {
    const stocks =
      source === 'tushare'
        ? await tushareListStocks({ token: token!, limiter }, signal)
        : await eastmoneyListStocks(limiter, signal)
    stocksCache = { fetchedAt: new Date().toISOString(), stocks }
    await writeJson(stocksFile, stocksCache)
  }
  const stocks = stocksCache.stocks
  host.log('info', `universe: ${stocks.length} listed stocks from ${source}`)

  // ---- Universe filters ----
  const minListDate = dateMinusDays(today, config.minListDays)
  const universe: StockMeta[] = []
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
  const tushareDeps: TushareDeps | undefined = source === 'tushare' && token ? { token, limiter } : undefined
  const fetchedThisRun = new Set<string>()

  if (tushareDeps) {
    await refreshTushareByDates(cacheDir, startDate, today, tushareDeps, signal, host, fetchedThisRun)
  }

  /**
   * Free-path kline acquisition with ordered source fallback: eastmoney
   * (internal host failover, incremental append) then tencent (full-window
   * refetch). Each source keeps its own cache directory because back-adjusted
   * price anchors differ between vendors and must never mix in one series.
   */
  const klineSourceCounts: Record<string, number> = {}
  // Circuit breaker: when eastmoney kline fetches fail consecutively at the
  // start (e.g. a network blocks the host), skip eastmoney for the rest of the
  // run instead of burning retries on every stock. Any success resets it.
  let eastmoneyConsecutiveFailures = 0
  let eastmoneyKlineDead = false
  const acquireFreeBars = async (stock: StockMeta): Promise<BarsFile> => {
    const errors: string[] = []
    const sources: readonly ('eastmoney' | 'tencent')[] = eastmoneyKlineDead ? ['tencent'] : ['eastmoney', 'tencent']
    for (const src of sources) {
      const file = join(cacheDir, src, 'bars', `${stock.fullCode}.json`)
      try {
        let fileData = await readJson<BarsFile>(file)
        if (!fileData || fileData.bars.length === 0) {
          const bars =
            src === 'eastmoney'
              ? await eastmoneyDailyBars(stock.fullCode, startDate, limiter, signal)
              : await tencentDailyBars(stock.fullCode, startDate, limiter, signal)
          fileData = { code: stock.fullCode, bars: bars.map(toBarTuple) }
          await writeJson(file, fileData)
          fetchedThisRun.add(stock.fullCode)
        } else if (src === 'eastmoney') {
          const refreshed = await refreshEastmoneyStock(stock.fullCode, fileData, startDate, limiter, signal)
          if (refreshed !== null) {
            fileData = refreshed
            await writeJson(file, fileData)
            fetchedThisRun.add(stock.fullCode)
          }
        } else {
          const lastDate = fileData.bars[fileData.bars.length - 1]?.[0] ?? ''
          if (lastDate !== '' && lastDate < dateMinusDays(todayYmd(), 2)) {
            const bars = await tencentDailyBars(stock.fullCode, startDate, limiter, signal)
            fileData = { code: stock.fullCode, bars: bars.map(toBarTuple) }
            await writeJson(file, fileData)
            fetchedThisRun.add(stock.fullCode)
          }
        }
        klineSourceCounts[src] = (klineSourceCounts[src] ?? 0) + 1
        if (src === 'eastmoney') eastmoneyConsecutiveFailures = 0
        return fileData
      } catch (err) {
        if (signal.aborted) throw abortError()
        errors.push(`${src}: ${err instanceof Error ? err.message : String(err)}`)
        if (src === 'eastmoney' && ++eastmoneyConsecutiveFailures >= 3) {
          eastmoneyKlineDead = true
          host.log('warn', 'eastmoney klines failing repeatedly; using tencent for the rest of this scan')
        }
      }
    }
    throw new Error(`all kline sources failed for ${stock.fullCode} — ${errors.join(' | ')}`)
  }

  const candidates: StrategyHit[] = []
  let scanned = 0
  for (const stock of universe) {
    if (signal.aborted) throw abortError()
    let fileData: BarsFile
    if (tushareDeps !== undefined) {
      const file = join(cacheDir, 'tushare', 'bars', `${stock.fullCode}.json`)
      let data = await readJson<BarsFile>(file)
      if (!data || data.bars.length === 0) {
        const bars = await tushareDailyForStock(stock.fullCode, startDate, tushareDeps, signal)
        data = { code: stock.fullCode, bars: bars.map(toBarTuple) }
        await writeJson(file, data)
        fetchedThisRun.add(stock.fullCode)
      }
      fileData = data
    } else {
      fileData = await acquireFreeBars(stock)
    }
    scanned++
    if (scanned % 200 === 0) {
      host.log('info', `scan progress: ${scanned}/${universe.length}, matched ${candidates.length}`)
    }
    const series = barsToSeries(fileData.bars.map(fromBarTuple))
    const hit = strategy.screen({ stock, bars: series }, params)
    if (hit) candidates.push(hit)
  }
  if (klineSourceCounts.tencent !== undefined) {
    notes.push(`klines served by tencent for ${klineSourceCounts.tencent} stock(s) (eastmoney unavailable)`)
  }

  candidates.sort((a, b) => a.code.localeCompare(b.code))
  return {
    strategy: strategy.id,
    dataSource: source,
    tokenConfigured,
    generatedAt: new Date().toISOString(),
    scanned,
    matched: candidates.length,
    candidates: candidates.map((hit) => ({ ...hit })),
    skipped,
    stocksFetched: fetchedThisRun.size,
    durationMs: Date.now() - startedAt,
    notes,
    disclaimer: DISCLAIMER,
  }
}

/**
 * Tushare incremental refresh: fetch by-trade-date bulk rows for every open
 * date newer than the merged state, merge them into the per-stock bar files,
 * and advance the state. One API call covers the whole market for one day.
 */
async function refreshTushareByDates(
  cacheDir: string,
  startDate: string,
  today: string,
  deps: TushareDeps,
  signal: AbortSignal,
  host: ScreenerHost,
  fetchedThisRun: Set<string>,
): Promise<void> {
  const calendarFile = join(cacheDir, 'tushare', 'calendar.json')
  const stateFile = join(cacheDir, 'tushare', 'state.json')
  let calendar = await readJson<CalendarFile>(calendarFile)
  if (!calendar || calendar.end < today || calendar.start > startDate) {
    const dates = await tushareTradeCalendar(startDate, today, deps, signal)
    calendar = { start: startDate, end: today, dates }
    await writeJson(calendarFile, calendar)
  }
  const state = (await readJson<TushareState>(stateFile)) ?? { lastDate: '' }
  const missing = calendar.dates.filter((date) => date > state.lastDate)
  if (missing.length === 0) return
  host.log('info', `tushare incremental: ${missing.length} new trade date(s) to merge`)
  const touched = new Set<string>()
  let lastMerged = state.lastDate
  for (const date of missing) {
    if (signal.aborted) throw abortError()
    const rows = await tushareDailyForDate(date, deps, signal)
    if (rows.length === 0) continue
    const byFullCode = new Map<string, BarTuple[]>()
    for (const row of rows) {
      const list = byFullCode.get(row.fullCode) ?? []
      list.push(toBarTuple(row.bar))
      byFullCode.set(row.fullCode, list)
    }
    for (const [fullCode, tuples] of byFullCode) {
      const file = join(cacheDir, 'tushare', 'bars', `${fullCode}.json`)
      const existing = await readJson<BarsFile>(file)
      const merged = mergeTuples(existing?.bars ?? [], tuples)
      await writeJson(file, { code: fullCode, bars: merged })
      touched.add(fullCode)
    }
    lastMerged = date
  }
  for (const fullCode of touched) fetchedThisRun.add(fullCode)
  if (lastMerged > state.lastDate) {
    await writeJson(stateFile, { lastDate: lastMerged } satisfies TushareState)
  }
}

/**
 * Eastmoney per-stock refresh for stale cache files: fetch from 10 days before
 * the cached tail, verify the overlapping bars still match (back-adjustment
 * drift check), then append. Returns null when the file is fresh enough.
 */
async function refreshEastmoneyStock(
  fullCode: string,
  fileData: BarsFile,
  startDate: string,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<BarsFile | null> {
  const lastDate = fileData.bars[fileData.bars.length - 1]?.[0] ?? ''
  if (lastDate === '') return null
  if (lastDate >= dateMinusDays(todayYmd(), 2)) return null
  const fetchFrom = dateMinusDays(lastDate, 10)
  const fresh = await eastmoneyDailyBars(fullCode, fetchFrom, limiter, signal)
  if (fresh.length === 0) return null
  // Overlap consistency: adjusted factors must not have drifted.
  const cachedByDate = new Map(fileData.bars.map((tuple) => [tuple[0], tuple]))
  let overlap = 0
  for (const bar of fresh) {
    const cached = cachedByDate.get(bar.date)
    if (!cached) continue
    overlap++
    const cachedClose = cached[4]
    if (cachedClose > 0 && Math.abs(bar.close / cachedClose - 1) > 0.001) {
      const full = await eastmoneyDailyBars(fullCode, startDate, limiter, signal)
      return { code: fullCode, bars: full.map(toBarTuple) }
    }
  }
  if (overlap === 0 && fresh[0] !== undefined && fresh[0].date <= lastDate) {
    // Unexpected gap: refetch the full window rather than risking a broken chain.
    const full = await eastmoneyDailyBars(fullCode, startDate, limiter, signal)
    return { code: fullCode, bars: full.map(toBarTuple) }
  }
  return { code: fullCode, bars: mergeTuples(fileData.bars, fresh.map(toBarTuple)) }
}

/** Exported for tests. */
export { mergeTuples, historyStartDate, isSt }
