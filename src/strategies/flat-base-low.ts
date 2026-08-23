/**
 * Strategy `flat_base_low`: bottom + flat base — the stock sits at the bottom
 * of its recent price distribution while the last month consolidates flat with
 * converged moving averages. No limit-up shape is required.
 *
 * The strategy is *composed* from two atomic filters (see `src/filters/`) via
 * {@link composeStrategy}: flat_base AND low_percentile. Pair it with the
 * `minListDays` / `maxListDays` universe filters to screen, e.g., stocks
 * listed 1–4 years.
 * @module a-share-screener/strategies/flat-base-low
 */
import { composeStrategy } from '../engine/compose.js'
import { createFilterRegistry } from '../filters/index.js'
import type { Strategy, StrategyParams, StrategyScreenInput } from './registry.js'

/** Compose the flat-base and low-percentile atomic filters into the bottom-flat strategy. */
export const flatBaseLowStrategy: Strategy = composeStrategy({
  id: 'flat_base_low',
  description:
    'Bottom + flat base: the stock trades at or below a low percentile of its recent price distribution ' +
    '(default <= 15th percentile of the last ~3 years, clamped to available bars) while the latest month is a ' +
    'flat, MA-converged base (default net change <= 8%, MA5/10/20/60 spread <= 3%). No limit-up pattern is ' +
    'required. Combine with the universe filters minListDays / maxListDays to constrain listing age. Read the ' +
    'evidence fields as quantified facts, not trading signals.',
  predicate: {
    kind: 'and',
    children: [
      { kind: 'filter', filter: 'low_percentile' },
      { kind: 'filter', filter: 'flat_base' },
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
      description: 'Minimum bar count to evaluate a stock at all (~1 trading year).',
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
