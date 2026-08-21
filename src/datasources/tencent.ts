/**
 * Tencent quote-center adapter (free kline fallback, no token).
 *
 * `web.ifzq.gtimg.cn/appstock/app/fqkline/get` serves back-adjusted (`hfq`)
 * daily klines, at most 640 rows per request, so long windows page backward
 * until the requested start is covered. Rows are `[date, open, close, high,
 * low, volume, extra?]` where `extra` is an optional dividend annotation
 * object, ignored here. Back-adjusted prices anchor differently from
 * eastmoney's, so series must never mix sources — the screener keeps
 * per-source cache directories for exactly this reason.
 * @module a-share-screener/datasources/tencent
 */
import { fetchJson, RateLimiter } from '../http.js'
import type { Bar } from '../types.js'

const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const PAGE_ROWS = 640
const MAX_PAGES = 8

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
    const open = Number(row[1])
    const close = Number(row[2])
    const high = Number(row[3])
    const low = Number(row[4])
    const volume = Number(row[5])
    if (date.length !== 8 || ![open, close, high, low, volume].every(Number.isFinite)) continue
    bars.push({ date, open, high, low, close, volume, preClose: null })
  }
  return bars
}

/**
 * Back-adjusted daily bars for one stock from `startDate` (YYYYMMDD) to the
 * latest trade date, ascending, paged backward at 640 rows per request.
 */
export async function tencentDailyBars(
  fullCode: string,
  startDate: string,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<Bar[]> {
  const symbol = tencentSymbol(fullCode)
  const byDate = new Map<string, Bar>()
  // Page window end, formatted YYYY-MM-DD; moves backward until coverage.
  let end = '2099-12-31'
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal.aborted) throw new Error('aborted')
    const url = `${KLINE_URL}?param=${encodeURIComponent(`${symbol},day,1900-01-01,${end},${PAGE_ROWS},hfq`)}`
    const json = (await fetchJson({ url, limiter, signal, retries: 1 })) as KlineResponse
    const payload = json.data?.[symbol]
    const rows = (payload?.hfqday ?? payload?.day) as unknown[] | undefined
    const bars = Array.isArray(rows) ? parseRows(rows) : []
    for (const bar of bars) byDate.set(bar.date, bar)
    const earliest = bars[0]?.date
    if (bars.length < PAGE_ROWS || earliest === undefined || earliest <= startDate) break
    const year = Number(earliest.slice(0, 4))
    const month = Number(earliest.slice(4, 6))
    const day = Number(earliest.slice(6, 8))
    const prev = new Date(Date.UTC(year, month - 1, day - 1))
    end = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`
  }
  const bars = [...byDate.values()].filter((bar) => bar.date >= startDate)
  return bars.sort((a, b) => a.date.localeCompare(b.date))
}
