import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { maStabilizationFilter } from './ma-stabilization.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function bar(i: number, ret: number, volume: number): SeriesBar {
  return { date: `202601${String(i).padStart(2, '0')}`, close: 10, volume, ret }
}

function series(n: number, overrides: Record<number, { ret?: number; volume?: number }> = {}): SeriesBar[] {
  return Array.from({ length: n }, (_, i) => {
    const o = overrides[i]
    return bar(i, o?.ret ?? 0, o?.volume ?? 1000)
  })
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return {
    maStabWindow: 20,
    maSlopeBars: 5,
    minMaSlope: 0,
    requireCloseAboveMa: true,
    ...overrides,
  }
}

describe('ma_stabilization', () => {
  it('fails while the MA is still falling (downtrend tail)', () => {
    // -0.5%/bar across the whole series keeps the MA20 slope clearly negative.
    const rets: Record<number, { ret: number }> = {}
    for (let i = 1; i < 60; i++) rets[i] = { ret: -0.005 }
    const result = maStabilizationFilter.apply(derive(META, series(60, rets)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.maSlope as number).toBeLessThan(0)
  })

  it('passes a flat series with the latest bar at/above the MA', () => {
    // All-zero returns: MA slope is exactly 0, close == MA.
    const result = maStabilizationFilter.apply(derive(META, series(60)), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.maSlope).toBe(0)
    expect(result.evidence.closeVsMaPct).toBe(0)
  })

  it('passes a bottomed series whose MA turned up', () => {
    // Decline for 40 bars, then +0.3%/bar: the last-5-bar MA20 slope is positive.
    const rets: Record<number, { ret: number }> = {}
    for (let i = 1; i < 40; i++) rets[i] = { ret: -0.004 }
    for (let i = 40; i < 60; i++) rets[i] = { ret: 0.003 }
    const result = maStabilizationFilter.apply(derive(META, series(60, rets)), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.maSlope as number).toBeGreaterThan(0)
    expect(result.evidence.closeVsMaPct as number).toBeGreaterThan(0)
  })

  it('rejects a close below the MA when requireCloseAboveMa is set, but passes with it off', () => {
    // Long flat, one -3% dip 10 bars ago, then +0.8%/bar recovery: the price is
    // back above the MA and the MA slope turned positive.
    const rets: Record<number, { ret: number }> = {}
    for (let i = 1; i < 50; i++) rets[i] = { ret: 0 }
    rets[50] = { ret: -0.03 } // dip
    for (let i = 51; i < 60; i++) rets[i] = { ret: 0.008 } // recovery
    const flat = series(60, rets)
    const recovered = maStabilizationFilter.apply(derive(META, flat), params())
    expect(recovered.passed).toBe(true)

    // The unrecovered twin: a long rally whose MA20 is still rising, then a
    // sharp two-day crash puts the close below the MA while the slope gate
    // still reads >= 0 (the crash bars are a minority of the MA window).
    const rets2: Record<number, { ret: number }> = {}
    for (let i = 1; i <= 97; i++) rets2[i] = { ret: 0.005 } // +0.5%/bar rally
    rets2[98] = { ret: -0.15 }
    rets2[99] = { ret: -0.05 }
    const crashed = series(100, rets2)
    const strict = maStabilizationFilter.apply(derive(META, crashed), params())
    expect(strict.passed).toBe(false)
    expect(strict.evidence.closeVsMaPct as number).toBeLessThan(0)
    expect(strict.evidence.maSlope as number).toBeGreaterThanOrEqual(0)
    const lax = maStabilizationFilter.apply(
      derive(META, crashed),
      params({ requireCloseAboveMa: false }),
    )
    expect(lax.passed).toBe(true)
  })

  it('fails with null evidence when the series is too short for two MA snapshots', () => {
    const result = maStabilizationFilter.apply(derive(META, series(24)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.maSlope).toBeNull()
    expect(result.evidence.closeVsMaPct).toBeNull()
  })

  it('honors a positive minMaSlope threshold', () => {
    // Flat series: slope exactly 0 — passes at threshold 0, fails at 0.001.
    const flat = derive(META, series(60))
    expect(maStabilizationFilter.apply(flat, params({ minMaSlope: 0 })).passed).toBe(true)
    expect(maStabilizationFilter.apply(flat, params({ minMaSlope: 0.001 })).passed).toBe(false)
  })
})
