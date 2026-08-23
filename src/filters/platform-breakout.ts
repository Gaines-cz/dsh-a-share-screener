/**
 * Atomic filter `platform_breakout`: a flat base of `baseWindowBars` bars is
 * followed by a volume-heavy breakout day whose close clears the base high,
 * and the index has stayed out of the base ever since. The mirror image of
 * `cooldown_pullback`: that one confirms a pullback, this one confirms a
 * launch. The flat-base test is self-contained (measured immediately before
 * the breakout day), so a strategy using this filter must NOT also require
 * `flat_base` on the latest window — a breakout makes the latest window
 * non-flat by construction.
 * @module a-share-screener/filters/platform-breakout
 */
import { meanVolume, round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const platformBreakoutFilter: Filter = {
  id: 'platform_breakout',
  description:
    'Within the last `breakoutWindowBars` bars there is a day that closes at least `minBreakoutMargin` above the ' +
    'high of the `baseWindowBars`-bar flat base immediately before it, on >= `minBreakoutSurge`x the prior 5-bar ' +
    'average volume, and the index never re-entered the base afterwards (giveback <= `maxBaseGiveback`). ' +
    'Evidence cites the MOST RECENT qualifying breakout day.',
  paramDocs: {
    breakoutWindowBars: {
      type: 'number',
      default: 10,
      min: 1,
      max: 60,
      integer: true,
      description: 'Bars back from the latest bar to search for the breakout day.',
    },
    baseWindowBars: {
      type: 'number',
      default: 30,
      min: 10,
      max: 250,
      integer: true,
      description: 'Flat-base window immediately BEFORE the breakout day.',
    },
    maxBaseRangeChange: {
      type: 'number',
      default: 0.08,
      min: 0.005,
      max: 0.5,
      description: 'Max abs net change of the return index over the base window (base flatness).',
    },
    minBreakoutMargin: {
      type: 'number',
      default: 0.02,
      min: 0,
      max: 0.3,
      description: 'Breakout close must clear the base high by at least this fraction.',
    },
    minBreakoutSurge: {
      type: 'number',
      default: 2,
      min: 1.1,
      max: 20,
      description: 'Breakout-day volume must be at least this multiple of the prior 5-bar average.',
    },
    minBarsAfterBreakout: {
      type: 'number',
      default: 2,
      min: 1,
      max: 30,
      integer: true,
      description: 'Breakout day must be at least this many bars before the latest bar (>= 2 gives the breakout one confirming close).',
    },
    maxBaseGiveback: {
      type: 'number',
      default: 0,
      min: 0,
      max: 0.1,
      description:
        'Max fraction the index may dip below the base high after the breakout (0 = never re-enter the base).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const baseWindow = params.baseWindowBars as number
    const earliest = Math.max(5, ctx.last - (params.breakoutWindowBars as number))
    const latestAllowed = ctx.last - (params.minBarsAfterBreakout as number)
    const maxGiveback = params.maxBaseGiveback as number

    // Newest to oldest so evidence cites the most recent qualifying day.
    for (let b = latestAllowed; b >= earliest; b--) {
      const baseStart = b - baseWindow
      if (baseStart < 0) break
      // 1. Base flatness over [baseStart, b-1] (breakout day excluded).
      const baseEnd = ctx.idx[b - 1]!
      if (baseEnd <= 0 || ctx.idx[baseStart]! <= 0) continue
      const baseNet = Math.abs(baseEnd / ctx.idx[baseStart]! - 1)
      if (baseNet > (params.maxBaseRangeChange as number)) continue
      // 2. Base high, breakout day excluded.
      let baseMax = -Infinity
      for (let i = baseStart; i < b; i++) {
        if (ctx.idx[i]! > baseMax) baseMax = ctx.idx[i]!
      }
      if (ctx.idx[b]! < baseMax * (1 + (params.minBreakoutMargin as number))) continue
      // 3. Volume surge vs the prior 5 bars. Guard a zero prior average the
      // same way derive() does for limit-up days: suspended-then-resumed names
      // have zero-volume priors, and volume/0 = Infinity must not pass.
      const prevAvg = meanVolume(ctx.bars, b - 5, b)
      const surge = prevAvg <= 0 ? 0 : ctx.bars[b]!.volume / prevAvg
      if (surge < (params.minBreakoutSurge as number)) continue
      // 4. Held out of the base ever since.
      let held = true
      for (let e = b; e <= ctx.last; e++) {
        if (ctx.idx[e]! < baseMax * (1 - maxGiveback)) {
          held = false
          break
        }
      }
      if (!held) continue
      return {
        passed: true,
        evidence: {
          breakoutDate: ctx.bars[b]!.date,
          breakoutSurge: round(surge, 2),
          barsSinceBreakout: ctx.last - b,
          baseToClosePct: round(ctx.current / baseMax - 1, 4),
        },
      }
    }
    return {
      passed: false,
      evidence: { breakoutDate: null, breakoutSurge: null, barsSinceBreakout: null, baseToClosePct: null },
    }
  },
}
