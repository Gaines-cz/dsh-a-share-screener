import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { cooldownPullbackFilter } from './cooldown-pullback.js'

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
    limitUpWindowBars: 120,
    minVolumeSurge: 2,
    minBarsAfterLimitUp: 6,
    maxCooldownVolumeRatio: 0.4,
    cooldownBars: 5,
    ...overrides,
  }
}

describe('cooldown_pullback', () => {
  it('backtracks to an older limit-up day when the most recent one never pulled back', () => {
    // Bars 0..39. Limit-up at 20 (pulls back at 21, then cools), and a more
    // recent limit-up at 27 whose close is never undercut afterwards.
    const bars = series(40, {
      20: { ret: 0.1, volume: 3000 },
      21: { ret: -0.05 },
      27: { ret: 0.1, volume: 3000 },
      35: { volume: 100 },
      36: { volume: 100 },
      37: { volume: 100 },
      38: { volume: 100 },
      39: { volume: 100 },
    })
    const result = cooldownPullbackFilter.apply(derive(META, bars), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.daysSinceLimitUp).toBe(19) // found index 20, not 27
  })

  it('excludes a limit-up day that sits inside the cooldown window (minAfter = cooldownBars + 1)', () => {
    // A single limit-up at 31 with a clean pullback and cool volume, but gap 8
    // is below cooldownBars + 1 = 9, so it must not be considered as a candidate.
    const bars = series(40, {
      31: { ret: 0.1, volume: 3000 },
      32: { ret: -0.05, volume: 100 },
      33: { volume: 100 },
      34: { volume: 100 },
      35: { volume: 100 },
      36: { volume: 100 },
      37: { volume: 100 },
      38: { volume: 100 },
      39: { volume: 100 },
    })
    const result = cooldownPullbackFilter.apply(
      derive(META, bars),
      params({ cooldownBars: 8, maxCooldownVolumeRatio: 1.5 }),
    )
    expect(result.passed).toBe(false)
  })
})
