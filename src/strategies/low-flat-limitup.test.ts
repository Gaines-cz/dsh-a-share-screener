import { describe, expect, it } from 'vitest'
import { lowFlatLimitUpStrategy } from './low-flat-limitup.js'
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
 * Positive fixture (800 bars):
 * - bars 0..649: geometric decline 10.0 → 2.8 (drawdown ≈ 73%)
 * - bars 650..739: flat base at 2.8 (±0.1%)
 * - bar 740: +10% limit-up on 3.5× volume
 * - bars 741..755: pullback to 2.72 (below the limit-up close)
 * - bars 756..799: flat at 2.72 on 300-lot volume (cooldown)
 */
function positiveFixture(): { closes: number[]; vols: number[] } {
  const closes: number[] = []
  const vols: number[] = []
  for (let i = 0; i <= 649; i++) closes.push(10 * Math.pow(0.28, i / 649))
  for (let i = 650; i <= 739; i++) closes.push(2.8 * (i % 2 === 0 ? 1.001 : 0.999))
  closes.push(closes[739]! * 1.1)
  for (let i = 0; i <= 14; i++) closes.push(3.02 - 0.3 * (i / 14))
  for (let i = 756; i <= 799; i++) closes.push(2.72 * (i % 2 === 0 ? 1.0005 : 0.9995))
  for (let i = 0; i <= 739; i++) vols.push(1000)
  vols.push(3500)
  for (let i = 0; i <= 14; i++) vols.push(1500 - 40 * i)
  for (let i = 756; i <= 799; i++) vols.push(300)
  return { closes, vols }
}

const defaultsRegistry = new StrategyRegistry()
defaultsRegistry.register(lowFlatLimitUpStrategy)
const DEFAULTS: StrategyParams = defaultsRegistry.resolveParams('low_flat_limit_up', undefined)

function screen(closes: number[], vols: number[], overrides: Partial<Record<string, number | boolean | string>> = {}, board = 'main') {
  const params = { ...DEFAULTS, ...overrides } as StrategyParams
  const stock = { ...META, board } as StockMeta
  return lowFlatLimitUpStrategy.screen({ stock, bars: seriesFrom(closes, vols) }, params)
}

describe('low_flat_limit_up positive case', () => {
  it('matches with full evidence', () => {
    const { closes, vols } = positiveFixture()
    const hit = screen(closes, vols)
    expect(hit).not.toBeNull()
    const evidence = hit!.evidence as Record<string, number | string>
    expect(evidence.limitUpDate).toBe(dateFor(740, 800))
    expect(evidence.daysSinceLimitUp).toBe(59)
    expect(evidence.drawdownFromHigh as number).toBeGreaterThan(0.65)
    expect(evidence.percentileInWindow as number).toBeLessThan(0.15)
    expect(evidence.limitUpVolumeSurge as number).toBeGreaterThanOrEqual(2)
    expect(evidence.cooldownVolumeRatio as number).toBeLessThanOrEqual(0.4)
    expect(hit!.code).toBe('600001')
    expect(hit!.strategy).toBe('low_flat_limit_up')
  })
})

describe('low_flat_limit_up negative cases', () => {
  it('rejects when the price is not at a historical low', () => {
    const { closes, vols } = positiveFixture()
    for (let i = 700; i < closes.length; i++) closes[i]! *= 1.8
    expect(screen(closes, vols)).toBeNull()
  })

  it('rejects when the recent window is not flat', () => {
    const { closes, vols } = positiveFixture()
    for (let i = 770; i < closes.length; i++) closes[i] = closes[i - 1]! * 1.006
    expect(screen(closes, vols)).toBeNull()
  })

  it('rejects when the limit-up had no volume surge', () => {
    const { closes, vols } = positiveFixture()
    vols[740] = 1200
    expect(screen(closes, vols)).toBeNull()
  })

  it('rejects when volume never cooled down', () => {
    const { closes, vols } = positiveFixture()
    for (let i = 795; i <= 799; i++) vols[i] = 2000
    expect(screen(closes, vols)).toBeNull()
  })

  it('rejects when the price never pulled back below the limit-up close', () => {
    const { closes, vols } = positiveFixture()
    for (let i = 741; i < closes.length; i++) closes[i] = 3.08
    expect(screen(closes, vols)).toBeNull()
  })

  it('rejects when the limit-up is outside the search window', () => {
    const { closes, vols } = positiveFixture()
    expect(screen(closes, vols, { limitUpWindowBars: 20 })).toBeNull()
  })

  it('rejects a 10% day on the chinext 20% board but matches a 20% day', () => {
    const ten = positiveFixture()
    expect(screen(ten.closes, ten.vols, {}, 'chinext')).toBeNull()
    const twenty = positiveFixture()
    twenty.closes[740] = twenty.closes[739]! * 1.2
    // Steep pullback that settles at the base level quickly, keeping MA60 converged.
    for (let i = 741; i <= 755; i++) twenty.closes[i] = Math.max(2.72, 3.3 - 0.29 * (i - 741))
    expect(screen(twenty.closes, twenty.vols, {}, 'chinext')).not.toBeNull()
  })

  it('rejects series shorter than minBars', () => {
    const { closes, vols } = positiveFixture()
    expect(screen(closes.slice(0, 100), vols.slice(0, 100))).toBeNull()
  })
})

describe('StrategyRegistry params', () => {
  const registry = new StrategyRegistry()
  registry.register(lowFlatLimitUpStrategy)

  it('fills defaults and applies valid overrides', () => {
    const params = registry.resolveParams('low_flat_limit_up', { minVolumeSurge: 3 })
    expect(params.minVolumeSurge).toBe(3)
    expect(params.cooldownBars).toBe(5)
  })

  it('rejects unknown strategies, keys, types, and ranges', () => {
    expect(() => registry.resolveParams('nope', {})).toThrow(/Available:/)
    expect(() => registry.resolveParams('low_flat_limit_up', { nonsense: 1 })).toThrow(/Valid params:/)
    expect(() => registry.resolveParams('low_flat_limit_up', { minVolumeSurge: 'x' })).toThrow(/must be a number/)
    expect(() => registry.resolveParams('low_flat_limit_up', { minVolumeSurge: 0.5 })).toThrow(/>=/)
  })

  it('rejects duplicate registration and non-object params', () => {
    const other = new StrategyRegistry()
    other.register(lowFlatLimitUpStrategy)
    expect(() => other.register(lowFlatLimitUpStrategy)).toThrow(/duplicate/)
    expect(() => other.resolveParams('low_flat_limit_up', [1])).toThrow(/must be an object/)
  })
})
