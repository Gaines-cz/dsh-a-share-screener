/**
 * Atomic filter `industry_position`: the industry board trades at a LOW
 * position in its own range — the median member sits at or below
 * `maxIndustryMedPos` of its ~3-year price distribution. Complements
 * `industry_clearance`: that gate asks how DEEP the fall was (median
 * drawdown-from-high), this one asks WHERE the board sits in its range
 * (median window percentile). A board can be deeply fallen yet still sit in
 * the upper half of its range during a dead-cat bounce, and vice versa.
 * @module a-share-screener/filters/industry-position
 */
import { round } from '../engine/math.js'
import type { DerivedCtx, Filter, FilterResult } from '../engine/types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { industrySharedParamDocs, noIndustryEvidence } from './industry-shared.js'

export const industryPositionFilter: Filter = {
  id: 'industry_position',
  description:
    'The industry board trades at a low position: the median member ranks at or below `maxIndustryMedPos` of its ' +
    'own ~3-year price distribution (median of 730-bar window percentiles), over >= `minIndustryMembers` members. ' +
    'Complements industry_clearance (depth of the fall) with the position in range. Requires industry data.',
  requires: { industry: true },
  paramDocs: {
    ...industrySharedParamDocs,
    maxIndustryMedPos: {
      type: 'number',
      default: 0.35,
      min: 0.05,
      max: 1,
      description: 'Median member must rank at or below this window percentile.',
    },
  },
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult {
    const stats = ctx.industry
    if (stats === undefined) {
      return { passed: false, evidence: noIndustryEvidence(ctx, ['industryMedPos', 'industryMembers']) }
    }
    const passed =
      stats.medPos <= (params.maxIndustryMedPos as number) && stats.members >= (params.minIndustryMembers as number)
    return {
      passed,
      evidence: {
        industry: stats.industry,
        industryMedPos: round(stats.medPos, 4),
        industryMembers: stats.members,
      },
    }
  },
}
