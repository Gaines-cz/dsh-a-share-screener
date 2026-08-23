import { describe, expect, it } from 'vitest'
import { flatBaseLowStrategy } from './flat-base-low.js'
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

function seriesFrom(closes: number[], vols: number[], total?: number): SeriesBar[] {
  return closes.map((close, i) => ({
    date: dateFor(i, total ?? closes.length),
    close,
    volume: vols[i]!,
    ret: i === 0 ? null : close / closes[i - 1]! - 1,
  }))
}

/**
 * Positive fixture (800 bars): decline 10 → 2.8, flat base at 2.8, mild dip to
 * 2.72, flat at 2.72 — a bottom consolidation with no limit-up shape.
 */
function bottomFlatFixture(): { closes: number[]; vols: number[] } {
  const closes: number[] = []
  const vols: number[] = []
  for (let i = 0; i <= 649; i++) closes.push(10 * Math.pow(0.28, i / 649))
  for (let i = 650; i <= 739; i++) closes.push(2.8 * (i % 2 === 0 ? 1.001 : 0.999))
  for (let i = 0; i <= 14; i++) closes.push(2.8 - 0.08 * (i / 14))
  for (let i = 755; i <= 799; i++) closes.push(2.72 * (i % 2 === 0 ? 1.0005 : 0.9995))
  for (let i = 0; i <= 799; i++) vols.push(1000)
  return { closes, vols }
}

const defaultsRegistry = new StrategyRegistry()
defaultsRegistry.register(flatBaseLowStrategy)
const DEFAULTS: StrategyParams = defaultsRegistry.resolveParams('flat_base_low', undefined)

function screen(
  closes: number[],
  vols: number[],
  overrides: Partial<Record<string, number | boolean | string>> = {},
  board = 'main',
) {
  const params = { ...DEFAULTS, ...overrides } as StrategyParams
  const stock = { ...META, board } as StockMeta
  return flatBaseLowStrategy.screen({ stock, bars: seriesFrom(closes, vols) }, params)
}

function diagnose(closes: number[], vols: number[]) {
  return flatBaseLowStrategy.diagnose!({ stock: META, bars: seriesFrom(closes, vols) }, DEFAULTS)
}

describe('flat_base_low positive case', () => {
  it('matches a bottom flat base with full evidence', () => {
    const { closes, vols } = bottomFlatFixture()
    const hit = screen(closes, vols)
    expect(hit).not.toBeNull()
    const evidence = hit!.evidence as Record<string, number | string>
    expect(hit!.strategy).toBe('flat_base_low')
    expect(evidence.percentileInWindow as number).toBeLessThanOrEqual(0.15)
    expect(evidence.flatNetChange as number).toBeLessThanOrEqual(0.08)
    expect(evidence.flatMaSpread as number).toBeLessThanOrEqual(0.03)
    expect(evidence.barsAnalyzed).toBe(800)
  })

  it('evaluates at the minBars boundary (240 bars) but not below it', () => {
    // 240-bar variant: decline 0..159, flat 2.8 160..209, dip 210..214, flat 2.72 215..239.
    const closes: number[] = []
    const vols: number[] = []
    for (let i = 0; i <= 159; i++) closes.push(10 * Math.pow(0.28, i / 159))
    for (let i = 160; i <= 209; i++) closes.push(2.8 * (i % 2 === 0 ? 1.001 : 0.999))
    for (let i = 0; i <= 4; i++) closes.push(2.8 - 0.08 * (i / 4))
    for (let i = 215; i <= 239; i++) closes.push(2.72 * (i % 2 === 0 ? 1.0005 : 0.9995))
    for (let i = 0; i <= 239; i++) vols.push(1000)

    expect(screen(closes, vols)).not.toBeNull()
    // One bar short of minBars: unevaluated (null), not a failed-gate diagnosis.
    expect(screen(closes.slice(1), vols.slice(1))).toBeNull()
    expect(diagnose(closes.slice(1), vols.slice(1))).toBeNull()
  })
})

describe('flat_base_low negative cases', () => {
  it('rejects when the price is not at a historical low', () => {
    const { closes, vols } = bottomFlatFixture()
    for (let i = 700; i < closes.length; i++) closes[i]! *= 1.8
    expect(screen(closes, vols)).toBeNull()
    const diag = diagnose(closes, vols)!
    expect(diag.failedGates).toContain('low_percentile')
    expect(diag.failedGates).not.toContain('flat_base')
  })

  it('rejects when the base is not flat (trending tail)', () => {
    const { closes, vols } = bottomFlatFixture()
    // -0.5%/bar over the last 30 bars: net change ~14% > 8% breaks flatness,
    // while the price only goes lower so the percentile gate keeps passing.
    for (let i = 770; i < closes.length; i++) closes[i]! *= Math.pow(0.995, i - 769)
    expect(screen(closes, vols)).toBeNull()
    const diag = diagnose(closes, vols)!
    expect(diag.failedGates).toEqual(['flat_base'])
  })
})

describe('flat_base_low registration', () => {
  it('exposes the merged flat-base + percentile params plus minBars', () => {
    const keys = Object.keys(DEFAULTS).sort()
    expect(keys).toEqual(
      [
        'flatWindowBars',
        'maxFlatMaSpread',
        'maxFlatRangeChange',
        'maxPercentile',
        'minBars',
        'percentileWindowBars',
      ].sort(),
    )
  })
})
