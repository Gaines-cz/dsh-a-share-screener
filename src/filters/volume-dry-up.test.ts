import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { volumeDryUpFilter } from './volume-dry-up.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function series(volumes: number[]): SeriesBar[] {
  return volumes.map((volume, i) => ({
    date: `202601${String(i).padStart(2, '0')}`,
    close: 10,
    volume,
    ret: i === 0 ? null : 0,
  }))
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { dryUpBars: 5, referenceWindowBars: 120, maxDryUpRatio: 0.5, ...overrides }
}

describe('volume_dry_up', () => {
  it('passes a drought: recent average well below the baseline', () => {
    // 120 bars at 1000, then 5 bars at 100 → ratio 0.1.
    const vols = [...Array.from({ length: 120 }, () => 1000), ...Array.from({ length: 5 }, () => 100)]
    const result = volumeDryUpFilter.apply(derive(META, series(vols)), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.dryUpVolumeRatio).toBe(0.1)
  })

  it('fails normal turnover', () => {
    const vols = Array.from({ length: 125 }, () => 1000)
    const result = volumeDryUpFilter.apply(derive(META, series(vols)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.dryUpVolumeRatio).toBe(1)
  })

  it('excludes the dry window from its own baseline', () => {
    // 10 baseline bars at 1000, 10 dry bars at 100. With the dry window
    // excluded the baseline is 1000 (ratio 0.1); if it were included the
    // baseline would be 550 (ratio ~0.18). The threshold 0.15 separates them.
    const vols = [...Array.from({ length: 10 }, () => 1000), ...Array.from({ length: 10 }, () => 100)]
    const result = volumeDryUpFilter.apply(
      derive(META, series(vols)),
      params({ dryUpBars: 10, referenceWindowBars: 10, maxDryUpRatio: 0.15 }),
    )
    expect(result.passed).toBe(true)
    expect(result.evidence.dryUpVolumeRatio).toBe(0.1)
  })

  it('fails with null evidence when the baseline is empty or all-zero (suspended)', () => {
    // Too few bars: the baseline window has nothing before the dry window.
    const short = volumeDryUpFilter.apply(derive(META, series([100, 100, 100])), params())
    expect(short.passed).toBe(false)
    expect(short.evidence.dryUpVolumeRatio).toBeNull()
    // All-zero baseline: a drought cannot be measured against nothing.
    const vols = [...Array.from({ length: 120 }, () => 0), ...Array.from({ length: 5 }, () => 100)]
    const zeroBase = volumeDryUpFilter.apply(derive(META, series(vols)), params())
    expect(zeroBase.passed).toBe(false)
    expect(zeroBase.evidence.dryUpVolumeRatio).toBeNull()
  })

  it('clamps the baseline start when the series is younger than the window', () => {
    // 20 baseline bars at 1000 then 5 dry at 100, referenceWindowBars 120:
    // the baseline clamps to the available 20 bars, ratio stays 0.1.
    const vols = [...Array.from({ length: 20 }, () => 1000), ...Array.from({ length: 5 }, () => 100)]
    const result = volumeDryUpFilter.apply(derive(META, series(vols)), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.dryUpVolumeRatio).toBe(0.1)
  })
})
