/**
 * Shared plumbing for the two industry-stats filters (`industry_clearance`,
 * `industry_position`): the member-floor parameter table they must declare
 * identically (mergedParamDocs dedup requires exact signatures when both
 * gates appear in one predicate) and the no-stats evidence shape.
 * @module a-share-screener/filters/industry-shared
 */
import type { ParamDocs } from '../strategies/registry.js'
import type { DerivedCtx, Evidence } from '../engine/types.js'

/** Parameter table shared by every industry-stats filter. */
export const industrySharedParamDocs: ParamDocs = {
  minIndustryMembers: {
    type: 'number',
    default: 8,
    min: 3,
    max: 100,
    integer: true,
    description: 'Industries with fewer aggregated members do not pass (statistically meaningless).',
  },
}

/**
 * Evidence for a stock whose industry stats are unavailable: no classification
 * on the stock, or the screener ran no aggregation pass (capability-gated
 * strategies never reach that state).
 */
export function noIndustryEvidence(ctx: DerivedCtx, keys: string[]): Evidence {
  const evidence: Evidence = { industry: ctx.stock.industry ?? null }
  for (const key of keys) evidence[key] = null
  return evidence
}
