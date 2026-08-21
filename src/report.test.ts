import { describe, expect, it } from 'vitest'
import { gateLabel, renderJson, renderMarkdown, tierResults, type ReportContext, type TieredEntry } from './report.js'
import type { StrategyDiagnosis } from './strategies/registry.js'
import type { StockMeta } from './types.js'

function stock(code: string, name: string): StockMeta {
  return { code, fullCode: `${code}.SH`, name, board: 'main', listDate: '20100101' }
}

function diag(overrides: Partial<StrategyDiagnosis>): StrategyDiagnosis {
  return {
    matched: false,
    gates: { drawdown: true, percentile: true, flat: true, limitUp: false },
    failedGates: ['limitUp'],
    metrics: {
      close: 10,
      drawdownFromHigh: 0.62,
      percentileInWindow: 0.05,
      flatNetChange: 0.03,
      flatMaSpread: 0.02,
      limitUpDate: '20260522',
      limitUpVolumeSurge: 2.6,
      cooldownVolumeRatio: 0.2,
      daysSinceLimitUp: 60,
      barsAnalyzed: 800,
    },
    ...overrides,
  }
}

describe('report tiering', () => {
  it('splits hits, single-gate near-misses and the rest', () => {
    const entries: TieredEntry[] = [
      { stock: stock('600001', 'A'), diagnosis: diag({ matched: true, gates: { drawdown: true, percentile: true, flat: true, limitUp: true }, failedGates: [] }) },
      { stock: stock('600002', 'B'), diagnosis: diag({}) }, // only limitUp fails
      { stock: stock('600003', 'C'), diagnosis: diag({ gates: { drawdown: false, percentile: false, flat: true, limitUp: true }, failedGates: ['drawdown', 'percentile'] }) },
    ]
    const tiered = tierResults(entries)
    expect(tiered.hits.map((e) => e.stock.code)).toEqual(['600001'])
    expect(tiered.nearMisses.map((e) => e.stock.code)).toEqual(['600002'])
    expect(tiered.others).toBe(1)
  })

  it('sorts near-misses by drawdown depth descending', () => {
    const entries: TieredEntry[] = [
      { stock: stock('600002', 'B'), diagnosis: diag({ metrics: { ...diag({}).metrics, drawdownFromHigh: 0.5 } }) },
      { stock: stock('600003', 'C'), diagnosis: diag({ metrics: { ...diag({}).metrics, drawdownFromHigh: 0.7 } }) },
    ]
    const tiered = tierResults(entries)
    expect(tiered.nearMisses.map((e) => e.stock.code)).toEqual(['600003', '600002'])
  })

  it('maps gate ids to human labels', () => {
    expect(gateLabel('drawdown')).toBe('距高点回撤')
    expect(gateLabel('nope')).toBe('nope')
  })
})

describe('report rendering', () => {
  const ctx: ReportContext = {
    strategy: 'low_flat_limit_up',
    strategyDescription: 'desc',
    params: { minDrawdownFromHigh: 0.65 },
    source: 'sina',
    scope: '测试板块',
    generatedAt: '2026-08-22T00:00:00.000Z',
    lastBarDate: '20260821',
    evaluated: 3,
    skipped: { 'st-or-delisting': 1 },
    tiered: {
      hits: [],
      nearMisses: [{ stock: stock('600002', '样例股份'), diagnosis: diag({}) }],
      others: 2,
    },
  }

  it('renders markdown with sections and percentages', () => {
    const md = renderMarkdown(ctx)
    expect(md).toContain('# 选股扫描报告 — low_flat_limit_up')
    expect(md).toContain('## 一、严格命中 (0只)')
    expect(md).toContain('## 二、近邻候选 (1只')
    expect(md).toContain('600002 样例股份')
    expect(md).toContain('距高点-62.0%✓')
    expect(md).toContain('差在: 放量涨停回落缩量')
    expect(md).toContain('不构成投资建议')
  })

  it('renders a machine-readable json payload', () => {
    const json = renderJson(ctx) as { summary: { hits: number; nearMisses: number }; nearMisses: unknown[]; evaluated: number }
    expect(json.summary).toEqual({ hits: 0, nearMisses: 1, others: 2 })
    expect(json.evaluated).toBe(3)
    expect(json.nearMisses).toHaveLength(1)
  })
})
