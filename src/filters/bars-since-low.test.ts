import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { barsSinceLowFilter } from './bars-since-low.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function bar(i: number, ret: number): SeriesBar {
  return { date: `202601${String(i).padStart(2, '0')}`, close: 10, volume: 1000, ret }
}

function series(n: number, overrides: Record<number, number> = {}): SeriesBar[] {
  return Array.from({ length: n }, (_, i) => bar(i, overrides[i] ?? 0))
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { lowLookbackBars: 500, minBarsSinceLow: 40, maxPctAboveLow: 0.5, ...overrides }
}

describe('bars_since_low', () => {
  it('passes a ground-down base: low 60 bars back, price near the low', () => {
    // Flat 0..199, dip to the minimum at 200, then a mild recovery to +8%.
    const rets: Record<number, number> = {}
    rets[200] = -0.2
    for (let i = 201; i <= 260; i++) rets[i] = 0.003 // ~+8% total
    const result = barsSinceLowFilter.apply(derive(META, series(261, rets)), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.barsSinceLow).toBe(60)
    expect(result.evidence.pctAboveLow as number).toBeGreaterThan(0)
    expect(result.evidence.pctAboveLow as number).toBeLessThanOrEqual(0.5)
  })

  it('fails when the low is fresh (knife still falling)', () => {
    // The minimum sits on the second-to-last bar.
    const rets: Record<number, number> = {}
    rets[259] = -0.2
    const result = barsSinceLowFilter.apply(derive(META, series(261, rets)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.barsSinceLow as number).toBeLessThan(40)
  })

  it('fails when the price has rebounded too far off the low', () => {
    // Low at 200, then +1%/bar for 61 bars → ~+83% above the low.
    const rets: Record<number, number> = {}
    rets[200] = -0.2
    for (let i = 201; i <= 260; i++) rets[i] = 0.01
    const result = barsSinceLowFilter.apply(derive(META, series(261, rets)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.pctAboveLow as number).toBeGreaterThan(0.5)
    // The time gate itself passed — only the height gate failed.
    expect(result.evidence.barsSinceLow as number).toBeGreaterThanOrEqual(40)
  })

  it('clamps the lookback window to the available bars for young stocks', () => {
    // 120-bar series (below the 500-bar default lookback), low at bar 10,
    // flat afterwards: the clamped window still finds the true minimum.
    const rets: Record<number, number> = {}
    for (let i = 1; i <= 10; i++) rets[i] = -0.01
    const result = barsSinceLowFilter.apply(derive(META, series(120, rets)), params())
    // last index 119, first minimum at index 10 → 109 bars since the low.
    expect(result.evidence.barsSinceLow).toBe(109)
    expect(result.passed).toBe(true)
  })

  it('ties on equal lows resolve to the FIRST minimum (longest grinding time)', () => {
    // Two exactly equal minima (factor 0.5, exact in binary floating point) at
    // bars 100 and 200; the filter must cite the earlier one so barsSinceLow
    // reflects the oldest bottom.
    const rets: Record<number, number> = {}
    rets[100] = -0.5 // idx factor exactly 0.5
    rets[101] = 1.0 // back to exactly 1.0
    rets[200] = -0.5
    rets[201] = 1.0
    const result = barsSinceLowFilter.apply(derive(META, series(261, rets)), params())
    expect(result.evidence.barsSinceLow).toBe(261 - 1 - 100)
  })
})
