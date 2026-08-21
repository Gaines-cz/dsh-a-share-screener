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

/** One listed stock. `code` is the 6-digit symbol, `fullCode` the exchange-suffixed form data APIs use. */
export interface StockMeta {
  code: string
  fullCode: string
  name: string
  board: Board
  /** Listing date, YYYYMMDD. */
  listDate: string
}

/**
 * One daily bar. Prices are in the source's native units (tushare: raw CNY;
 * eastmoney: adjusted CNY) — never mix bars from different sources in one
 * series. Volume is in lots (手). Price-level conditions must use the chained
 * return index, not raw closes, so ex-rights events stay correct.
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
   * Previous close as published by the source. Tushare publishes the
   * ex-rights-adjusted previous close, so `close / preClose - 1` is the true
   * daily return even across corporate actions. Null when the source does not
   * publish one (eastmoney klines).
   */
  preClose: number | null
}

/** Cache tuple form of {@link Bar}: [date, open, high, low, close, volume, preClose]. */
export type BarTuple = [string, number, number, number, number, number, number | null]

/** Serialize a bar to its cache tuple. */
export function toBarTuple(bar: Bar): BarTuple {
  return [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.preClose]
}

/** Parse a cache tuple back into a bar. */
export function fromBarTuple(t: BarTuple): Bar {
  return { date: t[0], open: t[1], high: t[2], low: t[3], close: t[4], volume: t[5], preClose: t[6] }
}

/** Strategy-facing bar: what every strategy may rely on. */
export interface SeriesBar {
  date: string
  close: number
  volume: number
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
    out.push({ date: bar.date, close: bar.close, volume: bar.volume, ret })
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
