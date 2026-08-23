/**
 * Sina Finance public-endpoint adapter (free, no token): 前复权 daily klines
 * via the CN_MarketDataService JSONP endpoint. One request returns the latest
 * N bars (max 1023, roughly four trading years), so a stock's whole window is
 * a single call. Prices are 前复权 (latest close ≈ market price).
 *
 * Volume unit: Sina reports shares (股); the adapter converts to lots (手,
 * volume / 100) to match the domain convention and the tencent source. Verified
 * against real responses on 600519 (2026-08-19..21): sina volume/100 equals
 * tencent's 手-denominated volume exactly.
 *
 * Sina publishes no listing-date-bearing full-market list endpoint, so the
 * stock list is served by the Eastmoney clist endpoint via
 * {@link fetchEastmoneyStockList} — same metadata the eastmoney adapter uses.
 * @module a-share-screener/datasources/sina
 */
import { fetchText, RateLimiter } from '../http.js'
import type { Bar, StockMeta } from '../types.js'
import { fetchEastmoneyStockList } from './eastmoney.js'
import type { DataSource } from './types.js'

const KLINE_URL = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData'
/** Largest bar count Sina returns per request. */
const MAX_BARS = 1023

interface SinaBarRow {
  day?: string
  open?: string | number
  high?: string | number
  low?: string | number
  close?: string | number
  volume?: string | number
}

function sinaSymbol(fullCode: string): string {
  const [code, suffix] = fullCode.split('.')
  const prefix = suffix === 'SH' ? 'sh' : suffix === 'BJ' ? 'bj' : 'sz'
  return `${prefix}${code}`
}

/**
 * Strip the JSONP wrapper (`/*<script>...*\/\nvar _=([...])`) and parse the
 * payload array. Throws when the shape is unexpected (blocked/redirect page).
 */
function parseJsonp(text: string): SinaBarRow[] {
  const marker = 'var _=('
  const start = text.indexOf(marker)
  if (start === -1) throw new Error(`unexpected sina response (no JSONP payload): ${text.slice(0, 80)}`)
  const open = start + marker.length // index just after '('
  const close = text.lastIndexOf(')')
  if (close <= open) throw new Error(`unexpected sina response (unbalanced payload): ${text.slice(0, 80)}`)
  const parsed: unknown = JSON.parse(text.slice(open, close))
  if (!Array.isArray(parsed)) throw new Error(`unexpected sina response (payload not an array): ${text.slice(0, 80)}`)
  return parsed as SinaBarRow[]
}

/**
 * Build the Sina data source, bound to the shared rate limiter. Bars are
 * 前复权 daily; volume is converted from shares to lots (手) to match the
 * domain convention.
 */
export function createSinaDataSource(limiter: RateLimiter): DataSource {
  async function listStocks(signal: AbortSignal): Promise<StockMeta[]> {
    return fetchEastmoneyStockList(limiter, signal)
  }

  async function dailyBars(fullCode: string, startDate: string, signal: AbortSignal): Promise<Bar[]> {
    const url = `${KLINE_URL}?symbol=${sinaSymbol(fullCode)}&scale=240&ma=no&datalen=${MAX_BARS}`
    const text = await fetchText({ url, limiter, signal })
    const bars: Bar[] = []
    for (const row of parseJsonp(text)) {
      const date = String(row.day ?? '').replace(/\D/g, '')
      const open = Number(row.open)
      const close = Number(row.close)
      const high = Number(row.high)
      const low = Number(row.low)
      const volume = Number(row.volume)
      if (date.length !== 8 || ![open, close, high, low].every((v) => Number.isFinite(v) && v > 0)) continue
      if (!Number.isFinite(volume) || volume < 0) continue
      bars.push({ date, open, high, low, close, volume: volume / 100, preClose: null })
    }
    return bars.filter((bar) => bar.date >= startDate).sort((a, b) => a.date.localeCompare(b.date))
  }

  // The stock list is served by the Eastmoney clist endpoint, so the list-level
  // capabilities (industry, marketCap) hold; per-bar amount is NOT published.
  return { id: 'sina', capabilities: { industry: true, marketCap: true, amount: false }, listStocks, dailyBars }
}

/** Export for tests. */
export { sinaSymbol, parseJsonp }
