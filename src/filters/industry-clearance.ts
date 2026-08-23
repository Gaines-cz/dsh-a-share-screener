/**
 * Atomic filter `industry_clearance`: the stock's industry board is itself in
 * deep clearance — the median member sits at least `minIndustryMedDrawdown`
 * below its window high, and at least `minIndustryDeepShare` of members are
 * >= 60% below theirs. Industry statistics are aggregated by the screener's
 * pre-pass over the whole universe; this filter only reads them.
 * @module a-share-screener/filters/industry-clearance
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'

export const industryClearanceFilter: Filter = {
  id: 'industry_clearance',
  description:
    'The industry board is in deep clearance: median member drawdown-from-high >= `minIndustryMedDrawdown` and ' +
    'the share of members >= 60% below their window high is >= `minIndustryDeepShare`, over >= `minIndustryMembers` ' +
    'members. Requires industry data (all shipped sources provide it via the shared stock list).',
  requires: { industry: true },
  paramDocs: {
    minIndustryMedDrawdown: {
      type: 'number',
      default: 0.4,
      min: 0.1,
      max: 0.9,
      description: 'Median drawdown-from-high of the industry must be at least this.',
    },
    minIndustryDeepShare: {
      type: 'number',
      default: 0.25,
      min: 0.05,
      max: 1,
      description: 'Share of the industry\'s members at least 60% below their window high.',
    },
    minIndustryMembers: {
      type: 'number',
      default: 8,
      min: 3,
      max: 100,
      integer: true,
      description: 'Industries with fewer aggregated members do not pass (statistically meaningless).',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const stats = ctx.industry
    if (stats === undefined) {
      // No industry classification for this stock, or the screener ran no
      // aggregation pass (capability-gated strategies never get here).
      return {
        passed: false,
        evidence: { industry: ctx.stock.industry ?? null, industryMedDrawdown: null, industryDeepShare: null, industryMembers: null },
      }
    }
    const passed =
      stats.medDrawdown >= (params.minIndustryMedDrawdown as number) &&
      stats.deepShare >= (params.minIndustryDeepShare as number) &&
      stats.members >= (params.minIndustryMembers as number)
    return {
      passed,
      evidence: {
        industry: stats.industry,
        industryMedDrawdown: round(stats.medDrawdown, 4),
        industryDeepShare: round(stats.deepShare, 4),
        industryMembers: stats.members,
      },
    }
  },
}
