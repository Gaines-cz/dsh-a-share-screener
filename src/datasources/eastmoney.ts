/**
 * Eastmoney public-endpoint adapter (free, no token): the plugin's single data
 * source. Uses the widely-used public quote endpoints — push2 clist for the
 * stock list, push2his kline for daily bars. These endpoints are undocumented,
 * so field drift is possible; failures surface loudly.
 *
 * Klines are fetched with `fqt=2` (back-adjusted): prices never go negative and
 * consecutive-close ratios are true daily returns. Because back-adjustment
 * anchors can drift over time, the incremental {@link refreshBars} re-verifies
 * the cached overlap before appending.
 * @module a-share-screener/datasources/eastmoney
 */
import { fetchJson, RateLimiter } from '../http.js'
import { boardFromCode, dateMinusDays, exchangeSuffix, type Bar, type StockMeta } from '../types.js'
import type { DataSource } from './types.js'

const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

/**
 * Realtime quote hosts occasionally reject datacenter/local-network clients at
 * the TLS layer while the delayed-quote host keeps serving the same clist API
 * (delayed snapshots are irrelevant for listing metadata), so list requests
 * fail over between hosts. The first working host is remembered for the
 * process lifetime.
 */
const LIST_HOSTS = ['push2.eastmoney.com', 'push2delay.eastmoney.com'] as const
let workingListHost: string | undefined

interface ListEntry {
  f12?: string
  f13?: number
  f14?: string
  f26?: string | number
  /** Industry-board name (行业板块), e.g. "银行". */
  f100?: string
  /** Total market cap in yuan. */
  f20?: number
  /** Free-float market cap in yuan. */
  f21?: number
}

interface ListResponse {
  data?: { total?: number; diff?: ListEntry[] | Record<string, ListEntry> }
}

interface KlineResponse {
  data?: { klines?: string[] }
}

async function fetchListPage(
  page: number,
  pageSize: number,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<ListResponse> {
  const hosts = workingListHost ? [workingListHost, ...LIST_HOSTS.filter((h) => h !== workingListHost)] : [...LIST_HOSTS]
  let lastError: unknown
  for (const host of hosts) {
    try {
      const url =
        `https://${host}/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12` +
        `&fs=${encodeURIComponent(FS_ALL)}&fields=f12,f13,f14,f26,f100,f20,f21`
      const json = (await fetchJson({ url, limiter, signal, retries: 1 })) as ListResponse
      workingListHost = host
      return json
    } catch (err) {
      if (signal.aborted) throw err
      // The remembered host may have died since; forget it so the next call
      // re-probes every host instead of failing the first attempt forever.
      if (host === workingListHost) workingListHost = undefined
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** All A-share boards (BSE included; universe filtering happens later). */
const FS_ALL = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'
/** Defensive page cap: the endpoint pages ~56 pages today; never loop unbounded. */
const MAX_LIST_PAGES = 300

function normalizeDate(value: string | number | undefined): string {
  return String(value ?? '').replace(/\D/g, '').slice(0, 8)
}

/** Normalize an industry-board name; empty/placeholder values become undefined. */
function normalizeIndustry(value: string | undefined): string | undefined {
  const name = String(value ?? '').trim()
  return name === '' || name === '-' ? undefined : name
}

/** Normalize a market-cap field; non-finite/non-positive values become undefined. */
function normalizeCap(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Merge two bar lists, deduplicating by date (incoming wins), ascending. */
function mergeBars(existing: Bar[], incoming: Bar[]): Bar[] {
  const byDate = new Map<string, Bar>()
  for (const bar of existing) byDate.set(bar.date, bar)
  for (const bar of incoming) byDate.set(bar.date, bar)
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Fetch the full A-share stock list from the Eastmoney clist endpoint (all
 * boards, BSE included; universe filtering happens later). Also serves the
 * sina/tencent adapters, which have no listing-date-bearing list endpoint of
 * their own.
 */
export async function fetchEastmoneyStockList(limiter: RateLimiter, signal: AbortSignal): Promise<StockMeta[]> {
  const out = new Map<string, StockMeta>()
  const pageSize = 100
  let page = 1
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const json = await fetchListPage(page, pageSize, limiter, signal)
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
        industry: normalizeIndustry(entry.f100),
        totalMarketCapYuan: normalizeCap(entry.f20),
        floatMarketCapYuan: normalizeCap(entry.f21),
      })
    }
    const total = json.data?.total
    // Never rely on `total`: when it is missing or stale the universe would be
    // silently truncated to the first page. Stop only on a short page or the
    // defensive page cap, and fall back to `total` only when it is plausibly
    // larger than what we have collected.
    if (entries.length < pageSize) break
    if (total !== undefined && total > 0 && out.size >= total) break
    if (page >= MAX_LIST_PAGES) break
    page++
  }
  return [...out.values()]
}

/**
 * Build the Eastmoney data source, binding it to the shared rate limiter so
 * callers never pass request-budget plumbing around.
 */
export function createEastmoneyDataSource(limiter: RateLimiter): DataSource {
  async function listStocks(signal: AbortSignal): Promise<StockMeta[]> {
    return fetchEastmoneyStockList(limiter, signal)
  }

  /**
   * Back-adjusted daily bars for one stock from `startDate` (YYYYMMDD) onward,
   * ascending. `preClose` is not published — the series pipeline chains
   * consecutive closes instead.
   */
  async function dailyBars(fullCode: string, startDate: string, signal: AbortSignal): Promise<Bar[]> {
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
      // Traded value in yuan; absent in short rows or non-finite in bad ones.
      const amount = Number(parts[6])
      // Prices must be strictly positive: a zero close would send the chained
      // return index to 0 and poison every ratio-based condition with NaN.
      if (date.length !== 8 || ![open, close, high, low].every((v) => Number.isFinite(v) && v > 0)) continue
      if (!Number.isFinite(volume)) continue
      bars.push({ date, open, high, low, close, volume, amount: Number.isFinite(amount) ? amount : null, preClose: null })
    }
    return bars.sort((a, b) => a.date.localeCompare(b.date))
  }

  /**
   * Incremental refresh for a stale cache: fetch from 10 days before the cached
   * tail, verify the overlapping bars still match (back-adjustment drift
   * check), then append. Returns null when the file needs no change.
   */
  async function refreshBars(
    fullCode: string,
    startDate: string,
    cached: Bar[],
    signal: AbortSignal,
  ): Promise<Bar[] | null> {
    const last = cached[cached.length - 1]
    if (!last) return null
    const fetchFrom = dateMinusDays(last.date, 10)
    const fresh = await dailyBars(fullCode, fetchFrom, signal)
    if (fresh.length === 0) return null
    const cachedByDate = new Map(cached.map((bar) => [bar.date, bar]))
    let overlap = 0
    for (const bar of fresh) {
      const prev = cachedByDate.get(bar.date)
      if (!prev) continue
      overlap++
      if (prev.close > 0 && Math.abs(bar.close / prev.close - 1) > 0.001) {
        // Adjusted factors drifted: refetch the whole window.
        return dailyBars(fullCode, startDate, signal)
      }
    }
    if (overlap === 0 && fresh[0] !== undefined && fresh[0].date <= last.date) {
      // Unexpected gap: refetch the full window rather than risk a broken chain.
      return dailyBars(fullCode, startDate, signal)
    }
    return mergeBars(cached, fresh)
  }

  return { id: 'eastmoney', capabilities: { industry: true, marketCap: true, amount: true }, listStocks, dailyBars, refreshBars }
}