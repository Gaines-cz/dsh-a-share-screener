import { describe, expect, it } from 'vitest'
import { lowFlatBreakoutStrategy } from './low-flat-breakout.js'
import { StrategyRegistry, type StrategyParams } from './registry.js'
import type { SeriesBar, StockMeta } from '../types.js'

const META: StockMeta = {
  code: '600001',
  fullCode: '600001.SH',
  name: 'FixtureStock',
  board: 'main',
  listDate: '20100101',
}

function ymd(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

/** Bar dates with the LAST bar on today, so cache-freshness logic sees a fresh tail. */
function dateFor(index: number, total: number): string {
  const date = new Date()
  date.setDate(date.getDate() - (total - 1 - index))
  return ymd(date)
}

function seriesFrom(closes: number[], vols: number[]): SeriesBar[] {
  return closes.map((close, i) => ({
    date: dateFor(i, closes.length),
    close,
    volume: vols[i]!,
    ret: i === 0 ? null : close / closes[i - 1]! - 1,
  }))
}

/**
 * Positive fixture (800 bars): decline 10 → base, long flat base, a
 * volume-heavy +6% breakout 10 bars before the end, held flat since. The base
 * level derives from `highToBase` so shallow variants stay continuous.
 */
function breakoutBottomFixture(highToBase = 0.28): { closes: number[]; vols: number[] } {
  const base = 10 * highToBase
  const closes: number[] = []
  const vols: number[] = []
  for (let i = 0; i <= 649; i++) closes.push(10 * Math.pow(highToBase, i / 649))
  for (let i = 650; i <= 788; i++) closes.push(base * (i % 2 === 0 ? 1.001 : 0.999))
  closes.push(base * 1.06) // 789: breakout close, +6% over the wiggle base
  for (let i = 790; i <= 799; i++) closes.push(base * 1.06)
  for (let i = 0; i <= 799; i++) vols.push(i === 789 ? 3000 : 1000)
  return { closes, vols }
}

const defaultsRegistry = new StrategyRegistry()
defaultsRegistry.register(lowFlatBreakoutStrategy)
const DEFAULTS: StrategyParams = defaultsRegistry.resolveParams('low_flat_breakout', undefined)

function screen(
  closes: number[],
  vols: number[],
  overrides: Partial<Record<string, number | boolean | string>> = {},
) {
  const params = { ...DEFAULTS, ...overrides } as StrategyParams
  return lowFlatBreakoutStrategy.screen({ stock: META, bars: seriesFrom(closes, vols) }, params)
}

function diagnose(closes: number[], vols: number[]) {
  return lowFlatBreakoutStrategy.diagnose!({ stock: META, bars: seriesFrom(closes, vols) }, DEFAULTS)
}

describe('low_flat_breakout positive case', () => {
  it('matches a bottom flat base with a held volume breakout and stabilized MA', () => {
    const { closes, vols } = breakoutBottomFixture()
    const hit = screen(closes, vols)
    expect(hit).not.toBeNull()
    const evidence = hit!.evidence as Record<string, number | string>
    expect(hit!.strategy).toBe('low_flat_breakout')
    expect(evidence.drawdownFromHigh as number).toBeGreaterThanOrEqual(0.65)
    expect(evidence.breakoutSurge).toBe(3)
    expect(evidence.barsSinceBreakout).toBe(10)
    expect(evidence.maSlope as number).toBeGreaterThanOrEqual(0)
    expect(evidence.closeVsMaPct as number).toBeGreaterThanOrEqual(0)
    expect(evidence.barsAnalyzed).toBe(800)
  })

  it('evaluates at the minBars boundary (240 bars) but not below it', () => {
    // 240-bar variant: decline 0..159, base 160..228, breakout 229, hold 230..239.
    const closes: number[] = []
    const vols: number[] = []
    for (let i = 0; i <= 159; i++) closes.push(10 * Math.pow(0.28, i / 159))
    for (let i = 160; i <= 228; i++) closes.push(2.8 * (i % 2 === 0 ? 1.001 : 0.999))
    closes.push(2.8 * 1.06) // 229: breakout, 10 bars before the last (239)
    for (let i = 230; i <= 239; i++) closes.push(2.8 * 1.06)
    for (let i = 0; i <= 239; i++) vols.push(i === 229 ? 3000 : 1000)

    expect(screen(closes, vols)).not.toBeNull()
    // One bar short of minBars: unevaluated (null), not a failed-gate diagnosis.
    expect(screen(closes.slice(1), vols.slice(1))).toBeNull()
    expect(diagnose(closes.slice(1), vols.slice(1))).toBeNull()
  })
})

describe('low_flat_breakout negative cases', () => {
  it('rejects a still-declining stock (no base, no breakout, falling MA)', () => {
    const closes: number[] = []
    for (let i = 0; i <= 799; i++) closes.push(10 * Math.pow(0.28, i / 799))
    const vols = Array.from({ length: 800 }, () => 1000)
    expect(screen(closes, vols)).toBeNull()
    const diag = diagnose(closes, vols)!
    expect(diag.failedGates).toContain('platform_breakout')
    expect(diag.failedGates).toContain('ma_stabilization')
    expect(diag.failedGates).not.toContain('deep_drawdown')
  })

  it('rejects a shallow-drawdown breakout (position gate fails, shape gates pass)', () => {
    // Decline only to 6 (40% drawdown) before the same base + breakout shape.
    const { closes, vols } = breakoutBottomFixture(0.6)
    expect(screen(closes, vols)).toBeNull()
    const diag = diagnose(closes, vols)!
    expect(diag.failedGates).toEqual(['deep_drawdown'])
    expect(diag.gates.platform_breakout).toBe(true)
    expect(diag.gates.ma_stabilization).toBe(true)
  })

  it('rejects when the breakout falls back into the base', () => {
    const { closes, vols } = breakoutBottomFixture()
    // Round-trip the last bar back below the base high.
    closes[799] = closes[799]! * 0.92
    expect(screen(closes, vols)).toBeNull()
    const diag = diagnose(closes, vols)!
    expect(diag.failedGates).toContain('platform_breakout')
  })
})

describe('low_flat_breakout registration', () => {
  it('exposes the merged drawdown + breakout + MA params plus minBars', () => {
    const keys = Object.keys(DEFAULTS).sort()
    expect(keys).toEqual(
      [
        'baseWindowBars',
        'breakoutWindowBars',
        'maSlopeBars',
        'maStabWindow',
        'maxBaseGiveback',
        'maxBaseRangeChange',
        'minBars',
        'minBarsAfterBreakout',
        'minBreakoutMargin',
        'minBreakoutSurge',
        'minDrawdownFromHigh',
        'minMaSlope',
        'requireCloseAboveMa',
      ].sort(),
    )
  })
})
