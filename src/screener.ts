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
  /** Cooperative tool timeout budget for one scan, milliseconds. */
  scanTimeoutMs: number
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
  /** Shenwan level-1 industry names to restrict the universe to (tushare source only). */
  industries?: string[]
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

/** Normalize industry filter input to trimmed, deduped, non-empty names. */
export function normalizeIndustries(raw: unknown): string[] {
  const out = new Set<string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const name = item.trim()
      if (name !== '') out.add(name)
    }
  }
  return [...out]
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
  limiter: RateLimiter,
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

  const industries = normalizeIndustries(args.industries)
  if (industries.length > 0 && source !== 'tushare') {
    throw new Error(
      `industry filtering requires the tushare source (the free eastmoney path carries no industry ` +
        `classification). Set a Tushare token via ${config.tokenEnv} or dataSource: 'tushare', or drop ` +
        `the industries argument.`,
    )
  }

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
  // A cache written before the industry field existed (or by the free source)
  // must not serve an industry-filtered scan: re-fetch so `industry` is present.
  const cacheMissingIndustry =
    industries.length > 0 && stocksCache !== undefined && !stocksCache.stocks.some((s) => (s.industry ?? '') !== '')
  if (args.refresh || !stocksCache || (stocksCache.fetchedAt ?? '') < today || cacheMissingIndustry) {
    const stocks =
      source === 'tushare'
        ? await tushareListStocks({ token: token!, limiter }, signal)
        : await eastmoneyListStocks(limiter, signal)
    stocksCache = { fetchedAt: today, stocks }
    await writeJson(stocksFile, stocksCache)
  }
  const stocks = stocksCache.stocks
  host.log('info', `universe: ${stocks.length} listed stocks from ${source}`)

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

  // Industry restriction (tushare only, validated above): keep stocks whose
  // Shenwan level-1 industry is in the requested set.
  if (industries.length > 0) {
    const requested = new Set(industries)
    const matched = new Set<string>()
    const before = universe.length
    universe = universe.filter((stock) => {
      const industry = (stock.industry ?? '').trim()
      if (industry !== '' && requested.has(industry)) {
        matched.add(industry)
        return true
      }
      return false
    })
    notes.push(`industry filter [${industries.join(', ')}]: kept ${universe.length}/${before} universe stocks`)
    for (const name of industries) {
      if (!matched.has(name)) {
        notes.push(`industry '${name}' matched 0 stocks; run a_share_list_industries for exact names`)
      }
    }
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
        const fileData = await readJson<BarsFile>(file)
        const backfill = fileData?.startDate !== undefined && fileData.startDate > startDate
        let result: BarsFile
        if (!fileData || backfill) {
          // No file at all, or the requested window moved earlier: full fetch.
          const bars =
            src === 'eastmoney'
              ? await eastmoneyDailyBars(stock.fullCode, startDate, limiter, signal)
              : await tencentDailyBars(stock.fullCode, startDate, limiter, signal)
          result = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
          await writeJson(file, result)
          fetchedThisRun.add(stock.fullCode)
        } else if (fileData.bars.length === 0) {
          // Empty file (suspended/stopped): refetch at most once per day.
          if (isStale(fileData)) {
            const bars =
              src === 'eastmoney'
                ? await eastmoneyDailyBars(stock.fullCode, startDate, limiter, signal)
                : await tencentDailyBars(stock.fullCode, startDate, limiter, signal)
            result = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
            await writeJson(file, result)
            fetchedThisRun.add(stock.fullCode)
          } else {
            result = fileData
          }
        } else if (src === 'eastmoney' && isStale(fileData)) {
          const refreshed = await refreshEastmoneyStock(stock.fullCode, fileData, startDate, limiter, signal)
          if (refreshed !== null) {
            refreshed.fetchedAt = today
            result = refreshed
            await writeJson(file, result)
            fetchedThisRun.add(stock.fullCode)
          } else {
            result = fileData
          }
        } else if (src === 'tencent' && isStale(fileData)) {
          const bars = await tencentDailyBars(stock.fullCode, startDate, limiter, signal)
          result = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
          await writeJson(file, result)
          fetchedThisRun.add(stock.fullCode)
        } else {
          result = fileData
        }
        klineSourceCounts[src] = (klineSourceCounts[src] ?? 0) + 1
        if (src === 'eastmoney') eastmoneyConsecutiveFailures = 0
        return result
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
    let fileData: BarsFile | null = null
    try {
      if (tushareDeps !== undefined) {
        const file = join(cacheDir, 'tushare', 'bars', `${stock.fullCode}.json`)
        let data = await readJson<BarsFile>(file)
        const backfill = data?.startDate !== undefined && data.startDate > startDate
        if (!data || data.bars.length === 0 || backfill) {
          const bars = await tushareDailyForStock(stock.fullCode, startDate, tushareDeps, signal)
          data = { code: stock.fullCode, fetchedAt: today, startDate, bars: bars.map(toBarTuple) }
          await writeJson(file, data)
          fetchedThisRun.add(stock.fullCode)
        }
        fileData = data
      } else {
        fileData = await acquireFreeBars(stock)
      }
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
  if (klineSourceCounts.tencent !== undefined) {
    notes.push(`klines served by tencent for ${klineSourceCounts.tencent} stock(s) (eastmoney unavailable)`)
  }
  const klineFailures = skipped['kline-fetch-failed'] ?? 0
  if (klineFailures > Math.max(10, Math.floor(universe.length * 0.1))) {
    throw new Error(
      `aborting scan: kline fetch failed for ${klineFailures}/${universe.length} stocks — ` +
        `likely a systemic data-source outage. Fix connectivity or the token, then retry.`,
    )
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
 *
 * State advances only for dates that are (a) fully published (yesterday or
 * older — today's rows may be partial until after the close, so today is
 * refetched every scan until it becomes final) and (b) plausibly complete
 * (>= MIN_MARKET_ROWS rows; a suspiciously small response indicates a row-cap
 * truncation, in which case the date is merged but not finalized, so the next
 * scan retries it). Idempotent merges make retries safe.
 */
const MIN_MARKET_ROWS = 3000

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
  let lastMerged = state.lastDate
  for (const date of missing) {
    if (signal.aborted) throw abortError()
    const rows = await tushareDailyForDate(date, deps, signal)
    if (rows.length === 0) continue
    if (rows.length < MIN_MARKET_ROWS) {
      if (date < today) {
        host.log(
          'warn',
          `tushare daily(${date}) returned only ${rows.length} rows — possible row-cap truncation; merging but not finalizing this date`,
        )
      } else {
        host.log('info', `tushare daily(${date}) returned ${rows.length} rows (intraday partial); merging, retried next scan`)
      }
    }
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
      const lastBefore = existing?.bars[existing.bars.length - 1]?.[0] ?? ''
      const lastAfter = merged[merged.length - 1]?.[0] ?? ''
      if (existing === undefined || merged.length !== existing.bars.length || lastAfter !== lastBefore) {
        await writeJson(file, {
          code: fullCode,
          fetchedAt: today,
          startDate: existing?.startDate ?? startDate,
          bars: merged,
        })
        fetchedThisRun.add(fullCode)
      }
    }
    // Finalize only published, plausibly-complete dates strictly before today.
    if (date < today && rows.length >= MIN_MARKET_ROWS) lastMerged = date
  }
  if (lastMerged > state.lastDate) {
    await writeJson(stateFile, { lastDate: lastMerged } satisfies TushareState)
  }
}

/**
 * Eastmoney per-stock refresh for stale cache files: fetch from 10 days before
 * the cached tail, verify the overlapping bars still match (back-adjustment
 * drift check), then append. Returns null when the file needs no refresh;
 * the caller gates freshness via {@link isStale}.
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

/**
 * List distinct Shenwan level-1 industries (name → listed-stock count) from a
 * fresh tushare `stock_basic` call. Used by the a_share_list_industries tool.
 */
export async function listIndustries(
  host: ScreenerHost,
  config: ScreenerConfig,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<{ industries: { name: string; count: number }[] }> {
  const token = await host.resolveToken(config.tokenEnv)
  if (token === undefined || token === '') {
    throw new Error(
      `industry listing requires a Tushare token. Put it in the env var ${config.tokenEnv} ` +
        `(e.g. in the .env file of the directory you launch dsh from, or via dsh credentials).`,
    )
  }
  const stocks = await tushareListStocks({ token, limiter }, signal)
  const counts = new Map<string, number>()
  for (const stock of stocks) {
    const industry = (stock.industry ?? '').trim()
    if (industry === '') continue
    counts.set(industry, (counts.get(industry) ?? 0) + 1)
  }
  const industries = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { industries }
}

/** Exported for tests. */
export { mergeTuples, historyStartDate, isStale, isSt, expectedLastTradingDay, refreshTushareByDates }
