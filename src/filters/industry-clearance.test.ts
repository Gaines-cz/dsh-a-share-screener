import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { IndustryStats } from '../engine/types.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { industryClearanceFilter } from './industry-clearance.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101', industry: '光伏设备' }

function series(n: number): SeriesBar[] {
  return Array.from({ length: n }, (_, i) => ({ date: `202601${String(i).padStart(2, '0')}`, close: 10, volume: 1000, ret: i === 0 ? null : 0 }))
}

function stats(overrides: Partial<IndustryStats> = {}): IndustryStats {
  return { industry: '光伏设备', members: 20, medDrawdown: 0.55, medPos: 0.2, deepShare: 0.4, ...overrides }
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { minIndustryMedDrawdown: 0.4, minIndustryDeepShare: 0.25, minIndustryMembers: 8, ...overrides }
}

function ctxWith(stat?: IndustryStats) {
  const ctx = derive(META, series(30))
  ctx.industry = stat
  return ctx
}

describe('industry_clearance', () => {
  it('passes a deeply-cleared industry with full evidence', () => {
    const result = industryClearanceFilter.apply(ctxWith(stats()), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.industry).toBe('光伏设备')
    expect(result.evidence.industryMedDrawdown).toBe(0.55)
    expect(result.evidence.industryDeepShare).toBe(0.4)
    expect(result.evidence.industryMembers).toBe(20)
  })

  it('fails when the median drawdown is too shallow', () => {
    const result = industryClearanceFilter.apply(ctxWith(stats({ medDrawdown: 0.3 })), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.industryMedDrawdown).toBe(0.3)
  })

  it('fails when too few members are in deep drawdown', () => {
    const result = industryClearanceFilter.apply(ctxWith(stats({ deepShare: 0.1 })), params())
    expect(result.passed).toBe(false)
  })

  it('fails when the board has too few members to be meaningful', () => {
    const result = industryClearanceFilter.apply(ctxWith(stats({ members: 5 })), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.industryMembers).toBe(5)
  })

  it('fails with null evidence when no industry stats are available (no classification)', () => {
    const result = industryClearanceFilter.apply(ctxWith(undefined), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.industryMedDrawdown).toBeNull()
    expect(result.evidence.industry).toBe('光伏设备') // the stock's own tag still reported
  })
})
