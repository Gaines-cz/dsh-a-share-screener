/**
 * Strategy `low_flat_limit_up`: historical low + flat base + volume-heavy
 * limit-up within roughly six months followed by a pullback on shrinking
 * volume.
 *
 * All price-level conditions run on a chained return index (not raw closes),
 * so ex-rights events such as splits and dividends cannot fake a crash or a
 * bottom. Each condition's threshold is a validated, overridable parameter.
 * @module a-share-screener/strategies/low-flat-limitup
 */
import { limitUpThreshold, type SeriesBar } from '../types.js'
import type { Strategy, StrategyDiagnosis, StrategyHit, StrategyParams, StrategyScreenInput } from './registry.js'

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Mean volume of bars[start, end). Returns 0 on an empty range. */
function meanVolume(bars: SeriesBar[], start: number, end: number): number {
  let sum = 0
  let count = 0
  for (let i = Math.max(0, start); i < end && i < bars.length; i++) {
    sum += bars[i]!.volume
    count++
  }
  return count === 0 ? 0 : sum / count
}

/** Simple moving average of the return index over the last `n` values ending at `endExclusive`. */
function smaAtIndex(idx: number[], endExclusive: number, n: number): number | null {
  if (endExclusive < n) return null
  let sum = 0
  for (let i = endExclusive - n; i < endExclusive; i++) sum += idx[i]!
  return sum / n
}

/** One gate-by-gate evaluation pass shared by `screen` and `diagnose`. */
export interface LowFlatLimitUpEvaluation {
  ok: boolean
  gates: Record<string, boolean>
  failedGates: string[]
  metrics: Record<string, number | string | boolean | null>
}

/**
 * Evaluate every gate and collect the quantified metrics behind them, so both
 * `screen` (strict match) and `diagnose` (tiered report) share one
 * implementation. Returns null when the stock cannot be evaluated at all (too
 * few bars / flat window unavailable).
 */
export function evaluateLowFlatLimitUp(
  input: StrategyScreenInput,
  params: StrategyParams,
): LowFlatLimitUpEvaluation | null {
  const bars = input.bars
  const minBars = params.minBars as number
  if (bars.length < Math.max(60, minBars)) return null

  // Chained return index: idx[i] = prod(1 + ret), immune to ex-rights gaps.
  const idx: number[] = new Array(bars.length)
  idx[0] = 1
  for (let i = 1; i < bars.length; i++) {
    const ret = bars[i]!.ret
    idx[i] = idx[i - 1]! * (1 + (ret === null ? 0 : ret))
  }
  const last = bars.length - 1
  const current = idx[last]!

  // A. Historical low: deep drawdown from the window high.
  let high = -Infinity
  for (const value of idx) if (value > high) high = value
  const drawdown = 1 - current / high
  const gateDrawdown = drawdown >= (params.minDrawdownFromHigh as number)

  // B. Historical low: bottom of the recent distribution.
  const pw = Math.min(params.percentileWindowBars as number, bars.length)
  let below = 0
  for (let i = bars.length - pw; i < bars.length; i++) {
    if (idx[i]! <= current) below++
  }
  const percentile = below / pw
  const gatePercentile = percentile <= (params.maxPercentile as number)

  // C. Flat base: tiny net change and converged moving averages.
  const fw = params.flatWindowBars as number
  if (last < fw) return null
  const netChange = Math.abs(current / idx[last - fw]! - 1)
  const maLengths = [5, 10, 20, 60]
  const mas: number[] = []
  for (const n of maLengths) {
    const ma = smaAtIndex(idx, bars.length, n)
    if (ma === null) return null
    mas.push(ma)
  }
  const maSpread = (Math.max(...mas) - Math.min(...mas)) / Math.min(...mas)
  const gateFlat = netChange <= (params.maxFlatRangeChange as number) && maSpread <= (params.maxFlatMaSpread as number)

  // D. Volume-heavy limit-up within the window, followed by pullback + cooldown.
  const threshold = limitUpThreshold(input.stock.board, input.stock.name)
  const cooldownBars = params.cooldownBars as number
  const minGap = cooldownBars + 1
  const firstCandidate = Math.max(5, last - (params.limitUpWindowBars as number))
  let limitUp: { date: string; pct: number; surge: number; cooldownRatio: number; daysSince: number } | null = null
  for (let d = last - minGap; d >= firstCandidate; d--) {
    const ret = bars[d]!.ret
    if (ret === null || ret < threshold) continue
    const prevAvg = meanVolume(bars, d - 5, d)
    if (prevAvg <= 0 || bars[d]!.volume < (params.minVolumeSurge as number) * prevAvg) continue
    let pulledBack = false
    for (let e = d + 1; e <= last; e++) {
      if (idx[e]! < idx[d]!) {
        pulledBack = true
        break
      }
    }
    if (!pulledBack) continue
    const cooldownAvg = meanVolume(bars, last - cooldownBars + 1, last + 1)
    if (cooldownAvg > (params.maxCooldownVolumeRatio as number) * bars[d]!.volume) continue
    limitUp = {
      date: bars[d]!.date,
      pct: ret,
      surge: bars[d]!.volume / prevAvg,
      cooldownRatio: cooldownAvg / bars[d]!.volume,
      daysSince: last - d,
    }
    break
  }
  const gateLimitUp = limitUp !== null

  const gates: Record<string, boolean> = {
    drawdown: gateDrawdown,
    percentile: gatePercentile,
    flat: gateFlat,
    limitUp: gateLimitUp,
  }
  const failedGates = Object.entries(gates)
    .filter(([, pass]) => !pass)
    .map(([name]) => name)
  const metrics: Record<string, number | string | boolean | null> = {
    close: bars[last]!.close,
    drawdownFromHigh: round(drawdown, 4),
    percentileInWindow: round(percentile, 4),
    flatNetChange: round(netChange, 4),
    flatMaSpread: round(maSpread, 4),
    limitUpDate: limitUp?.date ?? null,
    limitUpPct: limitUp === null ? null : round(limitUp.pct, 4),
    limitUpVolumeSurge: limitUp === null ? null : round(limitUp.surge, 2),
    cooldownVolumeRatio: limitUp === null ? null : round(limitUp.cooldownRatio, 4),
    daysSinceLimitUp: limitUp?.daysSince ?? null,
    barsAnalyzed: bars.length,
  }
  return { ok: failedGates.length === 0, gates, failedGates, metrics }
}

