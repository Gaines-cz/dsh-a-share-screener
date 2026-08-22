/**
 * Small numeric helpers shared by the composition engine and filters.
 * @module a-share-screener/engine/math
 */
import type { SeriesBar } from '../types.js'

export function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Mean volume of bars[start, end). Returns 0 on an empty range. */
export function meanVolume(bars: SeriesBar[], start: number, end: number): number {
  let sum = 0
  let count = 0
  for (let i = Math.max(0, start); i < end && i < bars.length; i++) {
    sum += bars[i]!.volume
    count++
  }
  return count === 0 ? 0 : sum / count
}

/** Simple moving average of the return index over the last `n` values ending at `endExclusive`. */
export function smaAtIndex(idx: number[], endExclusive: number, n: number): number | null {
  if (endExclusive < n) return null
  let sum = 0
  for (let i = endExclusive - n; i < endExclusive; i++) sum += idx[i]!
  return sum / n
}

/** Maximum of a numeric array (unlike Math.max(...spread), safe for long series). */
export function maxOf(values: number[]): number {
  let max = -Infinity
  for (const value of values) if (value > max) max = value
  return max
}