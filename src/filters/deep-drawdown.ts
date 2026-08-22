/**
 * Atomic filter `deep_drawdown`: the latest price sits deep below the window
 * high (measured on the chained return index, so ex-rights gaps never fake a
 * crash). Passes when the drawdown meets the minimum threshold.
 * @module a-share-screener/filters/deep-drawdown
 */
import { maxOf, round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const deepDrawdownFilter: Filter = {
  id: 'deep_drawdown',
  description:
    'The stock trades at least `minDrawdownFromHigh` below its window high on the chained return index.',
  paramDocs: {
    minDrawdownFromHigh: {
      type: 'number',
      default: 0.65,
      min: 0.1,
      max: 0.99,
      description: 'Minimum drawdown of the latest price from the window high (fraction).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const high = maxOf(ctx.idx)
    const drawdown = 1 - ctx.current / high
    const passed = drawdown >= (params.minDrawdownFromHigh as number)
    return { passed, evidence: { drawdownFromHigh: round(drawdown, 4) } }
  },
}
