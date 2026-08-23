/**
 * Model-facing tools: `a_share_screen` (full market scan),
 * `a_share_list_strategies` (strategy discovery), and `a_share_list_filters`
 * (atomic-filter discovery).
 * @module a-share-screener/tool
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DataSource } from './datasources/index.js'
import type { FilterRegistry } from './engine/types.js'
import type { ScreenResultView, ScreenerConfig, ScreenerHost } from './screener.js'
import { runScreen } from './screener.js'
import type { StrategyRegistry } from './strategies/registry.js'

interface ToolDeps {
  host: ScreenerHost
  config: ScreenerConfig
  dataSource: DataSource
  registry: StrategyRegistry
  filters: FilterRegistry
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
      `a_share_list_strategies first for available strategy ids and their parameters. The scan reads a local ` +
      `disk cache: the first full scan downloads history bar-by-bar and can take many minutes; later scans are ` +
      `fast. Results are technical screening of historical patterns, NOT investment advice.`,
    parameters: {
      strategy: {
        type: 'string',
        required: true,
        enum: strategyIds,
        description: `Screening strategy id. Available: ${strategyIds.join(', ')}.`,
      },
      params: {
        type: 'object',
        additionalProperties: true,
        description:
          'Optional overrides for the strategy parameter defaults (see a_share_list_strategies). ' +
          'Unknown keys or out-of-range values are rejected with the valid set listed.',
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
      return runScreen(deps.host, deps.config, deps.dataSource, deps.registry, {
        strategyId: args.strategy,
        params: args.params === undefined ? undefined : (args.params as Record<string, unknown>),
        refresh: args.refresh ?? false,
        signal: exec.signal,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `A-share screening: ${args.strategy}`,
      kind: 'search',
    }),
    presentResult: (args) => ({
      card: 'generic',
      title: `A-share screening done: ${args.strategy}`,
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
        })),
      }
    },
    presentCall: () => ({
      card: 'generic',
      title: 'List A-share screening filters',
    }),
  })
}
