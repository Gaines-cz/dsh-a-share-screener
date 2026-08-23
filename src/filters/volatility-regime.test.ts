import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { volatilityRegimeFilter } from './volatility-regime.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function bar(i: number, ret: number | null): SeriesBar {
  return { date: `202601${String(i).padStart(2, '0')}`, close: 10, volume: 1000, ret }
}

function series(rets: (number | null)[]): SeriesBar[] {
  return rets.map((ret, i) => bar(i, ret))
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { volWindow: 60, minAnnualVol: 0.15, maxAnnualVol: 0.8, ...overrides }
}

describe('volatility_regime', () => {
  it('fails a dead series below the minimum volatility', () => {
    // Alternating ±0.05%: daily stdev ≈ 0.0005 → annual ≈ 0.8%.
    const rets = Array.from({ length: 60 }, (_, i) => (i === 0 ? null : i % 2 === 0 ? 0.0005 : -0.0005))
    const result = volatilityRegimeFilter.apply(derive(META, series(rets)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.annualVol as number).toBeLessThan(0.15)
  })

  it('fails a mania series above the maximum volatility', () => {
    // Alternating ±6%: stdev ≈ 0.06 → annual ≈ 9.5 (> 5× the 0.8 cap).
    const rets = Array.from({ length: 60 }, (_, i) => (i === 0 ? null : i % 2 === 0 ? 0.06 : -0.06))
    const result = volatilityRegimeFilter.apply(derive(META, series(rets)), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.annualVol as number).toBeGreaterThan(0.8)
  })

  it('passes a normal-band series (~1% daily moves, ~16% annualized)', () => {
    const rets = Array.from({ length: 60 }, (_, i) => (i === 0 ? null : i % 2 === 0 ? 0.01 : -0.01))
    const result = volatilityRegimeFilter.apply(derive(META, series(rets)), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.annualVol as number).toBeGreaterThan(0.15)
    expect(result.evidence.annualVol as number).toBeLessThan(0.8)
  })

  it('computes stdev around the mean, not around zero (biased ±1%/+3% alternation)', () => {
    // Alternation -1%/+3% has mean +1% and stdev 2% → annual ≈ 32%.
    const rets = Array.from({ length: 60 }, (_, i) => (i === 0 ? null : i % 2 === 0 ? 0.03 : -0.01))
    const result = volatilityRegimeFilter.apply(derive(META, series(rets)), params())
    expect(result.evidence.annualVol as number).toBeGreaterThan(0.28)
    expect(result.evidence.annualVol as number).toBeLessThan(0.36)
    expect(result.passed).toBe(true)
  })

  it('only measures the last volWindow bars', () => {
    // 40 wild bars (±6%) followed by 60 calm bars (±1%): with volWindow 60 the
    // wild prefix must not affect the result.
    const wild = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.06 : -0.06))
    const calm = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01))
    const rets = [null, ...wild.slice(1), ...calm]
    const result = volatilityRegimeFilter.apply(derive(META, series(rets)), params())
    expect(result.passed).toBe(true)
  })

  it('returns null evidence when fewer than 2 returns are available', () => {
    const rets: (number | null)[] = [null, 0.01, 0.02] // only 2 returns... but window covers all 3 bars
    const short = volatilityRegimeFilter.apply(derive(META, series(rets)), params())
    expect(short.evidence.annualVol).not.toBeNull() // 2 returns is enough
    const single = volatilityRegimeFilter.apply(derive(META, series([null, 0.01])), params())
    expect(single.passed).toBe(false)
    expect(single.evidence.annualVol).toBeNull()
  })
})
