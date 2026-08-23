import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { platformBreakoutFilter } from './platform-breakout.js'

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
    breakoutWindowBars: 10,
    baseWindowBars: 30,
    maxBaseRangeChange: 0.08,
    minBreakoutMargin: 0.02,
    minBreakoutSurge: 2,
    minBarsAfterBreakout: 1,
    maxBaseGiveback: 0,
    ...overrides,
  }
}

/**
 * Textbook shape: flat base (0..29), volume breakout +6% on bar 30, held flat
 * above the base high through bar 39. Defaults expect the breakout within the
 * last 10 bars of a 40-bar series: last=39, latestAllowed=38 — so the fixture
 * puts the breakout at bar 38 by default via the `at` override helper.
 */
function breakoutFixture(at = 38, total = 40): SeriesBar[] {
  const overrides: Record<number, { ret?: number; volume?: number }> = {}
  overrides[at] = { ret: 0.06, volume: 3000 }
  for (let i = at + 1; i < total; i++) overrides[i] = { ret: 0 }
  return series(total, overrides)
}

describe('platform_breakout', () => {
  it('matches the textbook flat-base → volume breakout, citing the breakout day', () => {
    const bars = breakoutFixture()
    const result = platformBreakoutFilter.apply(derive(META, bars), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.breakoutDate).toBe(bars[38]!.date)
    expect(result.evidence.breakoutSurge).toBe(3)
    expect(result.evidence.barsSinceBreakout).toBe(1)
    expect(result.evidence.baseToClosePct as number).toBeGreaterThan(0.02)
  })

  it('fails when the breakout re-enters the base afterwards', () => {
    // Breakout +6% on 38, then a full round-trip back below the base high.
    const bars = breakoutFixture()
    const overridden: SeriesBar[] = bars.map((b, i) =>
      i === 39 ? { ...b, ret: -0.07 } : b,
    )
    const result = platformBreakoutFilter.apply(derive(META, overridden), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.breakoutDate).toBeNull()
  })

  it('tolerates a giveback within maxBaseGiveback but not beyond it', () => {
    // Breakout +6% on 38, then -6% on 39: index ends ~0.4% below the base
    // high — a giveback inside a 3% allowance, beyond a 0% one.
    const bars = breakoutFixture()
    const dipped: SeriesBar[] = bars.map((b, i) => (i === 39 ? { ...b, ret: -0.06 } : b))
    expect(platformBreakoutFilter.apply(derive(META, dipped), params()).passed).toBe(false)
    expect(
      platformBreakoutFilter.apply(derive(META, dipped), params({ maxBaseGiveback: 0.03 })).passed,
    ).toBe(true)
  })

  it('fails when the breakout volume does not surge', () => {
    const bars = breakoutFixture()
    bars[38] = { ...bars[38]!, volume: 1200 } // 1.2x < 2x
    const result = platformBreakoutFilter.apply(derive(META, bars), params())
    expect(result.passed).toBe(false)
  })

  it('fails when the pre-breakout base is not flat', () => {
    // A -0.5%/bar drift across the base window (net ~15%) breaks flatness.
    const overrides: Record<number, { ret?: number; volume?: number }> = {}
    for (let i = 9; i <= 38; i++) overrides[i] = { ret: -0.005 }
    overrides[38] = { ret: 0.06, volume: 3000 }
    overrides[39] = { ret: 0 }
    const result = platformBreakoutFilter.apply(derive(META, series(40, overrides)), params())
    expect(result.passed).toBe(false)
  })

  it('cites the most recent qualifying day when two breakouts exist', () => {
    // Breakout at 30 and another at 38; the evidence must cite 38.
    const overrides: Record<number, { ret?: number; volume?: number }> = {}
    overrides[30] = { ret: 0.06, volume: 3000 }
    overrides[38] = { ret: 0.06, volume: 2500 }
    overrides[39] = { ret: 0 }
    const bars = series(40, overrides)
    const result = platformBreakoutFilter.apply(derive(META, bars), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.breakoutDate).toBe(bars[38]!.date)
  })

  it('does not treat a zero-volume prior as an infinite surge (suspended/resumed name)', () => {
    // Flat base with ZERO volume on the 5 bars before the breakout day: the
    // surge must read 0 (not Infinity), so the breakout fails the volume gate.
    const overrides: Record<number, { ret?: number; volume?: number }> = {}
    for (let i = 33; i <= 37; i++) overrides[i] = { volume: 0 }
    overrides[38] = { ret: 0.06, volume: 3000 }
    overrides[39] = { ret: 0 }
    const result = platformBreakoutFilter.apply(derive(META, series(40, overrides)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.breakoutDate).toBeNull()
  })

  it('ignores a breakout older than the search window', () => {
    // Breakout at 25 in a 40-bar series: 14 bars back > breakoutWindowBars 10.
    const bars = breakoutFixture(25)
    const result = platformBreakoutFilter.apply(derive(META, bars), params())
    expect(result.passed).toBe(false)
  })
})
