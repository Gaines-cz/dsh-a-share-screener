/**
 * Tushare Pro adapter (primary source, needs a user token).
 *
 * Pull strategy: per-stock `daily` for cold history, per-trade-date `daily`
 * bulk rows for incremental refresh (one call covers the whole market for one
 * day), `trade_cal` for the exact trading calendar. Daily rows carry the
 * ex-rights-adjusted `pre_close`, so chained returns stay correct across
 * corporate actions without needing paid adjust-factor interfaces.
 * @module a-share-screener/datasources/tushare
 */
import { fetchJson, RateLimiter, sleep } from '../http.js'
import { boardFromCode, type Bar, type StockMeta, toFullCode } from '../types.js'

const ENDPOINT = 'https://api.tushare.pro'

/** Credentials the adapter needs. */
export interface TushareDeps {
  token: string
  limiter: RateLimiter
}

interface TushareResponse {
  code: number
  msg?: string
  data?: { fields: string[]; items: unknown[][] }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '' && value !== 'None') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Call one Tushare Pro API, retrying rate-limit rejections with backoff. */
async function callApi(
  apiName: string,
  params: Record<string, unknown>,
  fields: string[],
  deps: TushareDeps,
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const body = JSON.stringify({
    api_name: apiName,
    token: deps.token,
    params,
    fields: fields.join(','),
  })
  let lastRateError: Error | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new Error('aborted')
    const json = (await fetchJson({
      url: ENDPOINT,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      limiter: deps.limiter,
      signal,
    })) as TushareResponse
    if (json.code === 0 && json.data) {
      const index = new Map<string, number>()
      json.data.fields.forEach((f, i) => index.set(f, i))
      return json.data.items.map((row) => {
        const obj: Record<string, unknown> = {}
        for (const [field, i] of index) obj[field] = row[i]
        return obj
      })
    }
    const msg = json.msg ?? 'unknown error'
    const rateLimited = /每分钟|频繁|频率|too many|rate/i.test(msg)
    if (!rateLimited) {
      throw new Error(`tushare ${apiName} failed (code ${json.code}): ${msg}`)
    }
    lastRateError = new Error(`tushare ${apiName} rate-limited: ${msg}`)
    await sleep(1_000 * 2 ** attempt, signal)
  }
  throw lastRateError ?? new Error(`tushare ${apiName} failed`)
}

/** All currently listed A-share stocks. */
export async function tushareListStocks(deps: TushareDeps, signal: AbortSignal): Promise<StockMeta[]> {
  const rows = await callApi(
    'stock_basic',
    { list_status: 'L' },
    ['ts_code', 'name', 'list_date'],
    deps,
    signal,
  )
  const out: StockMeta[] = []
  for (const row of rows) {
    const fullCode = String(row.ts_code ?? '')
    const code = fullCode.split('.')[0] ?? ''
    const board = boardFromCode(code)
    if (!board) continue
    out.push({
      code,
      fullCode,
      name: String(row.name ?? ''),
      board,
      listDate: String(row.list_date ?? ''),
    })
  }
  return out
}

/** Open trade dates (YYYYMMDD) on [startDate, endDate], SSE calendar. */
export async function tushareTradeCalendar(
  startDate: string,
  endDate: string,
  deps: TushareDeps,
  signal: AbortSignal,
): Promise<string[]> {
  const rows = await callApi(
    'trade_cal',
    { exchange: 'SSE', start_date: startDate, end_date: endDate, is_open: '1' },
    ['cal_date'],
    deps,
    signal,
  )
  return rows.map((row) => String(row.cal_date ?? '')).filter(Boolean).sort()
}

interface DailyRow {
  fullCode: string
  bar: Bar
}

function mapDailyRow(row: Record<string, unknown>): DailyRow | null {
  const date = String(row.trade_date ?? '')
  const close = num(row.close)
  const volume = num(row.vol)
  const open = num(row.open)
  const high = num(row.high)
  const low = num(row.low)
  const preClose = num(row.pre_close)
  if (
    date.length !== 8 ||
    close === null ||
    volume === null ||
    open === null ||
    high === null ||
    low === null
  ) {
    return null
  }
  return {
    fullCode: String(row.ts_code ?? ''),
    bar: { date, open, high, low, close, volume, preClose },
  }
}

/**
 * Daily bars for one stock from `startDate` (YYYYMMDD) to the latest available
 * trade date, ascending. One API call.
 */
export async function tushareDailyForStock(
  fullCode: string,
  startDate: string,
  deps: TushareDeps,
  signal: AbortSignal,
): Promise<Bar[]> {
  const rows = await callApi(
    'daily',
    { ts_code: fullCode, start_date: startDate },
    ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol'],
    deps,
    signal,
  )
  return rows
    .map(mapDailyRow)
    .filter((r): r is DailyRow => r !== null && r.fullCode === fullCode)
    .map((r) => r.bar)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Daily bars for every stock that traded on `date` (YYYYMMDD). One API call
 * covers the whole market, which is what makes daily incremental refresh cheap.
 */
export async function tushareDailyForDate(
  date: string,
  deps: TushareDeps,
  signal: AbortSignal,
): Promise<DailyRow[]> {
  const rows = await callApi(
    'daily',
    { trade_date: date },
    ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol'],
    deps,
    signal,
  )
  return rows.map(mapDailyRow).filter((r): r is DailyRow => r !== null)
}
