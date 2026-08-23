/**
 * Atomic filter `amount_liquidity`: the MEDIAN traded value of the last
 * `liquidityWindowBars` bars is at least `minMedianAmountYi` 亿元 — a
 * liquidity floor that excludes names too thin to trade, without the
 * single-big-day bias a mean would introduce. Requires per-bar amount data
 * (Eastmoney klines carry it; Sina/Tencent do not).
 * @module a-share-screener/filters/amount-liquidity
 */
import { median, round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const amountLiquidityFilter: Filter = {
  id: 'amount_liquidity',
  description:
    'Median daily traded value over the last `liquidityWindowBars` bars >= `minMedianAmountYi` 亿元. ' +
    'Requires an amount-capable source (eastmoney); sina/tencent publish no per-bar traded value.',
  requires: { amount: true },
  paramDocs: {
    liquidityWindowBars: {
      type: 'number',
      default: 20,
      min: 5,
      max: 250,
      integer: true,
      description: 'Bar window for the median traded value.',
    },
    minMedianAmountYi: {
      type: 'number',
      default: 0.3,
      min: 0,
      max: 1000,
      description: 'Minimum median daily traded value in 亿元 (0 = always passes when data exists).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const window = params.liquidityWindowBars as number
    const start = Math.max(0, ctx.bars.length - window)
    const amounts: number[] = []
    for (let i = start; i < ctx.bars.length; i++) {
      const amount = ctx.bars[i]!.amount
      if (amount !== null && amount !== undefined && Number.isFinite(amount) && amount >= 0) amounts.push(amount)
    }
    if (amounts.length === 0) {
      // No amount data at all (non-amount source bypassing the capability
      // gate, or a cache written before amount existed).
      return { passed: false, evidence: { medianAmountYi: null } }
    }
    const medianYi = median(amounts) / 1e8
    const passed = medianYi >= (params.minMedianAmountYi as number)
    return { passed, evidence: { medianAmountYi: round(medianYi, 3) } }
  },
}
