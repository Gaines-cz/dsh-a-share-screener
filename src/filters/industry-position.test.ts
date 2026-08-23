import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { IndustryStats } from '../engine/types.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { industryPositionFilter } from './industry-position.js'
import { industryClearanceFilter } from './industry-clearance.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101', industry: '光伏设备' }

function series(n: number): SeriesBar[] {
  return Array.from({ length: n }, (_, i) => ({ date: `202601${String(i).padStart(2, '0')}`, close: 10, volume: 1000, ret: i === 0 ? null : 0 }))
}

function stats(overrides: Partial<IndustryStats> = {}): IndustryStats {
  return { industry: '光伏设备', members: 20, medDrawdown: 0.55, medPos: 0.2, deepShare: 0.4, ...overrides }
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { minIndustryMembers: 8, maxIndustryMedPos: 0.35, ...overrides }
}

function ctxWith(stat?: IndustryStats) {
  const ctx = derive(META, series(30))
  ctx.industry = stat
  return ctx
}

describe('industry_position', () => {
  it('passes a board whose median member sits low in its range', () => {
    const result = industryPositionFilter.apply(ctxWith(stats({ medPos: 0.2 })), params())
    expect(result.passed).toBe(true)
    expect(result.evidence.industry).toBe('光伏设备')
    expect(result.evidence.industryMedPos).toBe(0.2)
    expect(result.evidence.industryMembers).toBe(20)
  })

  it('fails when the median member sits high in its range (dead-cat bounce)', () => {
    const result = industryPositionFilter.apply(ctxWith(stats({ medPos: 0.6 })), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.industryMedPos).toBe(0.6)
  })

  it('fails when the board has too few members', () => {
    const result = industryPositionFilter.apply(ctxWith(stats({ members: 5 })), params())
    expect(result.passed).toBe(false)
  })

  it('fails with null evidence when no industry stats are available', () => {
    const result = industryPositionFilter.apply(ctxWith(undefined), params())
    expect(result.passed).toBe(false)
    expect(result.evidence.industryMedPos).toBeNull()
    expect(result.evidence.industryMembers).toBeNull()
    expect(result.evidence.industry).toBe('光伏设备')
  })

  it('requires the industry capability', () => {
    expect(industryPositionFilter.requires).toEqual({ industry: true })
  })

  it('shares minIndustryMembers identically with industry_clearance (predicate dedup)', () => {
    // Both gates in ONE predicate must merge paramDocs without a collision.
    const posDoc = industryPositionFilter.paramDocs.minIndustryMembers!
    const clearDoc = industryClearanceFilter.paramDocs.minIndustryMembers!
    expect(JSON.stringify(posDoc, Object.keys(posDoc).sort())).toBe(JSON.stringify(clearDoc, Object.keys(clearDoc).sort()))
  })
})
