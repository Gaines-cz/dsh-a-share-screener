/**
 * Atomic filter `low_percentile`: the latest price ranks at or below a given
 * percentile of the recent window on the chained return index.
 * @module a-share-screener/filters/low-percentile
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const lowPercentileFilter: Filter = {
  id: 'low_percentile',
  description: 'The latest price ranks at or below `maxPercentile` of the recent `percentileWindowBars` window.',
  paramDocs: {
    percentileWindowBars: {
      type: 'number',
      default: 730,
      min: 120,
      max: 3000,
      integer: true,
      description: 'Bar count for the historical-low percentile window (~3 years).',
    },
    maxPercentile: {
      type: 'number',
      default: 0.15,
      min: 0.01,
      max: 1,
      description: 'Latest price must rank at or below this percentile of the window.',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const pw = Math.min(params.percentileWindowBars as number, ctx.bars.length)
    let below = 0
    for (let i = ctx.bars.length - pw; i < ctx.bars.length; i++) {
      if (ctx.idx[i]! <= ctx.current) below++
    }
    const percentile = below / pw
    const passed = percentile <= (params.maxPercentile as number)
    return { passed, evidence: { percentileInWindow: round(percentile, 4) } }
  },
}
