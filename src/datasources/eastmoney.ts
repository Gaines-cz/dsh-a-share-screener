/**
 * Eastmoney public-endpoint adapter (free fallback, no token).
 *
 * Uses the widely-used public quote endpoints (push2 clist for the stock
 * list, push2his kline for daily bars). These endpoints are undocumented, so
 * field drift is possible; failures surface loudly and the user can switch
 * back to tushare. Klines are fetched with `fqt=2` (back-adjusted): prices
 * never go negative and consecutive-close ratios are true daily returns.
 * @module a-share-screener/datasources/eastmoney
 */
import { fetchJson, RateLimiter } from '../http.js'
import { boardFromCode, exchangeSuffix, type Bar, type StockMeta } from '../types.js'

const LIST_URL = 'https://push2.eastmoney.com/api/qt/clist/get'
const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

/** All A-share boards (BSE included; universe filtering happens later). */
const FS_ALL = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'

interface ListEntry {
  f12?: string
  f13?: number
  f14?: string
  f26?: string | number
}

interface ListResponse {
  data?: { total?: number; diff?: ListEntry[] | Record<string, ListEntry> }
}

function normalizeDate(value: string | number | undefined): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8)
}

/** All listed A-share stocks, paged through the public clist endpoint. */
export async function eastmoneyListStocks(
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<StockMeta[]> {
  const out = new Map<string, StockMeta>()
  const pageSize = 100
  let page = 1
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const url =
      `${LIST_URL}?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12` +
      `&fs=${encodeURIComponent(FS_ALL)}&fields=f12,f13,f14,f26`
    const json = (await fetchJson({ url, limiter, signal })) as ListResponse
    const diff = json.data?.diff
    const entries = Array.isArray(diff) ? diff : Object.values(diff ?? {})
    if (entries.length === 0) break
    for (const entry of entries) {
      const code = String(entry.f12 ?? '')
      const board = boardFromCode(code)
      if (!board || !/^\d{6}$/.test(code)) continue
      out.set(code, {
        code,
        fullCode: `${code}.${exchangeSuffix(code)}`,
        name: String(entry.f14 ?? ''),
        board,
        listDate: normalizeDate(entry.f26),
      })
    }
    if (out.size >= (json.data?.total ?? 0) || entries.length < pageSize) break
    page++
  }
  return [...out.values()]
}

interface KlineResponse {
  data?: { klines?: string[] }
}

/**
 * Back-adjusted daily bars for one stock from `startDate` (YYYYMMDD) onward,
 * ascending. `preClose` is not published — the series pipeline chains
 * consecutive closes instead.
 */
export async function eastmoneyDailyBars(
  fullCode: string,
  startDate: string,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<Bar[]> {
  const [code, suffix] = fullCode.split('.')
  const secid = `${suffix === 'SH' ? 1 : 0}.${code}`
  const url =
    `${KLINE_URL}?secid=${secid}&klt=101&fqt=2&beg=${startDate}&end=20500101` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  const json = (await fetchJson({ url, limiter, signal })) as KlineResponse
  const bars: Bar[] = []
  for (const line of json.data?.klines ?? []) {
    // "YYYY-MM-DD,open,close,high,low,volume,amount,amplitude"
    const parts = line.split(',')
    if (parts.length < 6) continue
    const date = parts[0]!.replace(/\D/g, '')
    const open = Number(parts[1])
    const close = Number(parts[2])
    const high = Number(parts[3])
    const low = Number(parts[4])
    const volume = Number(parts[5])
    if (date.length !== 8 || ![open, close, high, low, volume].every(Number.isFinite)) continue
    bars.push({ date, open, high, low, close, volume, preClose: null })
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date))
}
