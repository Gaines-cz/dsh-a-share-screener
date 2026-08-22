/**
 * Derivation of the per-stock context shared by every filter in one pass: the
 * chained return index and the pre-computed limit-up days. Pure and
 * parameter-independent, so it runs once per stock regardless of predicate.
 * @module a-share-screener/engine/derive
 */
import { limitUpThreshold, type SeriesBar, type StockMeta } from '../types.js'
import { meanVolume } from './math.js'
import type { DerivedCtx, LimitUpDay } from './types.js'

export function derive(stock: StockMeta, bars: SeriesBar[]): DerivedCtx {
  const idx: number[] = new Array(bars.length)
  idx[0] = 1
  for (let i = 1; i < bars.length; i++) {
    const ret = bars[i]!.ret
    idx[i] = idx[i - 1]! * (1 + (ret === null ? 0 : ret))
  }

  const threshold = limitUpThreshold(stock.board, stock.name)
  const limitUpDays: LimitUpDay[] = []
  for (let i = 0; i < bars.length; i++) {
    const ret = bars[i]!.ret
    if (ret === null || ret < threshold) continue
    const prevAvg = meanVolume(bars, i - 5, i)
    limitUpDays.push({ index: i, date: bars[i]!.date, ret, surge: prevAvg <= 0 ? 0 : bars[i]!.volume / prevAvg })
  }

  const last = bars.length - 1
  return { stock, bars, idx, limitUpDays, last, current: idx[last]! }
}
