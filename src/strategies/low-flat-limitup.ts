/**
 * Strategy `low_flat_limit_up`: historical low + flat base + volume-heavy
 * limit-up within roughly six months followed by a pullback on shrinking
 * volume.
 *
 * The strategy is *composed* from five independent atomic filters (see
 * `src/filters/`) via {@link composeStrategy}: deep_drawdown AND low_percentile
 * AND flat_base AND volume_limit_up AND cooldown_pullback. Each filter is
 * reusable on its own and combinable with others into new strategies without
 * touching any screening code.
 *
 * All price-level conditions run on a chained return index (not raw closes),
 * so ex-rights events such as splits and dividends cannot fake a crash or a
 * bottom. Each condition's threshold is a validated, overridable parameter.
 * @module a-share-screener/strategies/low-flat-limitup
 */
import { composeStrategy } from '../engine/compose.js'
import { createFilterRegistry } from '../filters/index.js'
import type { Strategy, StrategyScreenInput, StrategyParams } from './registry.js'

/** Compose the five shipped atomic filters into the historical-low + flat-base + limit-up strategy. */
export const lowFlatLimitUpStrategy: Strategy = composeStrategy({
  id: 'low_flat_limit_up',
  description:
    'Historical low + flat base + faded volume-heavy limit-up: the stock sits deep below its window high ' +
    '(default >= 65% drawdown) and at the bottom of its recent price distribution (default <= 15th percentile ' +
    'of the last ~3 years), the last month is a flat, MA-converged base, and within the last ~6 months there was ' +
    'a volume-heavy limit-up day (default >= 2x the prior 5-day average volume) that pulled back below its ' +
    'closing price while volume cooled off (recent average <= 40% of the limit-up day). Read the evidence fields ' +
    'as quantified facts, not trading signals.',
  predicate: {
    kind: 'and',
    children: [
      { kind: 'filter', filter: 'deep_drawdown' },
      { kind: 'filter', filter: 'low_percentile' },
      { kind: 'filter', filter: 'flat_base' },
      { kind: 'filter', filter: 'volume_limit_up' },
      { kind: 'filter', filter: 'cooldown_pullback' },
    ],
  },
  filters: createFilterRegistry(),
  extraParamDocs: {
    minBars: {
      type: 'number',
      default: 240,
      min: 60,
      max: 3000,
      integer: true,
      description: 'Minimum bar count to evaluate a stock at all.',
    },
  },
  canEvaluate(input: StrategyScreenInput, params: StrategyParams): boolean {
    // A short series must stay *unevaluated* (null) rather than degrade to a
    // failed-gate diagnosis: the flat-base window (`bars.length > flatWindowBars`)
    // and the MA60 average (`bars.length >= 60`) both need enough bars.
    const flatWindow = params.flatWindowBars as number
    return input.bars.length >= Math.max(60, params.minBars as number, flatWindow + 1)
  },
})
