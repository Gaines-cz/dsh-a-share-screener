/**
 * Atomic filter `turnover_band`: the median daily turnover rate over the last
 * `turnoverWindowBars` bars sits inside [minTurnoverPct, maxTurnoverPct]
 * (percent of free-float shares traded). Turnover is derived from volume
 * (lots), close, and the list-time free-float market cap — so unlike
 * `amount_liquidity` it needs no per-bar traded value and runs on every
 * shipped source. A low floor keeps out illiquid names; an upper bound keeps
 * out blown-off turnover spikes.
 * @module a-share-screener/filters/turnover-band
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

/** Shares per lot (手). */
const SHARES_PER_LOT = 100

export const turnoverBandFilter: Filter = {
  id: 'turnover_band',
  description:
    'Median daily turnover rate (shares traded / free-float shares, from volume × 100 / (floatMarketCap / close)) ' +
    'over the last `turnoverWindowBars` bars inside [minTurnoverPct, maxTurnoverPct] percent (0 = no bound on ' +
    'that side). Requires a source whose list carries the free-float market cap (all shipped sources do).',
  requires: { marketCap: true },
  paramDocs: {
    turnoverWindowBars: {
      type: 'number',
      default: 20,
      min: 5,
      max: 250,
      integer: true,
      description: 'Bar window for the median turnover rate.',
    },
    minTurnoverPct: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 100,
      description: 'Minimum median daily turnover in percent.',
    },
    maxTurnoverPct: {
      type: 'number',
      default: 0,
      min: 0,
      max: 100,
      description: 'Maximum median daily turnover in percent (0 = no upper bound).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const floatCapYuan = ctx.stock.floatMarketCapYuan
    const currentClose = ctx.bars[ctx.last]!.close
    if (floatCapYuan === undefined || !Number.isFinite(floatCapYuan) || floatCapYuan <= 0 || currentClose <= 0) {
      return { passed: false, evidence: { medianTurnoverPct: null } }
    }
    // Free-float shares derived from the list-time snapshot cap and today's
    // close: floatShares ≈ floatCap / close.
    const floatShares = floatCapYuan / currentClose
    if (!Number.isFinite(floatShares) || floatShares <= 0) {
      return { passed: false, evidence: { medianTurnoverPct: null } }
    }
    const window = params.turnoverWindowBars as number
    const start = Math.max(0, ctx.bars.length - window)
    const turnovers: number[] = []
    for (let i = start; i < ctx.bars.length; i++) {
      const bar = ctx.bars[i]!
      if (bar.close <= 0) continue
      // turnover = volume(lots) × 100 shares/lot / floatShares.
      turnovers.push((bar.volume * SHARES_PER_LOT) / floatShares)
    }
    if (turnovers.length === 0) return { passed: false, evidence: { medianTurnoverPct: null } }
    turnovers.sort((a, b) => a - b)
    const mid = Math.floor(turnovers.length / 2)
    const median = turnovers.length % 2 === 1 ? turnovers[mid]! : (turnovers[mid - 1]! + turnovers[mid]!) / 2
    const medianPct = median * 100
    const min = params.minTurnoverPct as number
    const max = params.maxTurnoverPct as number
    const passed = medianPct >= min && (max <= 0 || medianPct <= max)
    return { passed, evidence: { medianTurnoverPct: round(medianPct, 3) } }
  },
}
