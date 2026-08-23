/**
 * Strategy `low_flat_breakout`: deep below the window high + flat base +
 * volume breakout — the right-side twin of `low_flat_limit_up`. Where the
 * limit-up strategy waits for a faded surge (left side, cool), this one waits
 * for the base to LAUNCH: a volume-heavy close above the base high, the index
 * holding out of the base since, and the MA stopped falling (right side,
 * warming).
 *
 * Composed from three atomic filters via {@link composeStrategy}: deep_drawdown
 * AND platform_breakout AND ma_stabilization. Two deliberate omissions:
 * - `low_percentile` — a close above the base high sits ABOVE the entire
 *   bottom-side distribution by construction, so the latest-price percentile
 *   is structurally ~100% after any breakout off the bottom; the position gate
 *   is `deep_drawdown` instead.
 * - `flat_base` — the breakout filter measures the base immediately before
 *   the breakout day, and a breakout makes the LATEST window non-flat by
 *   construction.
 * @module a-share-screener/strategies/low-flat-breakout
 */
import { composeStrategy } from '../engine/compose.js'
import { createFilterRegistry } from '../filters/index.js'
import type { Strategy, StrategyParams, StrategyScreenInput } from './registry.js'

/** Compose the drawdown position gate with the breakout + MA-stabilization confirmation. */
export const lowFlatBreakoutStrategy: Strategy = composeStrategy({
  id: 'low_flat_breakout',
  description:
    'Deep low + volume breakout (right-side twin of low_flat_limit_up): the stock sits deep below its window ' +
    'high (default >= 65% drawdown, on the chained return index), and within the last ~2 weeks a volume-heavy ' +
    'day (default >= 2x the prior 5-day average) closed at least 2% above the high of the preceding one-month ' +
    'flat base with the price holding out of the base since, while the MA20 stopped falling and the price sits ' +
    'at or above it. Unlike low_flat_limit_up there is no latest-price percentile gate: a breakout close above ' +
    'the base high sits at the top of the bottom-side distribution by construction. Read the evidence fields ' +
    'as quantified facts, not trading signals.',
  predicate: {
    kind: 'and',
    children: [
      { kind: 'filter', filter: 'deep_drawdown' },
      { kind: 'filter', filter: 'platform_breakout' },
      { kind: 'filter', filter: 'ma_stabilization' },
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
    // failed-gate diagnosis: platform_breakout needs its base window plus 5
    // prior bars for the surge average (plus the breakout window), and
    // ma_stabilization needs two MA snapshots (maStabWindow + maSlopeBars).
    const breakoutNeed = (params.baseWindowBars as number) + (params.breakoutWindowBars as number) + 6
    const maNeed = (params.maStabWindow as number) + (params.maSlopeBars as number)
    return input.bars.length >= Math.max(60, params.minBars as number, breakoutNeed, maNeed)
  },
})
