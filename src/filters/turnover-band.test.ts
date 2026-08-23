import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { turnoverBandFilter } from './turnover-band.js'

const META: StockMeta = {
  code: '600001',
  fullCode: '600001.SH',
  name: 'X',
  board: 'main',
  listDate: '20100101',
  floatMarketCapYuan: 1e9, // 10亿流通市值
}

function series(volumes: number[], close = 10): SeriesBar[] {
  return volumes.map((volume, i) => ({
    date: `202601${String(i).padStart(2, '0')}`,
    close,
    volume,
    ret: i === 0 ? null : 0,
  }))
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { turnoverWindowBars: 20, minTurnoverPct: 0.5, maxTurnoverPct: 0, ...overrides }
}

describe('turnover_band', () => {
  it('derives turnover from volume × 100 / floatShares and reports a median percent', () => {
    // floatCap 10亿 / close 10 = 1e8 float shares. 1000 lots = 100000 shares → 0.1%.
    const result = turnoverBandFilter.apply(derive(META, series([1000, 2000, 3000])), params({ turnoverWindowBars: 3 }))
    expect(result.passed).toBe(false) // median 0.2% < 0.5% floor
    expect(result.evidence.medianTurnoverPct).toBe(0.2)
  })

  it('passes inside the band and honors a non-zero upper bound', () => {
    // volumes → turnovers 1%, 2%, 3% (10000/20000/30000 lots of a 1e8-share float).
    const bars = series([10_000, 20_000, 30_000])
    const mid = turnoverBandFilter.apply(derive(META, bars), params({ turnoverWindowBars: 3, minTurnoverPct: 1 }))
    expect(mid.passed).toBe(true)
    expect(mid.evidence.medianTurnoverPct).toBe(2)
    const capped = turnoverBandFilter.apply(derive(META, bars), params({ turnoverWindowBars: 3, maxTurnoverPct: 1.5 }))
    expect(capped.passed).toBe(false)
  })

  it('measures only the last turnoverWindowBars bars', () => {
    // 5 wild bars then 3 calm bars.
    const bars = series([50_000, 50_000, 50_000, 50_000, 50_000, 10_000, 10_000, 10_000])
    const result = turnoverBandFilter.apply(derive(META, bars), params({ turnoverWindowBars: 3, minTurnoverPct: 0.5, maxTurnoverPct: 2 }))
    expect(result.evidence.medianTurnoverPct).toBe(1)
    expect(result.passed).toBe(true)
  })

  it('fails with null evidence when the list snapshot lacks a float cap', () => {
    const noCap = { ...META, floatMarketCapYuan: undefined }
    const result = turnoverBandFilter.apply(derive(noCap, series([10_000])), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.medianTurnoverPct).toBeNull()
  })

  it('requires the marketCap capability', () => {
    expect(turnoverBandFilter.requires).toEqual({ marketCap: true })
  })
})
