/**
 * Atomic filter `volume_dry_up`: an absolute volume drought — the average
 * volume of the last `dryUpBars` bars is at most `maxDryUpRatio` of the
 * average over the preceding `referenceWindowBars` bars (the dry window is
 * excluded from its own baseline, so a long drought cannot quietly drag the
 * reference down). Complements `cooldown_pullback`: that gate is relative to
 * one limit-up day, this one is relative to the stock's own normal turnover —
 * "地量见地价" as a left-side companion.
 * @module a-share-screener/filters/volume-dry-up
 */
import { meanVolume, round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const volumeDryUpFilter: Filter = {
  id: 'volume_dry_up',
  description:
    'Absolute volume drought: the recent `dryUpBars` average volume is at most `maxDryUpRatio` of the average over ' +
    'the preceding `referenceWindowBars` bars (dry window excluded from its own baseline).',
  paramDocs: {
    dryUpBars: {
      type: 'number',
      default: 5,
      min: 3,
      max: 30,
      integer: true,
      description: 'Bar count for the recent (dry) volume average.',
    },
    referenceWindowBars: {
      type: 'number',
      default: 120,
      min: 20,
      max: 500,
      integer: true,
      description: 'Bar count of the normal-turnover baseline ending right before the dry window.',
    },
    maxDryUpRatio: {
      type: 'number',
      default: 0.5,
      min: 0.05,
      max: 2,
      description: 'Recent average volume must be at most this fraction of the baseline average.',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const dryBars = params.dryUpBars as number
    const refWindow = params.referenceWindowBars as number
    const dryStart = ctx.last - dryBars + 1
    // Baseline ends where the dry window begins, so the drought under test
    // never dilutes its own reference.
    const refAvg = meanVolume(ctx.bars, dryStart - refWindow, dryStart)
    if (refAvg <= 0) {
      // Not enough baseline bars, or the baseline is all-zero (suspended):
      // a drought cannot be measured against nothing.
      return { passed: false, evidence: { dryUpVolumeRatio: null } }
    }
    const dryAvg = meanVolume(ctx.bars, dryStart, ctx.last + 1)
    const ratio = dryAvg / refAvg
    const passed = ratio <= (params.maxDryUpRatio as number)
    return { passed, evidence: { dryUpVolumeRatio: round(ratio, 4) } }
  },
}
