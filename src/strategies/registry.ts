/**
 * Strategy registry: the plugin's extensibility point. A strategy is a pure
 * predicate over one stock's bar series plus a declarative parameter table.
 * Adding a strategy means implementing the interface and registering it — no
 * other code changes.
 * @module a-share-screener/strategies/registry
 */
import type { Board, SeriesBar, StockMeta } from '../types.js'

/** Declarative documentation and validation for one strategy parameter. */
export type ParamDoc = {
  type: 'number' | 'boolean' | 'string'
  default: number | boolean | string
  description: string
  min?: number
  max?: number
  /** Bar-count parameters must be whole numbers; fractional values silently break index math. */
  integer?: boolean
}

export type ParamDocs = Record<string, ParamDoc>

/** A validated parameter bag: defaults merged with caller overrides. */
export type StrategyParams = Record<string, number | boolean | string>

/** Input to one screening pass over one stock. */
export interface StrategyScreenInput {
  stock: StockMeta
  /** Ascending series; `bars[0].ret` may be null. */
  bars: SeriesBar[]
}

/** A strategy match with the quantified evidence that triggered it. */
export interface StrategyHit {
  code: string
  fullCode: string
  name: string
  board: Board
  strategy: string
  evidence: Record<string, number | string | boolean>
}

/**
 * Per-gate diagnosis of one screening pass — powers the CLI's tiered report
 * (严格命中 vs 近邻候选). `matched` is true exactly when `screen()` would
 * return a hit; `gates` is the strategy-specific condition breakdown;
 * `failedGates` lists the gates that did not pass.
 */
export interface StrategyDiagnosis {
  matched: boolean
  gates: Record<string, boolean>
  failedGates: string[]
  /** Quantified metrics behind the gates (same fields as hit evidence; missing metrics are null). */
  metrics: Record<string, number | string | boolean | null>
}

/** A screening strategy: pure function from (stock, series, params) to hit-or-null. */
export interface Strategy {
  readonly id: string
  /** Model-facing one-paragraph description of what it looks for. */
  readonly description: string
  /** Parameter table; also exposed through the a_share_list_strategies tool. */
  readonly paramDocs: ParamDocs
  screen(input: StrategyScreenInput, params: StrategyParams): StrategyHit | null
  /**
   * Optional per-gate diagnosis, used by the CLI to report why a stock did not
   * match (and to surface near-miss candidates). Returns null when the stock
   * cannot be evaluated at all (e.g. too few bars).
   */
  diagnose?(input: StrategyScreenInput, params: StrategyParams): StrategyDiagnosis | null
}

/** Registry with loud failure on duplicate ids, unknown strategies, and bad params. */
export class StrategyRegistry {
  private readonly strategies = new Map<string, Strategy>()

  register(strategy: Strategy): void {
    if (this.strategies.has(strategy.id)) {
      throw new Error(`duplicate strategy id: ${strategy.id}`)
    }
    this.strategies.set(strategy.id, strategy)
  }

  get(id: string): Strategy | undefined {
    return this.strategies.get(id)
  }

  ids(): string[] {
    return [...this.strategies.keys()]
  }

  list(): Strategy[] {
    return [...this.strategies.values()]
  }

  /**
   * Merge defaults with caller overrides, validating types and ranges.
   * Throws with an actionable message listing valid keys on any bad input.
   */
  resolveParams(id: string, raw: unknown): StrategyParams {
    const strategy = this.get(id)
    if (!strategy) {
      throw new Error(`unknown strategy '${id}'. Available: ${this.ids().join(', ')}`)
    }
    const out: StrategyParams = {}
    for (const [key, doc] of Object.entries(strategy.paramDocs)) {
      out[key] = doc.default
    }
    if (raw === undefined || raw === null) return out
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`params for strategy '${id}' must be an object`)
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const doc = strategy.paramDocs[key]
      if (!doc) {
        throw new Error(
          `unknown param '${key}' for strategy '${id}'. Valid params: ${Object.keys(strategy.paramDocs).join(', ')}`,
        )
      }
      if (doc.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(`param '${key}' for strategy '${id}' must be a number`)
        }
        if (doc.integer && !Number.isInteger(value)) {
          throw new Error(`param '${key}' for strategy '${id}' must be an integer`)
        }
        if (doc.min !== undefined && value < doc.min) {
          throw new Error(`param '${key}' for strategy '${id}' must be >= ${doc.min}`)
        }
        if (doc.max !== undefined && value > doc.max) {
          throw new Error(`param '${key}' for strategy '${id}' must be <= ${doc.max}`)
        }
        out[key] = value
      } else if (doc.type === 'boolean') {
        if (typeof value !== 'boolean') {
          throw new Error(`param '${key}' for strategy '${id}' must be a boolean`)
        }
        out[key] = value
      } else {
        if (typeof value !== 'string') {
          throw new Error(`param '${key}' for strategy '${id}' must be a string`)
        }
        out[key] = value
      }
    }
    return out
  }
}
