import { describe, expect, it } from 'vitest'
import { barsToSeries, boardFromCode, exchangeSuffix, toFullCode, type Bar } from './types.js'

function bar(date: string, close: number, preClose: number | null = null, volume = 100): Bar {
  return { date, open: close, high: close, low: close, close, volume, preClose }
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
