/**
 * Atomic filter `ma_stabilization`: the moving average of the chained return
 * index has stopped falling (slope over `maSlopeBars` ≥ `minMaSlope`), and
 * optionally the latest price sits at or above the MA — the cheapest
 * right-side confirmation that a low flat base has stopped declining.
 * @module a-share-screener/filters/ma-stabilization
 */
import { round, smaAtIndex } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const maStabilizationFilter: Filter = {
  id: 'ma_stabilization',
  description:
    'The `maStabWindow`-bar MA of the return index changed at least `minMaSlope` over the last `maSlopeBars` bars ' +
    '(0 = stopped falling), and when `requireCloseAboveMa` is set the latest price sits at or above the MA.',
  paramDocs: {
    maStabWindow: {
      type: 'number',
      default: 20,
      min: 5,
      max: 120,
      integer: true,
      description: 'MA window on the chained return index.',
    },
    maSlopeBars: {
      type: 'number',
      default: 5,
      min: 2,
      max: 30,
      integer: true,
      description: 'Bars over which the MA slope is measured.',
    },
    minMaSlope: {
      type: 'number',
      default: 0,
      min: -0.05,
      max: 0.2,
      description: 'Min relative MA change over maSlopeBars (0 = stopped falling).',
    },
    requireCloseAboveMa: {
      type: 'boolean',
      default: true,
      description: 'Latest price must sit at or above the MA.',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const window = params.maStabWindow as number
    const slopeBars = params.maSlopeBars as number
    // The slope needs two MA snapshots slopeBars apart, each needing a full
    // window: bars.length >= window + slopeBars.
    if (ctx.bars.length < window + slopeBars) {
      return { passed: false, evidence: { maSlope: null, closeVsMaPct: null } }
    }
    const ma = smaAtIndex(ctx.idx, ctx.bars.length, window)
    const maPrev = smaAtIndex(ctx.idx, ctx.bars.length - slopeBars, window)
    if (ma === null || maPrev === null || ma <= 0 || maPrev <= 0) {
      return { passed: false, evidence: { maSlope: null, closeVsMaPct: null } }
    }
    const slope = ma / maPrev - 1
    const closeVsMa = ctx.current / ma - 1
    const passed =
      slope >= (params.minMaSlope as number) &&
      (!params.requireCloseAboveMa || ctx.current >= ma)
    return { passed, evidence: { maSlope: round(slope, 4), closeVsMaPct: round(closeVsMa, 4) } }
  },
}