export const lowFlatLimitUpStrategy: Strategy = {
  id: 'low_flat_limit_up',
  description:
    'Historical low + flat base + faded volume-heavy limit-up: the stock sits deep below its window high ' +
    '(default >= 65% drawdown) and at the bottom of its recent price distribution (default <= 15th percentile ' +
    'of the last ~3 years), the last month is a flat, MA-converged base, and within the last ~6 months there was ' +
    'a volume-heavy limit-up day (default >= 2x the prior 5-day average volume) that pulled back below its ' +
    'closing price while volume cooled off (recent average <= 40% of the limit-up day). Read the evidence fields ' +
    'as quantified facts, not trading signals.',
  paramDocs: {
    minDrawdownFromHigh: {
      type: 'number',
      default: 0.65,
      min: 0.1,
      max: 0.99,
      description: 'Minimum drawdown of the latest price from the window high (fraction).',
    },
    percentileWindowBars: {
      type: 'number',
      default: 730,
      min: 120,
      max: 3000,
      integer: true,
      description: 'Bar count for the historical-low percentile window (~3 years).',
    },
    maxPercentile: {
      type: 'number',
      default: 0.15,
      min: 0.01,
      max: 1,
      description: 'Latest price must rank at or below this percentile of the window.',
    },
    flatWindowBars: {
      type: 'number',
      default: 30,
      min: 10,
      max: 250,
      integer: true,
      description: 'Bar count for the flat-base window.',
    },
    maxFlatRangeChange: {
      type: 'number',
      default: 0.08,
      min: 0.005,
      max: 0.5,
      description: 'Max absolute net change of the return index over the flat window.',
    },
    maxFlatMaSpread: {
      type: 'number',
      default: 0.03,
      min: 0.002,
      max: 0.3,
      description: 'Max relative spread between MA5/MA10/MA20/MA60 of the return index at the latest bar.',
    },
    limitUpWindowBars: {
      type: 'number',
      default: 120,
      min: 20,
      max: 500,
      integer: true,
      description: 'Bars back to search for the volume-heavy limit-up day (~6 months).',
    },
    minVolumeSurge: {
      type: 'number',
      default: 2,
      min: 1.1,
      max: 20,
      description: 'Limit-up day volume must be at least this multiple of the prior 5-bar average volume.',
    },
    maxCooldownVolumeRatio: {
      type: 'number',
      default: 0.4,
      min: 0.05,
      max: 1.5,
      description: 'Recent average volume must be at most this fraction of the limit-up day volume.',
    },
    cooldownBars: {
      type: 'number',
      default: 5,
      min: 3,
      max: 30,
      integer: true,
      description: 'Bar count for the recent (cooldown) volume average.',
    },
    minBars: {
      type: 'number',
      default: 240,
      min: 60,
      max: 3000,
      integer: true,
      description: 'Minimum bar count to evaluate a stock at all.',
    },
  },

  screen(input: StrategyScreenInput, params: StrategyParams): StrategyHit | null {
    const ev = evaluateLowFlatLimitUp(input, params)
    if (ev === null || !ev.ok) return null
    // A strict match implies the limit-up gate passed, so no metric is null.
    return {
      code: input.stock.code,
      fullCode: input.stock.fullCode,
      name: input.stock.name,
      board: input.stock.board,
      strategy: lowFlatLimitUpStrategy.id,
      evidence: ev.metrics as Record<string, number | string | boolean>,
    }
  },

  diagnose(input: StrategyScreenInput, params: StrategyParams): StrategyDiagnosis | null {
    const ev = evaluateLowFlatLimitUp(input, params)
    if (ev === null) return null
    return { matched: ev.ok, gates: ev.gates, failedGates: ev.failedGates, metrics: ev.metrics }
  },
}
