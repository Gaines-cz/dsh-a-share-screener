/**
 * Composition engine types: atomic filters, the predicate expression tree, and
 * the parameter-independent derived context shared across every filter in one
 * pass. A strategy is a declarative predicate over independent filters, which
 * keeps each filter reusable and makes new combinations trivial to express.
 * @module a-share-screener/engine/types
 */
import type { ParamDocs, StrategyParams } from '../strategies/registry.js'
import type { SeriesBar, StockMeta } from '../types.js'

/** Quantified evidence a filter emits (null when a metric could not be computed). */
export type Evidence = Record<string, number | string | boolean | null>

/** Result of applying one atomic filter to one stock. */
export interface FilterResult {
  passed: boolean
  evidence: Evidence
}

/** An atomic, independently reusable screening condition. */
export interface Filter {
  readonly id: string
  /** One-paragraph description of what the filter looks for. */
  readonly description: string
  /** Declarative parameter table (defaults + ranges), merged into strategy paramDocs. */
  readonly paramDocs: ParamDocs
  apply(ctx: DerivedCtx, params: StrategyParams): FilterResult
}

/** A close-at-limit-up day with its pre-computed volume surge. */
export interface LimitUpDay {
  /** Bar index into `bars` / `idx`. */
  index: number
  date: string
  /** Daily return of the limit-up bar (fraction). */
  ret: number
  /** volume / mean(prior 5 bars) — 0 when the prior average is absent. */
  surge: number
}

/**
 * Parameter-independent quantities derived once per stock and shared by every
 * filter, so each filter is a short pure read over pre-computed data instead of
 * re-scanning the bar series.
 */
export interface DerivedCtx {
  stock: StockMeta
  bars: SeriesBar[]
  /** Chained return index: idx[i] = ∏(1 + ret), immune to ex-rights gaps. */
  idx: number[]
  /** Every close-at-limit-up bar, ordered ascending by index, with volume surge. */
  limitUpDays: LimitUpDay[]
  /** Index of the latest bar. */
  last: number
  /** Chained return index at the latest bar. */
  current: number
}

/** A declarative composition of atomic filters via AND / OR / NOT. */
export type Predicate =
  | { kind: 'filter'; filter: string }
  | { kind: 'and'; children: Predicate[] }
  | { kind: 'or'; children: Predicate[] }
  | { kind: 'not'; child: Predicate }

/** Full-evaluation result: per-filter gates + merged evidence + failed filters. */
export interface PredicateResult {
  passed: boolean
  /** Final truth value of every leaf filter (unaffected by any surrounding NOT). */
  gates: Record<string, boolean>
  /**
   * Leaf filters that failed (drives near-miss reporting, especially for AND trees).
   * Caveat: an AND that fails only through a NOT(child) branch reports no failed
   * leaf — the child's raw failure is not itself a gate failure — so tierResults
   * buckets such stocks into "others" without an explanation.
   */
  failed: string[]
  evidence: Evidence
}

/** Registry with loud failure on duplicate or unknown filter ids. */
export class FilterRegistry {
  private readonly filters = new Map<string, Filter>()

  register(filter: Filter): void {
    if (this.filters.has(filter.id)) throw new Error(`duplicate filter id: ${filter.id}`)
    this.filters.set(filter.id, filter)
  }

  get(id: string): Filter | undefined {
    return this.filters.get(id)
  }

  /** Get a filter or throw with the list of available ids. */
  require(id: string): Filter {
    const filter = this.filters.get(id)
    if (!filter) throw new Error(`unknown filter '${id}'. Available: ${this.ids().join(', ')}`)
    return filter
  }

  ids(): string[] {
    return [...this.filters.keys()]
  }

  list(): Filter[] {
    return [...this.filters.values()]
  }
}
