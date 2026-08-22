/**
 * Atomic filter `cooldown_pullback`: after the volume-heavy limit-up day the
 * price pulled back below that day's close and the recent average volume cooled
 * to at most `maxCooldownVolumeRatio` of the limit-up day's volume.
 * @module a-share-screener/filters/cooldown-pullback
 */
import { meanVolume, round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { findVolumeHeavyLimitUp, limitUpSearchParamDocs } from './limitup-search.js'

export const cooldownPullbackFilter: Filter = {
  id: 'cooldown_pullback',
  description:
    'After the volume-heavy limit-up day, the price pulled back below that close and the recent `cooldownBars` average volume is at most `maxCooldownVolumeRatio` of the limit-up day volume.',
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
    const found = findVolumeHeavyLimitUp(ctx, params)
    if (found === null) {
      return { passed: false, evidence: { cooldownVolumeRatio: null, daysSinceLimitUp: null } }
    }
    let pulledBack = false
    for (let e = found.index + 1; e <= ctx.last; e++) {
      if (ctx.idx[e]! < ctx.idx[found.index]!) {
        pulledBack = true
        break
      }
    }
    const cooldownBars = params.cooldownBars as number
    const cooldownAvg = meanVolume(ctx.bars, ctx.last - cooldownBars + 1, ctx.last + 1)
    const limitUpVolume = ctx.bars[found.index]!.volume
    const cooldownRatio = cooldownAvg / limitUpVolume
    const passed = pulledBack && cooldownAvg <= (params.maxCooldownVolumeRatio as number) * limitUpVolume
    return {
      passed,
      evidence: { cooldownVolumeRatio: round(cooldownRatio, 4), daysSinceLimitUp: ctx.last - found.index },
    }
  },
}