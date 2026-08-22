/**
 * Atomic filter `flat_base`: the recent window is a flat base — tiny net change
 * on the chained return index and converged moving averages (MA5/10/20/60).
 * @module a-share-screener/filters/flat-base
 */
import { round, smaAtIndex } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

const MA_LENGTHS = [5, 10, 20, 60] as const

export const flatBaseFilter: Filter = {
  id: 'flat_base',
  description:
    'The latest `flatWindowBars` window is flat: net change within `maxFlatRangeChange` and MA5/10/20/60 spread within `maxFlatMaSpread`.',
  paramDocs: {
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
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const fw = params.flatWindowBars as number
    if (ctx.last < fw) {
      return { passed: false, evidence: { flatNetChange: null, flatMaSpread: null } }
    }
    const netChange = Math.abs(ctx.current / ctx.idx[ctx.last - fw]! - 1)
    const mas: number[] = []
    for (const n of MA_LENGTHS) {
      const ma = smaAtIndex(ctx.idx, ctx.bars.length, n)
      if (ma === null) {
        return { passed: false, evidence: { flatNetChange: round(netChange, 4), flatMaSpread: null } }
      }
      mas.push(ma)
    }
    const maSpread = (Math.max(...mas) - Math.min(...mas)) / Math.min(...mas)
    const passed =
      netChange <= (params.maxFlatRangeChange as number) && maSpread <= (params.maxFlatMaSpread as number)
    return { passed, evidence: { flatNetChange: round(netChange, 4), flatMaSpread: round(maSpread, 4) } }
  },
}