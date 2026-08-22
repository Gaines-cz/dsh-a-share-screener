/**
 * Atomic filter `cooldown_pullback`: after the volume-heavy limit-up day the
 * price pulled back below that day's close and the recent average volume cooled
 * to at most `maxCooldownVolumeRatio` of the limit-up day's volume.
 * @module a-share-screener/filters/cooldown-pullback
 */
import { meanVolume, round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { iterVolumeHeavyLimitUp, limitUpSearchParamDocs } from './limitup-search.js'

export const cooldownPullbackFilter: Filter = {
  id: 'cooldown_pullback',
  description:
    'After the volume-heavy limit-up day, the price pulled back below that close and the recent `cooldownBars` average volume is at most `maxCooldownVolumeRatio` of the limit-up day volume. ' +
    'Evidence (cooldownRefDate / cooldownVolumeRatio / daysSinceLimitUp) cites the most recent day that also satisfies this pattern — which may be an OLDER day than the one volume_limit_up cites.',
  paramDocs: {
    ...limitUpSearchParamDocs,
    maxCooldownVolumeRatio: {
      type: 'number',
      default: 0.4,
      min: 0.05,
      max: 1.5,
      description: 'Recent average volume must be at most this fraction of the limit-up day volume.',
    },
    cooldownBars: {
      type: 'number',
      default: 5,
      min: 3,
      max: 30,
      integer: true,
      description: 'Bar count for the recent (cooldown) volume average.',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const cooldownBars = params.cooldownBars as number
    // The cooldown window must never overlap the limit-up day's own volume, so
    // the minimum gap is at least cooldownBars + 1, not merely minBarsAfterLimitUp.
    const minAfter = Math.max(params.minBarsAfterLimitUp as number, cooldownBars + 1)
    const maxRatio = params.maxCooldownVolumeRatio as number
    const cooldownAvg = meanVolume(ctx.bars, ctx.last - cooldownBars + 1, ctx.last + 1)
    for (const day of iterVolumeHeavyLimitUp(ctx, params, minAfter)) {
      let pulledBack = false
      for (let e = day.index + 1; e <= ctx.last; e++) {
        if (ctx.idx[e]! < ctx.idx[day.index]!) {
          pulledBack = true
          break
        }
      }
      if (!pulledBack) continue
      const limitUpVolume = ctx.bars[day.index]!.volume
      if (cooldownAvg > maxRatio * limitUpVolume) continue
      const cooldownRatio = cooldownAvg / limitUpVolume
      return {
        passed: true,
        evidence: {
          cooldownRefDate: day.date,
          cooldownVolumeRatio: round(cooldownRatio, 4),
          daysSinceLimitUp: ctx.last - day.index,
        },
      }
    }
    return {
      passed: false,
      evidence: { cooldownRefDate: null, cooldownVolumeRatio: null, daysSinceLimitUp: null },
    }
  },
}
