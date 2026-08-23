/**
 * Atomic filter `market_cap_band`: the stock's total market capitalization
 * (list-time snapshot in CNY) lies in [minCapYi, maxCapYi] 亿元; 0 means no
 * bound on that side. Pairs naturally with the listing-age universe filters
 * for new-stock screens.
 * @module a-share-screener/filters/market-cap-band
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const marketCapBandFilter: Filter = {
  id: 'market_cap_band',
  description:
    'Total market cap (list-time snapshot) inside [minCapYi, maxCapYi] 亿元 (0 = no bound on that side). ' +
    'Requires a source whose stock list carries market caps (all shipped sources do).',
  requires: { marketCap: true },
  paramDocs: {
    minCapYi: {
      type: 'number',
      default: 20,
      min: 0,
      max: 100_000,
      description: 'Minimum total market cap in 亿元 (0 = no lower bound).',
    },
    maxCapYi: {
      type: 'number',
      default: 0,
      min: 0,
      max: 1_000_000,
      description: 'Maximum total market cap in 亿元 (0 = no upper bound).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const capYuan = ctx.stock.totalMarketCapYuan
    if (capYuan === undefined || !Number.isFinite(capYuan) || capYuan <= 0) {
      return { passed: false, evidence: { marketCapYi: null } }
    }
    const capYi = capYuan / 1e8
    const min = params.minCapYi as number
    const max = params.maxCapYi as number
    const passed = capYi >= min && (max <= 0 || capYi <= max)
    return { passed, evidence: { marketCapYi: round(capYi, 1) } }
  },
}
