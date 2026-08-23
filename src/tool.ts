/**
 * Model-facing tools: `a_share_screen` (full market scan),
 * `a_share_list_strategies` (strategy discovery), and `a_share_list_filters`
 * (atomic-filter discovery).
 * @module a-share-screener/tool
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DataSource } from './datasources/index.js'
import type { FilterRegistry, Predicate } from './engine/types.js'
import { composeStrategy } from './engine/compose.js'
import type { ScreenResultView, ScreenerConfig, ScreenerHost } from './screener.js'
import { runScreen } from './screener.js'
import { StrategyRegistry } from './strategies/registry.js'

interface ToolDeps {
  host: ScreenerHost
  config: ScreenerConfig
  dataSource: DataSource
  registry: StrategyRegistry
  filters: FilterRegistry
}

/** Ad-hoc strategy id for predicate-driven scans (rendered, not user-facing). */
const CUSTOM_ID = 'custom'

/** Max nesting of { all | any | not } groups in a caller-supplied predicate. */
const MAX_PREDICATE_DEPTH = 3
/** Max total leaf filters in a caller-supplied predicate. */
const MAX_PREDICATE_LEAVES = 12

interface Counters {
  leaves: number
}

/** Validate and convert the JSON predicate DSL into an engine Predicate. Throws loudly. */
export function toPredicate(raw: unknown, filters: FilterRegistry, depth = 0, counters: Counters = { leaves: 0 }): Predicate {
  if (typeof raw === 'string') {
    filters.require(raw) // throws with the available ids when unknown
    counters.leaves++
    if (counters.leaves > MAX_PREDICATE_LEAVES) {
      throw new Error(`predicate uses more than ${MAX_PREDICATE_LEAVES} leaf filters`)
    }
    return { kind: 'filter', filter: raw }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('predicate node must be a filter id (string) or a group object { all | any | not }')
  }
  if (depth >= MAX_PREDICATE_DEPTH) {
    throw new Error(`predicate groups nest deeper than ${MAX_PREDICATE_DEPTH} levels`)
  }
  const group = raw as { all?: unknown; any?: unknown; not?: unknown }
  const provided = (['all', 'any', 'not'] as const).filter((key) => group[key] !== undefined)
  if (provided.length === 0) {
    throw new Error("predicate group must contain exactly one of 'all', 'any', 'not'")
  }
  if (provided.length > 1) {
    throw new Error(`predicate group must contain only ONE of 'all'/'any'/'not', got ${provided.join('+')}`)
  }
  const key = provided[0]!
  if (key === 'not') {
    return { kind: 'not', child: toPredicate(group.not, filters, depth + 1, counters) }
  }
  const kind = key === 'all' ? 'and' : 'or'
  const list = group[key]
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`predicate '${key}' must be a non-empty array of nodes`)
  }
  return { kind, children: list.map((child) => toPredicate(child, filters, depth + 1, counters)) }
}

/** One-line summary of a DSL predicate for display, e.g. "a AND b OR c". */
function summarizePredicate(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === null || typeof raw !== 'object') return '?'
  const group = raw as { all?: unknown; any?: unknown; not?: unknown }
  if (group.not !== undefined) return `NOT(${summarizePredicate(group.not)})`
  if (group.all !== undefined) return (group.all as unknown[]).map(summarizePredicate).join(' AND ')
  if (group.any !== undefined) return (group.any as unknown[]).map(summarizePredicate).join(' OR ')
  return '?'
}

/**
 * Build the throwaway registry holding the ad-hoc custom strategy for a
 * predicate scan. Parameters resolve against the merged filter param docs
 * exactly like a shipped strategy, so `params` overrides work unchanged.
 * `summary` is the human-readable rendering of the RAW DSL (the engine
 * Predicate has no all/any/not shape to summarize).
 */
function customRegistry(deps: ToolDeps, predicate: Predicate, summary: string): StrategyRegistry {
  const strategy = composeStrategy({
    id: CUSTOM_ID,
    description: `Ad-hoc composition: ${summary}`,
    predicate,
    filters: deps.filters,
    extraParamDocs: {
      minBars: {
        type: 'number',
        default: 240,
        min: 60,
        max: 3000,
        integer: true,
        description: 'Minimum bar count to evaluate a stock at all (~1 trading year).',
      },
    },
    // Generic bound: per-filter window needs are handled by the filters
    // themselves (short windows fail with null evidence, not crashes).
    canEvaluate: (input, params) => input.bars.length >= Math.max(60, params.minBars as number),
  })
  const registry = new StrategyRegistry()
  registry.register(strategy)
  return registry
}

