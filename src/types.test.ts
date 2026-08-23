import { describe, expect, it } from 'vitest'
import { barsToSeries, boardFromCode, exchangeSuffix, fromBarTuple, limitUpThreshold, toBarTuple, toFullCode, type Bar } from './types.js'

function bar(date: string, close: number, preClose: number | null = null, volume = 100, amount?: number): Bar {
  return { date, open: close, high: close, low: close, close, volume, amount: amount ?? null, preClose }
}

describe('boardFromCode', () => {
  it('classifies main, chinext, star, and bse symbols', () => {
    expect(boardFromCode('600519')).toBe('main')
    expect(boardFromCode('000001')).toBe('main')
    expect(boardFromCode('001289')).toBe('main')
    expect(boardFromCode('300750')).toBe('chinext')
    expect(boardFromCode('688981')).toBe('star')
    expect(boardFromCode('830799')).toBe('bse')
    expect(boardFromCode('920001')).toBe('bse')
    expect(boardFromCode('400001')).toBe('bse')
    expect(boardFromCode('12345')).toBeUndefined()
  })

  it('maps exchange suffixes', () => {
    expect(toFullCode('600519')).toBe('600519.SH')
    expect(toFullCode('300750')).toBe('300750.SZ')
    expect(toFullCode('830799')).toBe('830799.BJ')
    expect(exchangeSuffix('000001')).toBe('SZ')
  })
})

describe('barsToSeries', () => {
  it('prefers the published preClose for daily returns', () => {
    const series = barsToSeries([bar('20250101', 10), bar('20250102', 10.5, 10)])
    expect(series[1]!.ret).toBeCloseTo(0.05, 10)
  })

  it('chains consecutive closes when preClose is absent', () => {
    const series = barsToSeries([bar('20250101', 10, null), bar('20250102', 9, null)])
    expect(series[0]!.ret).toBeNull()
    expect(series[1]!.ret).toBeCloseTo(-0.1, 10)
  })

  it('keeps returns correct across a 2-for-1 split via the adjusted preClose', () => {
    // Day before split: close 100. Split day: preClose 50, close 50.5 → +1%, not -49.5%.
    const series = barsToSeries([bar('20250101', 100, 99), bar('20250102', 50.5, 50)])
    expect(series[1]!.ret).toBeCloseTo(0.01, 10)
  })
})

describe('limitUpThreshold', () => {
  it('uses the ±5% band only for main-board ST names', () => {
    expect(limitUpThreshold('main', '民生银行')).toBe(0.098)
    expect(limitUpThreshold('main', 'ST恒久')).toBe(0.048)
    expect(limitUpThreshold('main', '*ST宁科')).toBe(0.048)
    expect(limitUpThreshold('chinext', 'ST华英')).toBe(0.198)
    expect(limitUpThreshold('star', '中芯国际')).toBe(0.198)
    expect(limitUpThreshold('bse', '北交所股')).toBe(0.298)
    // Delisting names trade on the 10% main-board band, not the ST band.
    expect(limitUpThreshold('main', '退市未来')).toBe(0.098)
  })
})

describe('bar tuples (amount column)', () => {
  it('round-trips a bar with amount through the 8-column tuple', () => {
    const bar: Bar = { date: '20260820', open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000, amount: 1.05e9, preClose: 10 }
    const tuple = toBarTuple(bar)
    expect(tuple).toHaveLength(8)
    const back = fromBarTuple(tuple)
    expect(back.amount).toBe(1.05e9)
    expect(back.close).toBe(10.5)
  })

  it('parses legacy 7-column tuples (pre-amount caches) with null amount', () => {
    const legacy = ['20260820', 10, 11, 9.5, 10.5, 1000, 10] as unknown as ReturnType<typeof toBarTuple>
    const back = fromBarTuple(legacy)
    expect(back.amount).toBeNull()
    expect(back.volume).toBe(1000)
  })

  it('carries amount through barsToSeries', () => {
    const series = barsToSeries([bar('20250101', 10, null, 100, 5e8)])
    expect(series[0]!.amount).toBe(5e8)
  })
})
