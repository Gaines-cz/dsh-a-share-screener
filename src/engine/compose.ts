/**
 * Strategy composition: turn a declarative predicate over atomic filters into a
 * full {@link Strategy} (screen + diagnose). One `derive` pass per stock feeds
 * every filter; `screen` short-circuits for the strict-hit path while
 * `diagnose` evaluates the whole tree for per-gate reporting.
 * @module a-share-screener/engine/compose
 */
import type {
  ParamDoc,
  ParamDocs,
  Strategy,
  StrategyDiagnosis,
  StrategyHit,
  StrategyParams,
  StrategyScreenInput,
} from '../strategies/registry.js'
import { derive } from './derive.js'
import { evaluate } from './evaluate.js'
import type { FilterRegistry, Predicate } from './types.js'
import type { DataRequirements } from '../datasources/types.js'

export interface ComposeOptions {
  id: string
  description: string
  /** Declarative composition of atomic filters (AND / OR / NOT tree). */
  predicate: Predicate
  /** Registry holding every filter referenced by `predicate`. */
  filters: FilterRegistry
  /** Strategy-level params merged after every filter param (e.g. `minBars`). */
  extraParamDocs?: ParamDocs
  /**
   * Return false when a stock cannot be evaluated at all; `screen`/`diagnose`
   * then return null (unevaluated). Defaults to always evaluable.
   */
  canEvaluate?: (input: StrategyScreenInput, params: StrategyParams) => boolean
}

/** Collect the leaf filter ids referenced by a predicate. */
function leafFilterIds(predicate: Predicate, out: Set<string>): void {
  switch (predicate.kind) {
    case 'filter':
      out.add(predicate.filter)
      break
    case 'and':
    case 'or':
      for (const child of predicate.children) leafFilterIds(child, out)
      break
    case 'not':
      leafFilterIds(predicate.child, out)
      break
  }
}

/** Order-independent serialization of a param doc (key insertion order may differ). */
function stableParamDoc(doc: ParamDoc): string {
  return JSON.stringify(doc, Object.keys(doc).sort())
}

function sameDoc(a: ParamDoc, b: ParamDoc): boolean {
  return stableParamDoc(a) === stableParamDoc(b)
}

/**
 * Merge every referenced filter's parameter table plus strategy-level extras.
 * Identical declarations (e.g. two filters sharing the same search window) are
 * deduplicated; conflicting declarations on the same key fail loudly.
 */
export function mergedParamDocs(predicate: Predicate, filters: FilterRegistry, extra: ParamDocs = {}): ParamDocs {
  const ids = new Set<string>()
  leafFilterIds(predicate, ids)
  const out: ParamDocs = {}
  const merge = (key: string, doc: ParamDoc): void => {
    const existing = out[key]
    if (existing === undefined) {
      out[key] = doc
      return
    }
    if (!sameDoc(existing, doc)) {
      throw new Error(`param collision '${key}': two filters declare it with different signatures`)
    }
  }
  for (const id of ids) {
    for (const [key, doc] of Object.entries(filters.require(id).paramDocs)) merge(key, doc)
  }
  for (const [key, doc] of Object.entries(extra)) merge(key, doc)
  return out
}

/** Union of the data requirements declared by every leaf filter in the tree. */
function mergedRequirements(predicate: Predicate, filters: FilterRegistry): DataRequirements | undefined {
  const ids = new Set<string>()
  leafFilterIds(predicate, ids)
  let industry = false
  let marketCap = false
  let amount = false
  for (const id of ids) {
    const filterReq = filters.require(id).requires
    if (!filterReq) continue
    industry = industry || filterReq.industry === true
    marketCap = marketCap || filterReq.marketCap === true
    amount = amount || filterReq.amount === true
  }
  if (!industry && !marketCap && !amount) return undefined
  // Build only the declared flags, never explicit-undefined keys.
  const req: { industry?: boolean; marketCap?: boolean; amount?: boolean } = {}
  if (industry) req.industry = true
  if (marketCap) req.marketCap = true
  if (amount) req.amount = true
  return req
}

/** Drop null-valued evidence entries so hit evidence stays strictly typed. */
function sanitizeEvidence(evidence: Record<string, number | string | boolean | null>): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {}
  for (const [key, value] of Object.entries(evidence)) {
    if (value !== null) out[key] = value
  }
  return out
}

/** Compose a predicate over atomic filters into a fully-featured Strategy. */
export function composeStrategy(opts: ComposeOptions): Strategy {
  const paramDocs = mergedParamDocs(opts.predicate, opts.filters, opts.extraParamDocs)
  const canEvaluate = opts.canEvaluate ?? (() => true)
  const requires = mergedRequirements(opts.predicate, opts.filters)

  return {
    id: opts.id,
    description: opts.description,
    paramDocs,
    requires,

    screen(input: StrategyScreenInput, params: StrategyParams): StrategyHit | null {
      if (!canEvaluate(input, params)) return null
      const ctx = derive(input.stock, input.bars)
      ctx.industry = input.industryStats
      const result = evaluate(opts.predicate, ctx, opts.filters, params, true)
      if (!result.passed) return null
      // For an all-AND strategy a strict match means every leaf filter passed
      // with non-null evidence, so the sanitized cast is lossless. OR/NOT trees
      // can pass while some leaves hold null evidence (short-circuited
      // siblings, or a NOT over a failing child) — those nulls are dropped
      // here so hit evidence keeps its non-null type.
      const evidence = sanitizeEvidence(result.evidence)
      evidence.close = ctx.bars[ctx.last]!.close
      evidence.barsAnalyzed = ctx.bars.length
      return {
        code: input.stock.code,
        fullCode: input.stock.fullCode,
        name: input.stock.name,
        board: input.stock.board,
        strategy: opts.id,
        evidence,
      }
    },

    diagnose(input: StrategyScreenInput, params: StrategyParams): StrategyDiagnosis | null {
      if (!canEvaluate(input, params)) return null
      const ctx = derive(input.stock, input.bars)
      ctx.industry = input.industryStats
      const result = evaluate(opts.predicate, ctx, opts.filters, params, false)
      const metrics = { ...result.evidence, close: ctx.bars[ctx.last]!.close, barsAnalyzed: ctx.bars.length }
      return { matched: result.passed, gates: result.gates, failedGates: result.failed, metrics }
    },
  }
}