/** Human/model-readable text report from a canonical scan result. */
function renderReport(value: ScreenResultView): string {
  const lines: string[] = []
  lines.push(`A-share screening — strategy ${value.strategy} (${value.dataSource})`)
  lines.push(
    `Scanned ${value.scanned} stocks, matched ${value.matched} in ${(value.durationMs / 1000).toFixed(0)}s ` +
      `(bar files fetched this run: ${value.stocksFetched}).`,
  )
  if (value.candidates.length > 0) {
    if (value.strategy === 'low_flat_limit_up') {
      // The classic limit-up layout, kept verbatim for that strategy.
      lines.push('')
      lines.push('code     name             board    limit-up   surge   cooldown  cool-ref    days  close')
      for (const hit of value.candidates) {
        const evidence = hit.evidence as Record<string, number | string>
        lines.push(
          `${hit.code}  ${hit.name.padEnd(12).slice(0, 12)}  ${hit.board.padEnd(7)}  ` +
            `${String(evidence.limitUpDate ?? '-')}  ${String(evidence.limitUpVolumeSurge ?? '-').padStart(4)}x  ` +
            `${String(evidence.cooldownVolumeRatio ?? '-').padStart(7)}  ${String(evidence.cooldownRefDate ?? '-')}  ` +
            `${String(evidence.daysSinceLimitUp ?? '-').padStart(4)}  ` +
            `${evidence.close ?? '-'}`,
        )
      }
      lines.push('')
      lines.push(
        'limit-up/surge cite the most recent volume-heavy limit-up day; cooldown/cool-ref/days cite the day that ' +
          'also satisfies the pullback+cooldown pattern — the two may differ when only an older day qualifies. ' +
          'Each candidate carries full evidence fields (drawdown, percentile, flat metrics) in its result entry.',
      )
    } else {
      // Generic layout for every other strategy: columns are the union of the
      // candidates' evidence keys (minus close, rendered last), so a new
      // strategy needs no renderer change.
      const evidenceKeys: string[] = []
      for (const hit of value.candidates) {
        for (const key of Object.keys(hit.evidence)) {
          if (key !== 'close' && !evidenceKeys.includes(key)) evidenceKeys.push(key)
        }
      }
      const header = ['code', 'name', 'board', ...evidenceKeys, 'close']
      lines.push('')
      lines.push(header.map((h, i) => (i === 0 ? h.padEnd(9) : h.padEnd(h.length + 2))).join(''))
      for (const hit of value.candidates) {
        const evidence = hit.evidence as Record<string, number | string | boolean>
        const cells = [
          hit.code,
          hit.name.slice(0, 12),
          hit.board,
          ...evidenceKeys.map((key) => String(evidence[key] ?? '-')),
          String(evidence.close ?? '-'),
        ]
        lines.push(cells.map((c, i) => (i === 0 ? c.padEnd(9) : c.padEnd(String(header[i]).length + 2))).join(''))
      }
      lines.push('')
      lines.push('Each candidate carries the full evidence fields of its atomic filters in its result entry.')
    }
  } else {
    lines.push('No stock matched this strategy with the given parameters.')
  }
  const skipped = Object.entries(value.skipped)
  if (skipped.length > 0) lines.push(`Skipped by universe filters: ${JSON.stringify(value.skipped)}`)
  for (const note of value.notes) lines.push(`Note: ${note}`)
  lines.push(`DISCLAIMER: ${value.disclaimer}`)
  return lines.join('\n')
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    strategy: { type: 'string', required: true },
    dataSource: { type: 'string', required: true },
    generatedAt: { type: 'string', required: true },
    scanned: { type: 'number', required: true },
    matched: { type: 'number', required: true },
    candidates: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          code: { type: 'string', required: true },
          fullCode: { type: 'string', required: true },
          name: { type: 'string', required: true },
          board: { type: 'string', required: true },
          strategy: { type: 'string', required: true },
          evidence: { type: 'object', additionalProperties: true, required: true },
        },
      },
    },
    skipped: { type: 'object', additionalProperties: true, required: true },
    stocksFetched: { type: 'number', required: true },
    durationMs: { type: 'number', required: true },
    notes: { type: 'array', items: { type: 'string' }, required: true },
    disclaimer: { type: 'string', required: true },
  },
} as const

