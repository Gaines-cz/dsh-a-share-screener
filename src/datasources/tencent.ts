/**
 * Tencent quote-center adapter (free fallback, no token): 后复权 (hfq) daily
 * klines via the fqkline endpoint, at most 640 rows per request so long
 * windows page backward. Back-adjusted anchors differ from Sina/Eastmoney, so
 * series must never mix sources — the screener keeps per-source cache
 * directories for exactly this reason.
 *
 * The `web.ifzq.gtimg.cn` host sometimes answers with a JS verification page
 * (rate limiting / anti-bot), so the adapter fails over between hosts and
 * re-probes on failure. Like Sina, Tencent has no listing-date-bearing list
 * endpoint, so the stock list comes from the Eastmoney clist endpoint.
 * @module a-share-screener/datasources/tencent
 */
import { fetchJson, RateLimiter } from '../http.js'
import type { Bar, StockMeta } from '../types.js'
import { fetchEastmoneyStockList } from './eastmoney.js'
import type { DataSource } from './types.js'

const KLINE_HOSTS = ['ifzq.gtimg.cn', 'proxy.finance.qq.com/ifzqgtimg'] as const
const KLINE_PATH = '/appstock/app/fqkline/get'
const PAGE_ROWS = 640
const MAX_PAGES = 8
let workingHost: string | undefined

interface KlineResponse {
  code: number
  data?: Record<string, Record<string, unknown>>
}

function tencentSymbol(fullCode: string): string {
  const [code, suffix] = fullCode.split('.')
  const prefix = suffix === 'SH' ? 'sh' : suffix === 'BJ' ? 'bj' : 'sz'
  return `${prefix}${code}`
}

function parseRows(rows: unknown[]): Bar[] {
  const bars: Bar[] = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue
    const date = String(row[0]).replace(/\D/g, '')
    // Tencent row order: [date, open, close, high, low, volume, extra?]
    const open = Number(row[1])
    const close = Number(row[2])
    const high = Number(row[3])
    const low = Number(row[4])
    const volume = Number(row[5])
    if (date.length !== 8 || ![open, close, high, low].every((v) => Number.isFinite(v) && v > 0)) continue
    if (!Number.isFinite(volume) || volume < 0) continue
    bars.push({ date, open, high, low, close, volume, preClose: null })
  }
  return bars
}

/** One kline request through the failing-over host list. */
async function fetchKlinePage(
  symbol: string,
  end: string,
  pageRows: number,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<unknown[]> {
  const hosts = workingHost ? [workingHost, ...KLINE_HOSTS.filter((h) => h !== workingHost)] : [...KLINE_HOSTS]
  let lastError: unknown
  for (const host of hosts) {
    try {
      const url = `https://${host}${KLINE_PATH}?param=${encodeURIComponent(`${symbol},day,1900-01-01,${end},${pageRows},hfq`)}`
      const json = (await fetchJson({ url, limiter, signal, retries: 1 })) as KlineResponse
      workingHost = host
      const payload = json.data?.[symbol]
      const rows = (payload?.hfqday ?? payload?.day) as unknown[] | undefined
      if (!Array.isArray(rows)) throw new Error(`tencent returned no kline rows for ${symbol}`)
      return rows
    } catch (err) {
      if (signal.aborted) throw err
      if (host === workingHost) workingHost = undefined
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Build the Tencent data source, bound to the shared rate limiter. Bars are
 * 后复权 daily; use as a fallback only (reported closes are not market prices).
 */
export function createTencentDataSource(limiter: RateLimiter): DataSource {
  async function listStocks(signal: AbortSignal): Promise<StockMeta[]> {
    return fetchEastmoneyStockList(limiter, signal)
  }

  async function dailyBars(fullCode: string, startDate: string, signal: AbortSignal): Promise<Bar[]> {
    const symbol = tencentSymbol(fullCode)
    const byDate = new Map<string, Bar>()
    // Page window end, formatted YYYY-MM-DD; moves backward until coverage.
    let end = '2099-12-31'
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchKlinePage(symbol, end, PAGE_ROWS, limiter, signal)
      const pageBars = parseRows(rows)
      for (const bar of pageBars) byDate.set(bar.date, bar)
      const earliest = pageBars[0]?.date
      if (pageBars.length < PAGE_ROWS || earliest === undefined || earliest <= startDate) break
      const year = Number(earliest.slice(0, 4))
      const month = Number(earliest.slice(4, 6))
      const day = Number(earliest.slice(6, 8))
      const prev = new Date(Date.UTC(year, month - 1, day - 1))
      end = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`
    }
    return [...byDate.values()].filter((bar) => bar.date >= startDate).sort((a, b) => a.date.localeCompare(b.date))
  }

  return { id: 'tencent', capabilities: { industry: false }, listStocks, dailyBars }
}

/** Export for tests. */
export { tencentSymbol, parseRows }
