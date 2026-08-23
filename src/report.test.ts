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
    gates: {
      deep_drawdown: true,
      low_percentile: true,
      flat_base: true,
      volume_limit_up: true,
      cooldown_pullback: false,
    },
    failedGates: ['cooldown_pullback'],
    metrics: {
      close: 10,
      drawdownFromHigh: 0.62,
      percentileInWindow: 0.05,
      flatNetChange: 0.03,
      flatMaSpread: 0.02,
      limitUpDate: '20260522',
      limitUpVolumeSurge: 2.6,
      cooldownRefDate: '20260522',
      cooldownVolumeRatio: 0.2,
      daysSinceLimitUp: 60,
      barsAnalyzed: 800,
    },
    ...overrides,
  }
}

describe('report tiering', () => {
  it('splits hits, single-gate near-misses and the rest', () => {
    const allPass = {
      deep_drawdown: true,
      low_percentile: true,
      flat_base: true,
      volume_limit_up: true,
      cooldown_pullback: true,
    }
    const entries: TieredEntry[] = [
      { stock: stock('600001', 'A'), diagnosis: diag({ matched: true, gates: allPass, failedGates: [] }) },
      { stock: stock('600002', 'B'), diagnosis: diag({}) }, // only cooldown_pullback fails
      {
        stock: stock('600003', 'C'),
        diagnosis: diag({
          gates: { deep_drawdown: false, low_percentile: false, flat_base: true, volume_limit_up: true, cooldown_pullback: true },
          failedGates: ['deep_drawdown', 'low_percentile'],
        }),
      },
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

  it('maps filter ids to human labels', () => {
    expect(gateLabel('deep_drawdown')).toBe('距高点回撤')
    expect(gateLabel('volume_limit_up')).toBe('放量涨停')
    expect(gateLabel('cooldown_pullback')).toBe('涨停后回落缩量')
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
    expect(md).toContain('差在: 涨停后回落缩量')
    expect(md).toContain('不构成投资建议')
  })

  it('renders a machine-readable json payload', () => {
    const json = renderJson(ctx) as { summary: { hits: number; nearMisses: number }; nearMisses: unknown[]; evaluated: number }
    expect(json.summary).toEqual({ hits: 0, nearMisses: 1, others: 2 })
    expect(json.evaluated).toBe(3)
    expect(json.nearMisses).toHaveLength(1)
  })

  it('renders null flat-base metrics as "-" instead of 0.0%', () => {
    const nullFlat = diag({ metrics: { ...diag({}).metrics, flatNetChange: null, flatMaSpread: null } })
    const md = renderMarkdown({
      ...ctx,
      tiered: { hits: [], nearMisses: [{ stock: stock('600002', '样例股份'), diagnosis: nullFlat }], others: 0 },
    })
    expect(md).toContain('平台净变动-')
    expect(md).not.toContain('平台净变动0.0%')
  })

  it('renders cooldown ratio as a percentage', () => {
    const md = renderMarkdown(ctx)
    expect(md).toContain('回落缩量20.0%✗')
    expect(md).not.toContain('回落缩量0.2')
  })

  it('flags the cooldown reference day when it differs from the limit-up day', () => {
    const crossDay = diag({
      metrics: { ...diag({}).metrics, cooldownRefDate: '20260301' },
    })
    const md = renderMarkdown({
      ...ctx,
      tiered: { hits: [], nearMisses: [{ stock: stock('600002', '样例股份'), diagnosis: crossDay }], others: 0 },
    })
    expect(md).toContain('回落缩量20.0%@20260301')
  })

  it('renders only the gates a strategy actually has (no phantom ✗ for absent filters)', () => {
    // A flat_base_low hit: only low_percentile + flat_base gates exist.
    const flatLowHit = diag({
      matched: true,
      gates: { low_percentile: true, flat_base: true },
      failedGates: [],
    })
    const md = renderMarkdown({
      ...ctx,
      strategy: 'flat_base_low',
      tiered: { hits: [{ stock: stock('600004', '平底股份'), diagnosis: flatLowHit }], nearMisses: [], others: 0 },
    })
    expect(md).toContain('分位5.0%✓')
    expect(md).toContain('平台净变动3.0%✓')
    // Gates the strategy does not use must not appear as failed.
    expect(md).not.toContain('距高点')
    expect(md).not.toContain('放量涨停')
    expect(md).not.toContain('回落缩量')
    expect(md).not.toContain('✗')
  })

  it('renders the new gate cells (industry position / volume dry-up)', () => {
    const posDiag = diag({
      gates: { industry_position: true, volume_dry_up: false },
      failedGates: ['volume_dry_up'],
      metrics: { close: 5, industry: '光伏设备', industryMedPos: 0.2, industryMembers: 59, dryUpVolumeRatio: 0.18 },
    })
    const md = renderMarkdown({
      ...ctx,
      strategy: 'custom',
      tiered: { hits: [], nearMisses: [{ stock: stock('600009', '位置股份'), diagnosis: posDiag }], others: 0 },
    })
    expect(md).toContain('行业位置光伏设备·中位分位20.0%/59家✓')
    expect(md).toContain('地量18.0%✗')
    expect(md).toContain('差在: 地量')
  })

  it('renders the Phase-2 gate cells (industry clearance / market cap / amount liquidity)', () => {
    const diag2 = diag({
      gates: { industry_clearance: true, market_cap_band: true, amount_liquidity: false },
      failedGates: ['amount_liquidity'],
      metrics: {
        close: 5,
        industry: '光伏设备',
        industryMedDrawdown: 0.5512,
        industryDeepShare: 0.4,
        industryMembers: 22,
        marketCapYi: 85.3,
        medianAmountYi: 0.084,
      },
    })
    const md = renderMarkdown({
      ...ctx,
      strategy: 'custom',
      tiered: { hits: [], nearMisses: [{ stock: stock('600008', '行业股份'), diagnosis: diag2 }], others: 0 },
    })
    expect(md).toContain('行业出清光伏设备·中位回撤55.1%/深跌40.0%/22家✓')
    expect(md).toContain('市值85亿✓')
    expect(md).toContain('日成交额中位0.08亿✗')
    expect(md).toContain('差在: 成交额下限')
  })

  it('renders the Phase-1 gate cells (breakout / MA / volatility / bars-since-low)', () => {
    // A low_flat_breakout near-miss: breakout passed, drawdown + MA failed.
    const breakoutDiag = diag({
      gates: { deep_drawdown: false, platform_breakout: true, ma_stabilization: false },
      failedGates: ['deep_drawdown', 'ma_stabilization'],
      metrics: {
        close: 12.5,
        drawdownFromHigh: 0.4,
        breakoutDate: '20260818',
        breakoutSurge: 3.2,
        barsSinceBreakout: 4,
        baseToClosePct: 0.05,
        maSlope: 0.012,
        closeVsMaPct: -0.008,
        barsAnalyzed: 800,
      },
    })
    const md = renderMarkdown({
      ...ctx,
      strategy: 'low_flat_breakout',
      tiered: { hits: [], nearMisses: [{ stock: stock('600005', '突破股份'), diagnosis: breakoutDiag }], others: 0 },
    })
    expect(md).toContain('距高点-40.0%✗')
    expect(md).toContain('突破20260818(3.2x/4日)✓')
    expect(md).toContain('MA斜率1.2%·离MA-0.8%✗')
    expect(md).toContain('差在: 距高点回撤、均线企稳')
    // A volatility_regime cell renders its annualized percentage.
    const volDiag = diag({
      gates: { volatility_regime: true },
      failedGates: [],
      metrics: { close: 5, annualVol: 0.3412 },
    })
    const volMd = renderMarkdown({
      ...ctx,
      strategy: 'x',
      tiered: { hits: [{ stock: stock('600006', '波动股份'), diagnosis: volDiag }], nearMisses: [], others: 0 },
    })
    expect(volMd).toContain('年化波动34.1%✓')
    // A bars_since_low cell renders days + height-above-low.
    const lowDiag = diag({
      gates: { bars_since_low: true },
      failedGates: [],
      metrics: { close: 5, barsSinceLow: 109, pctAboveLow: 0.08 },
    })
    const lowMd = renderMarkdown({
      ...ctx,
      strategy: 'x',
      tiered: { hits: [{ stock: stock('600007', '磨底股份'), diagnosis: lowDiag }], nearMisses: [], others: 0 },
    })
    expect(lowMd).toContain('距低点109日/8.0%✓')
  })
})
