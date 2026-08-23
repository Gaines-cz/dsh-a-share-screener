/**
 * Atomic filter `bars_since_low`: the window minimum of the chained return
 * index lies at least `minBarsSinceLow` bars back (a base that has been
 * grinding, not a fresh knife), while the latest price is still near that low
 * (at most `maxPctAboveLow` above it).
 * @module a-share-screener/filters/bars-since-low
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const barsSinceLowFilter: Filter = {
  id: 'bars_since_low',
  description:
    'The minimum of the return index over the last `lowLookbackBars` bars lies at least `minBarsSinceLow` bars ' +
    'before the latest bar, and the latest price is at most `maxPctAboveLow` above that low.',
  paramDocs: {
    lowLookbackBars: {
      type: 'number',
      default: 500,
      min: 60,
      max: 3000,
      integer: true,
      description: 'Window in which to locate the minimum of the return index.',
    },
    minBarsSinceLow: {
      type: 'number',
      default: 40,
      min: 1,
      max: 1000,
      integer: true,
      description: 'Latest bar must be at least this many bars after the window low.',
    },
    maxPctAboveLow: {
      type: 'number',
      default: 0.5,
      min: 0.01,
      max: 5,
      description: 'Latest price may sit at most this fraction above the window low.',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    // Window clamped to available bars, mirroring low_percentile's convention
    // for young stocks.
    const lw = Math.min(params.lowLookbackBars as number, ctx.bars.length)
    let lowIdx = ctx.bars.length - lw
    for (let i = lowIdx; i < ctx.bars.length; i++) {
      if (ctx.idx[i]! < ctx.idx[lowIdx]!) lowIdx = i
    }
    const barsSinceLow = ctx.last - lowIdx
    const pctAboveLow = ctx.current / ctx.idx[lowIdx]! - 1
    const passed =
      barsSinceLow >= (params.minBarsSinceLow as number) && pctAboveLow <= (params.maxPctAboveLow as number)
    return {
      passed,
      evidence: { barsSinceLow, pctAboveLow: round(pctAboveLow, 4) },
    }
  },
}
