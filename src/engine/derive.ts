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
  // Guard against a degenerate empty series: callers reject it via canEvaluate,
  // but derive is a public engine entry that would otherwise return last = -1
  // and current = undefined.
  if (bars.length === 0) throw new Error('derive: cannot derive context from an empty bar series')
  const idx: number[] = new Array(bars.length)
  idx[0] = 1
  for (let i = 1; i < bars.length; i++) {
    const ret = bars[i]!.ret
    // A single corrupt bar with ret <= -1 would drive the chained index to 0
    // or negative and poison every downstream ratio (drawdown, percentile,
    // MA spreads). Clamp to a tiny positive floor: a no-op for any valid
    // series (daily returns are always > -1 for listed A-shares), but it keeps
    // the index a strictly positive chain even on bad data.
    idx[i] = idx[i - 1]! * Math.max(1e-9, 1 + (ret === null ? 0 : ret))
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
