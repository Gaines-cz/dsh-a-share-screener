import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { marketCapBandFilter } from './market-cap-band.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function series(n: number): SeriesBar[] {
  return Array.from({ length: n }, (_, i) => ({ date: `202601${String(i).padStart(2, '0')}`, close: 10, volume: 1000, ret: i === 0 ? null : 0 }))
}

function metaWithCap(capYuan?: number) {
  return { ...META, totalMarketCapYuan: capYuan }
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { minCapYi: 20, maxCapYi: 0, ...overrides }
}

describe('market_cap_band', () => {
  it('passes inside the band and reports the cap in 亿元', () => {
    const ctx = derive(metaWithCap(8.5e9), series(10)) // 85亿
    const result = marketCapBandFilter.apply(ctx, params())
    expect(result.passed).toBe(true)
    expect(result.evidence.marketCapYi).toBe(85)
  })

  it('fails below the minimum', () => {
    const ctx = derive(metaWithCap(1.5e9), series(10)) // 15亿 < 20亿
    expect(marketCapBandFilter.apply(ctx, params()).passed).toBe(false)
  })

  it('fails above a non-zero maximum but passes when max is 0 (unbounded)', () => {
    const ctx = derive(metaWithCap(6e11), series(10)) // 6000亿
    expect(marketCapBandFilter.apply(ctx, params({ maxCapYi: 5000 })).passed).toBe(false)
    expect(marketCapBandFilter.apply(ctx, params({ maxCapYi: 0 })).passed).toBe(true)
  })

  it('fails with null evidence when the list snapshot carries no cap', () => {
    const ctx = derive(metaWithCap(undefined), series(10))
    const result = marketCapBandFilter.apply(ctx, params())
    expect(result.passed).toBe(false)
    expect(result.evidence.marketCapYi).toBeNull()
  })
})