/** The full-market screening tool. */
export function createScreenTool(deps: ToolDeps): ToolDefinition {
  const strategyIds = deps.registry.ids()
  return defineTool({
    name: 'a_share_screen',
    description:
      `Screen all A-share stocks with a registered technical strategy and return matched candidates with ` +
      `quantified evidence (drawdown, percentile, flatness, limit-up date, volume ratios). Check ` +
      `a_share_list_strategies first for available strategy ids and their parameters; check ` +
      `a_share_list_filters for the composable atomic filters. Alternatively pass 'predicate' (JSON: ` +
      `{ "all": [...] } / { "any": [...] } / { "not": ... } over filter ids, max depth 3) to compose an ` +
      `ad-hoc screen without a registered strategy — 'params' then tunes that composition. The scan reads a ` +
      `local disk cache: the first full scan downloads history bar-by-bar and can take many minutes; later ` +
      `scans are fast. Results are technical screening of historical patterns, NOT investment advice.`,
    parameters: {
      strategy: {
        type: 'string',
        enum: strategyIds,
        description: `Screening strategy id. Available: ${strategyIds.join(', ')}. Mutually exclusive with 'predicate'.`,
      },
      predicate: {
        type: 'object',
        additionalProperties: true,
        description:
          'Ad-hoc predicate over atomic filter ids instead of a registered strategy: e.g. ' +
          '{"all": ["deep_drawdown", {"any": ["platform_breakout", "volume_limit_up"]}]}. ' +
          'Groups are { all } (AND), { any } (OR), { not } (NOT); leaves are filter ids from ' +
          'a_share_list_filters. Max depth 3, max 12 leaves. Mutually exclusive with "strategy".',
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description:
          'Optional overrides for the strategy (or predicate composition) parameter defaults — see ' +
          'a_share_list_strategies / a_share_list_filters. Unknown keys or out-of-range values are rejected ' +
          'with the valid set listed.',
      },
      refresh: {
        type: 'boolean',
        description: 'Force-refresh the cached stock list and recent bars (default false).',
      },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: renderReport(value as ScreenResultView) }],
    },
    timeoutMs: deps.config.scanTimeoutMs,
    // A scan is heavy (minutes) and shares the disk cache and the outbound
    // rate budget with every other scan; parallel runs would race cache
    // writes and multiply data-source load. Serialize tool calls instead.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const hasStrategy = typeof args.strategy === 'string' && args.strategy !== ''
      const hasPredicate = args.predicate !== undefined
      if (hasStrategy && hasPredicate) {
        throw new Error("'strategy' and 'predicate' are mutually exclusive — pass exactly one.")
      }
      if (!hasStrategy && !hasPredicate) {
        throw new Error(`pass either 'strategy' (one of ${strategyIds.join(', ')}) or 'predicate'.`)
      }
      let registry = deps.registry
      let strategyId = args.strategy as string
      let title: string | undefined
      if (hasPredicate) {
        const predicate = toPredicate(args.predicate, deps.filters)
        registry = customRegistry(deps, predicate, summarizePredicate(args.predicate))
        strategyId = CUSTOM_ID
        title = `custom(${summarizePredicate(args.predicate)})`
      }
      const result = await runScreen(deps.host, deps.config, deps.dataSource, registry, {
        strategyId,
        params: args.params === undefined ? undefined : (args.params as Record<string, unknown>),
        refresh: args.refresh ?? false,
        signal: exec.signal,
      })
      return title === undefined ? result : { ...result, notes: [...result.notes, `predicate: ${title}`] }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `A-share screening: ${args.strategy ?? 'custom predicate'}`,
      kind: 'search',
    }),
    presentResult: (args) => ({
      card: 'generic',
      title: `A-share screening done: ${args.strategy ?? 'custom predicate'}`,
    }),
  })
}

/** Strategy discovery tool: ids, descriptions, and parameter tables with defaults. */
export function createListStrategiesTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'a_share_list_strategies',
    description:
      'List the available A-share screening strategies with their descriptions, parameters, defaults, ' +
      'and valid ranges. Call this before a_share_screen to pick a strategy id and tune parameters.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          strategies: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true },
                description: { type: 'string', required: true },
                params: { type: 'object', additionalProperties: true, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: JSON.stringify((value as { strategies: unknown[] }).strategies, null, 2),
        },
      ],
    },
    async execute() {
      return {
        strategies: deps.registry.list().map((strategy) => ({
          id: strategy.id,
          description: strategy.description,
          params: strategy.paramDocs,
        })),
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'List A-share screening strategies',
    }),
  })
}

/** Atomic-filter discovery tool: the composable conditions strategies are built from. */
export function createListFiltersTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'a_share_list_filters',
    description:
      'List the available atomic A-share screening filters (composable conditions such as deep drawdown, ' +
      'low percentile, flat base, volume limit-up, and cooldown pullback) with their descriptions, parameters, ' +
      'defaults, and valid ranges. Strategies are built by combining these filters.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string', required: true },
                description: { type: 'string', required: true },
                params: { type: 'object', additionalProperties: true, required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: JSON.stringify((value as { filters: unknown[] }).filters, null, 2),
        },
      ],
    },
    async execute() {
      return {
        filters: deps.filters.list().map((filter) => ({
          id: filter.id,
          description: filter.description,
          params: filter.paramDocs,
          // Flatten the capability flags into the description-carrying record
          // shape the tool's JSON schema expects.
          ...(filter.requires?.industry ? { requiresIndustry: true } : {}),
          ...(filter.requires?.marketCap ? { requiresMarketCap: true } : {}),
          ...(filter.requires?.amount ? { requiresAmount: true } : {}),
        })),
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'List A-share screening filters',
    }),
  })
}
