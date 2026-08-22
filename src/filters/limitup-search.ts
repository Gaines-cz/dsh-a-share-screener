/**
 * Shared candidate search for the "volume-heavy limit-up" day(s).
 *
 * `volume_limit_up` resolves the most recent day whose volume surge clears the
 * threshold (a pure "does a limit-up exist" fact); `cooldown_pullback` walks the
 * same candidates newest-to-oldest to find a day that is *also* followed by a
 * pullback and volume cooldown. The two filters therefore report evidence about
 * potentially different days — by design, since they assert different facts.
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
    description:
      'The limit-up day must be at least this many bars before the latest bar (room to pull back and cool). ' +
      'cooldown_pullback enforces at least cooldownBars + 1 so its cooldown window never overlaps the limit-up day.',
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

/**
 * Iterate candidate volume-heavy limit-up days newest-to-oldest, applying the
 * shared window / minimum-gap / surge bounds. `minAfter` defaults to
 * `minBarsAfterLimitUp`; callers whose cooldown window must never overlap the
 * limit-up day pass `max(minBarsAfterLimitUp, cooldownBars + 1)`.
 */
export function* iterVolumeHeavyLimitUp(
  ctx: DerivedCtx,
  params: StrategyParams,
  minAfter?: number,
): Generator<LimitUpReference> {
  const windowBars = params.limitUpWindowBars as number
  const minSurge = params.minVolumeSurge as number
  const after = minAfter ?? (params.minBarsAfterLimitUp as number)
  const firstCandidate = Math.max(5, ctx.last - windowBars)
  const latestAllowed = ctx.last - after
  for (let i = ctx.limitUpDays.length - 1; i >= 0; i--) {
    const day = ctx.limitUpDays[i]!
    if (day.index < firstCandidate) break
    if (day.index > latestAllowed) continue
    if (day.surge < minSurge) continue
    yield { index: day.index, date: day.date, pct: day.ret, surge: day.surge }
  }
}

/** Most recent volume-heavy limit-up day inside the window, or null. */
export function findVolumeHeavyLimitUp(ctx: DerivedCtx, params: StrategyParams): LimitUpReference | null {
  return iterVolumeHeavyLimitUp(ctx, params).next().value ?? null
}
