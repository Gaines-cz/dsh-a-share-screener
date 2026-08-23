import { describe, expect, it } from 'vitest'
import { maxOf, meanVolume, median, round, smaAtIndex } from './math.js'
import type { SeriesBar } from '../types.js'

function bar(volume: number): SeriesBar {
  return { date: '20260101', close: 10, volume, ret: 0 }
}

describe('median', () => {
  it('returns the middle value for an odd-length input', () => {
    expect(median([3, 1, 2])).toBe(2)
  })

  it('averages the two middle values for an even-length input', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('does not mutate its input (sorts a copy)', () => {
    const values = [5, 1, 4, 2, 3]
    median(values)
    expect(values).toEqual([5, 1, 4, 2, 3])
  })
})

describe('existing helpers', () => {
  it('rounds to the given digits', () => {
    expect(round(1.23456, 3)).toBe(1.235)
  })

  it('meanVolume guards an empty range', () => {
    expect(meanVolume([], 0, 5)).toBe(0)
    expect(meanVolume([bar(10), bar(20)], 0, 2)).toBe(15)
  })

  it('smaAtIndex returns null before enough bars', () => {
    const idx = [1, 2, 3, 4]
    expect(smaAtIndex(idx, 4, 2)).toBe(3.5)
    expect(smaAtIndex(idx, 2, 3)).toBeNull()
  })

  it('maxOf handles long arrays without spreading', () => {
    expect(maxOf([1, 5, 3, 9, 2])).toBe(9)
  })
})
