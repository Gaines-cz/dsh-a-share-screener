/**
 * Atomic filter `volume_limit_up`: a volume-heavy limit-up day exists inside
 * the lookback window. Volume surge is relative to the prior 5-bar average;
 * the day must be recent enough to leave room for a pullback and cooldown.
 * @module a-share-screener/filters/volume-limitup
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { findVolumeHeavyLimitUp, limitUpSearchParamDocs } from './limitup-search.js'

export const volumeLimitUpFilter: Filter = {
  id: 'volume_limit_up',
  description:
    'Within the last `limitUpWindowBars` bars there is a close-at-limit-up day whose volume is at least `minVolumeSurge` times the prior 5-bar average. ' +
    'Evidence (limitUpDate / limitUpPct / limitUpVolumeSurge) always cites the MOST RECENT such day; cooldown_pullback may cite a different, older day.',
  paramDocs: { ...limitUpSearchParamDocs },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const found = findVolumeHeavyLimitUp(ctx, params)
    return {
      passed: found !== null,
      evidence: {
        limitUpDate: found?.date ?? null,
        limitUpPct: found === null ? null : round(found.pct, 4),
        limitUpVolumeSurge: found === null ? null : round(found.surge, 2),
      },
    }
  },
}
