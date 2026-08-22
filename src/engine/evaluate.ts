/**
 * Predicate expression-tree evaluation. `evaluate` walks the whole tree
 * (merged evidence + per-filter gates, powering near-miss reports). Set
 * `shortCircuit` to cut AND/OR branches short once their outcome is decided —
 * used by the strict-match fast path where only the boolean matters.
 * @module a-share-screener/engine/evaluate
 */
import type { StrategyParams } from '../strategies/registry.js'
import type { DerivedCtx, Evidence, FilterRegistry, Predicate, PredicateResult } from './types.js'

export function evaluate(
  predicate: Predicate,
  ctx: DerivedCtx,
  filters: FilterRegistry,
  params: StrategyParams,
  shortCircuit = false,
): PredicateResult {
  switch (predicate.kind) {
    case 'filter': {
      const filter = filters.require(predicate.filter)
      const result = filter.apply(ctx, params)
      return {
        passed: result.passed,
        gates: { [filter.id]: result.passed },
        failed: result.passed ? [] : [filter.id],
        evidence: result.evidence,
      }
    }
    case 'not': {
      const child = evaluate(predicate.child, ctx, filters, params, shortCircuit)
      // The NOT node passes when its child fails; that is not a leaf-gate
      // failure, so the failed list stays empty.
      return { passed: !child.passed, gates: child.gates, failed: [], evidence: child.evidence }
    }
    case 'and': {
      const gates: Record<string, boolean> = {}
      const evidence: Evidence = {}
      const failed: string[] = []
      let passed = true
      for (const child of predicate.children) {
        const result = evaluate(child, ctx, filters, params, shortCircuit)
        Object.assign(gates, result.gates)
        Object.assign(evidence, result.evidence)
        if (!result.passed) {
          passed = false
          failed.push(...result.failed)
          if (shortCircuit) break
        }
      }
      return { passed, gates, evidence, failed }
    }
    case 'or': {
      const gates: Record<string, boolean> = {}
      const evidence: Evidence = {}
      const failed: string[] = []
      let passed = false
      for (const child of predicate.children) {
        const result = evaluate(child, ctx, filters, params, shortCircuit)
        Object.assign(gates, result.gates)
        Object.assign(evidence, result.evidence)
        if (result.passed) {
          passed = true
          if (shortCircuit) break
        } else {
          failed.push(...result.failed)
        }
      }
      // An OR that passes has no "failed gate"; only a fully-failed OR reports them.
      return { passed, gates, evidence, failed: passed ? [] : failed }
    }
  }
}
