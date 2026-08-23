/**
 * Shared domain types for the A-share screener: board classification, stock
 * metadata, daily bars, and the strategy-facing bar series.
 * @module a-share-screener/types
 */

/** Exchange board, deciding the daily price-limit rule. */
export type Board = 'main' | 'chinext' | 'star' | 'bse'

/**
 * Daily-return threshold for a close-at-limit-up day, by board. Exchange price
 * rounding keeps achieved limit-up percentages within roughly ±0.2 points of
 * the nominal 10/20/30%, so these thresholds catch every true limit-up close.
 */
export const LIMIT_UP_THRESHOLD: Readonly<Record<Board, number>> = {
  main: 0.098,
  chinext: 0.198,
  star: 0.198,
  bse: 0.298,
}

/**
 * Landing threshold for a close-at-limit-up day. Main-board risk-warning names
 * trade under the ±5% band (limit-up ≈ +5%, ~+4.8% after exchange rounding), so
 * they get their own threshold; every other board/name uses {@link LIMIT_UP_THRESHOLD}.
 */
export function limitUpThreshold(board: Board, name: string): number {
  if (board === 'main' && name.includes('ST')) return 0.048
  return LIMIT_UP_THRESHOLD[board]
}

/** One listed stock. `code` is the 6-digit symbol, `fullCode` the exchange-suffixed form data APIs use. */
export interface StockMeta {
  code: string
  fullCode: string
  name: string
  board: Board
  /** Listing date, YYYYMMDD. */
  listDate: string
  /**
   * Industry/sector classification. Only populated by sources whose
   * `capabilities.industry` is true (extension point for future vendors).
   */
  industry?: string
  /**
   * Total market capitalization in CNY yuan (list-time snapshot). Only
   * populated by sources whose `capabilities.marketCap` is true.
   */
  totalMarketCapYuan?: number
  /**
   * Free-float market capitalization in CNY yuan (list-time snapshot). Only
   * populated by sources whose `capabilities.marketCap` is true.
   */
  floatMarketCapYuan?: number
}

/**
 * One daily bar. Prices are in the source's native units (raw or
 * back-adjusted CNY, depending on the vendor) — never mix bars from different
 * sources in one series. Volume is in lots (手). Price-level conditions must
 * use the chained return index, not raw closes, so ex-rights events stay correct.
 */
export interface Bar {
  /** Trade date, YYYYMMDD. */
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  /**
   * Traded value of the bar in CNY yuan. Only published by sources whose
   * `capabilities.amount` is true (e.g. Eastmoney klines); null/undefined
   * otherwise. Filters that need it declare `requires.amount` and refuse to
   * run on sources without the capability instead of approximating.
   */
  amount?: number | null
  /**
   * Previous close as published by the source. When present and positive it is
   * the ex-rights-adjusted previous close, so `close / preClose - 1` is the
   * true daily return even across corporate actions. Null when the source does
   * not publish one (e.g. Eastmoney klines).
   */
  preClose: number | null
}

/**
 * Cache tuple form of {@link Bar}: [date, open, high, low, close, volume,
 * preClose, amount?]. The 8th element is optional so caches written before
 * the amount field existed (7-column tuples) still parse — their amount is
 * simply undefined.
 */
export type BarTuple = [string, number, number, number, number, number, number | null, (number | null)?]

/** Serialize a bar to its cache tuple. */
export function toBarTuple(bar: Bar): BarTuple {
  return [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.preClose, bar.amount ?? null]
}

/** Parse a cache tuple back into a bar. */
export function fromBarTuple(t: BarTuple): Bar {
  return {
    date: t[0],
    open: t[1],
    high: t[2],
    low: t[3],
    close: t[4],
    volume: t[5],
    preClose: t[6],
    amount: t[7] ?? null,
  }
}

/** Strategy-facing bar: what every strategy may rely on. */
export interface SeriesBar {
  date: string
  close: number
  volume: number
  /**
   * Traded value in CNY yuan when the source publishes it, else null. Filters
   * that need it declare `requires.amount`; strategies wiring them must run on
   * an amount-capable source (the screener enforces this loudly).
   */
  amount?: number | null
  /**
   * True daily return of this bar (fraction, e.g. 0.098). Null only for the
   * first bar of a series when the source publishes no previous close.
   */
  ret: number | null
}

/**
 * Convert source bars into the strategy series. The daily return prefers the
 * published `preClose` (correct across ex-rights days); otherwise it falls
 * back to chaining consecutive closes within the series.
 */
export function barsToSeries(bars: Bar[]): SeriesBar[] {
  const out: SeriesBar[] = []
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!
    let ret: number | null = null
    if (bar.preClose !== null && bar.preClose > 0) {
      ret = bar.close / bar.preClose - 1
    } else if (i > 0) {
      const prev = bars[i - 1]!
      if (prev.close > 0) ret = bar.close / prev.close - 1
    }
    out.push({ date: bar.date, close: bar.close, volume: bar.volume, amount: bar.amount ?? null, ret })
  }
  return out
}

/** Classify a 6-digit A-share symbol into its board. Undefined for unknown patterns. */
export function boardFromCode(code: string): Board | undefined {
  if (code.startsWith('68')) return 'star'
  if (code.startsWith('6')) return 'main'
  if (code.startsWith('00')) return 'main'
  if (code.startsWith('30')) return 'chinext'
  if (/^(4|8|92)/.test(code)) return 'bse'
  return undefined
}

/** Exchange suffix (SH/SZ/BJ) for a 6-digit symbol. */
export function exchangeSuffix(code: string): 'SH' | 'SZ' | 'BJ' {
  if (code.startsWith('6')) return 'SH'
  if (/^(4|8|92)/.test(code)) return 'BJ'
  return 'SZ'
}

/** Build the exchange-suffixed full code from a 6-digit symbol. */
export function toFullCode(code: string): string {
  return `${code}.${exchangeSuffix(code)}`
}

/** Local YYYYMMDD of a Date. */
export function ymd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** YYYYMMDD minus `days` calendar days. */
export function dateMinusDays(ymdStr: string, days: number): string {
  const year = Number(ymdStr.slice(0, 4))
  const month = Number(ymdStr.slice(4, 6))
  const day = Number(ymdStr.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() - days)
  return ymd(date)
}
