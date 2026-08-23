/**
 * Atomic filter `volatility_regime`: the annualized realized volatility of
 * daily returns over `volWindow` bars sits inside [minAnnualVol, maxAnnualVol].
 * A two-sided elasticity gate: the lower bound drops dead stocks (no
 * elasticity left), the upper bound drops blown-off mania tails.
 * @module a-share-screener/filters/volatility-regime
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

/** Trading days per year used for annualizing daily volatility. */
const TRADING_DAYS = 252

export const volatilityRegimeFilter: Filter = {
  id: 'volatility_regime',
  description:
    'Annualized realized volatility (sample stdev of daily returns over the last `volWindow` bars × √252) must ' +
    'lie in [minAnnualVol, maxAnnualVol]. Null ret bars (first bar of a series) are skipped.',
  paramDocs: {
    volWindow: {
      type: 'number',
      default: 60,
      min: 20,
      max: 250,
      integer: true,
      description: 'Bar window for realized volatility.',
    },
    minAnnualVol: {
      type: 'number',
      default: 0.15,
      min: 0.01,
      max: 3,
      description: 'Minimum annualized realized volatility (drops dead stocks).',
    },
    maxAnnualVol: {
      type: 'number',
      default: 0.8,
      min: 0.05,
      max: 5,
      description: 'Maximum annualized realized volatility (drops blown-off mania tails).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const window = params.volWindow as number
    const start = Math.max(0, ctx.bars.length - window)
    // Collect daily returns, skipping null (first-bar) entries.
    let sum = 0
    let count = 0
    for (let i = start; i < ctx.bars.length; i++) {
      const ret = ctx.bars[i]!.ret
      if (ret === null) continue
      sum += ret
      count++
    }
    if (count < 2) return { passed: false, evidence: { annualVol: null } }
    const mean = sum / count
    let sq = 0
    for (let i = start; i < ctx.bars.length; i++) {
      const ret = ctx.bars[i]!.ret
      if (ret === null) continue
      sq += (ret - mean) ** 2
    }
    // Sample stdev (n-1) — the standard realized-vol estimator.
    const stdev = Math.sqrt(sq / (count - 1))
    const annualVol = stdev * Math.sqrt(TRADING_DAYS)
    const passed = annualVol >= (params.minAnnualVol as number) && annualVol <= (params.maxAnnualVol as number)
    return { passed, evidence: { annualVol: round(annualVol, 4) } }
  },
}
