/**
 * Shared search for the "volume-heavy limit-up" reference day used by both
 * `volume_limit_up` and `cooldown_pullback`. Both filters resolve the same day
 * deterministically, so the coalesced evidence stays consistent.
 * @module a-share-screener/filters/limitup-search
 */
import type { ParamDocs, StrategyParams } from '../strategies/registry.js'
import type { DerivedCtx } from '../engine/types.js'

/** Parameter table shared by the two filters that locate the limit-up reference day. */
export const limitUpSearchParamDocs: ParamDocs = {
  limitUpWindowBars: {
    type: 'number',
    default: 120,
    min: 20,
    max: 500,
    integer: true,
    description: 'Bars back to search for the volume-heavy limit-up day (~6 months).',
  },
  minVolumeSurge: {
    type: 'number',
    default: 2,
    min: 1.1,
    max: 20,
    description: 'Limit-up day volume must be at least this multiple of the prior 5-bar average volume.',
  },
  minBarsAfterLimitUp: {
    type: 'number',
    default: 6,
    min: 1,
    max: 30,
    integer: true,
    description: 'The limit-up day must be at least this many bars before the latest bar (room to pull back and cool).',
  },
}

export interface LimitUpReference {
  index: number
  date: string
  /** Daily return of the limit-up bar (fraction). */
  pct: number
  /** volume / mean(prior 5 bars). */
  surge: number
}

/** Most recent limit-up day (scanning back from the latest) with `surge >= minVolumeSurge` inside the window. */
export function findVolumeHeavyLimitUp(ctx: DerivedCtx, params: StrategyParams): LimitUpReference | null {
  const windowBars = params.limitUpWindowBars as number
  const minSurge = params.minVolumeSurge as number
  const minAfter = params.minBarsAfterLimitUp as number
  const firstCandidate = Math.max(5, ctx.last - windowBars)
  const latestAllowed = ctx.last - minAfter
  for (let i = ctx.limitUpDays.length - 1; i >= 0; i--) {
    const day = ctx.limitUpDays[i]!
    if (day.index < firstCandidate) break
    if (day.index > latestAllowed) continue
    if (day.surge < minSurge) continue
    return { index: day.index, date: day.date, pct: day.ret, surge: day.surge }
  }
  return null
}