import { describe, expect, it } from 'vitest'
import { createListFiltersTool, createListStrategiesTool, createScreenTool, toPredicate } from './tool.js'
import { createFilterRegistry } from './filters/index.js'
import type { DataSource } from './datasources/index.js'
import type { ScreenerConfig, ScreenerHost } from './screener.js'
import { StrategyRegistry } from './strategies/registry.js'
import { lowFlatLimitUpStrategy } from './strategies/low-flat-limitup.js'
import { Config } from './index.js'

const host: ScreenerHost = { log: () => {} }
const config: ScreenerConfig = {
  cacheDir: null,
  requestsPerMinute: 200,
  historyBars: 800,
  excludeST: true,
  excludeBSE: true,
  minListDays: 365,
  scanTimeoutMs: 1_800_000,
}
const dataSource: DataSource = {
  id: 'eastmoney',
  capabilities: { industry: false },
  listStocks: async () => [],
  dailyBars: async () => [],
}
const registry = new StrategyRegistry()
registry.register(lowFlatLimitUpStrategy)
const filters = createFilterRegistry()
const deps = { host, config, dataSource, registry, filters }

describe('tool construction', () => {
  it('builds the tools with valid DSL schemas (defineTool compiles them)', () => {
    const list = createListStrategiesTool(deps)
    expect(list.name).toBe('a_share_list_strategies')
    const screen = createScreenTool(deps)
    expect(screen.name).toBe('a_share_screen')
    expect(screen.description).toContain('NOT investment advice')
  })

  it('exposes the registered strategy ids as the parameter enum', () => {
    const screen = createScreenTool(deps)
    expect(JSON.stringify(screen)).toContain('low_flat_limit_up')
  })

  it('exposes the atomic filters via a_share_list_filters', () => {
    const listFilters = createListFiltersTool(deps)
    expect(listFilters.name).toBe('a_share_list_filters')
    // The discoverable filter ids come from the registry the tool is wired to
    // (the tool's execute() maps deps.filters.list(), so the ids live there).
    const ids = deps.filters.ids()
    expect(ids).toContain('deep_drawdown')
    expect(ids).toContain('cooldown_pullback')
  })
})

describe('plugin Config schema', () => {
  it('fills defaults for absent fields', () => {
    const resolved = Config({} as unknown as Config) as unknown as Record<string, unknown>
    expect(resolved.requestsPerMinute).toBe(200)
    expect(resolved.historyBars).toBe(800)
    expect(resolved.excludeST).toBe(true)
    expect(resolved.excludeBSE).toBe(true)
    expect(resolved.minListDays).toBe(365)
  })
})

describe('screen tool result rendering', () => {
  it('renders non-limit-up strategies with generic evidence columns, not the limit-up table', () => {
    const screen = createScreenTool(deps)
    const flatBaseView = {
      strategy: 'flat_base_low',
      dataSource: 'sina',
      generatedAt: '2026-08-23T00:00:00.000Z',
      scanned: 1,
      matched: 1,
      candidates: [
        {
          code: '600004',
          fullCode: '600004.SH',
          name: '平底股份',
          board: 'main',
          strategy: 'flat_base_low',
          evidence: { percentileInWindow: 0.08, flatNetChange: 0.03, close: 5.5 },
        },
      ],
      skipped: {},
      stocksFetched: 0,
      durationMs: 1000,
      notes: [],
      disclaimer: 'DISCLAIMER',
    }
    const blocks = screen.output!.render!({} as never, flatBaseView) as { type: string; text?: string }[]
    const text = String(blocks[0] && 'text' in blocks[0] ? blocks[0].text : '')
    expect(text).toContain('percentileInWindow')
    expect(text).toContain('flatNetChange')
    expect(text).not.toContain('limit-up')
    expect(text).toContain('600004')
  })

  it('keeps the limit-up table verbatim for low_flat_limit_up', () => {
    const screen = createScreenTool(deps)
    const view = {
      strategy: 'low_flat_limit_up',
      dataSource: 'sina',
      generatedAt: '2026-08-23T00:00:00.000Z',
      scanned: 1,
      matched: 1,
      candidates: [
        {
          code: '002777',
          fullCode: '002777.SZ',
          name: '久远银海',
          board: 'main',
          strategy: 'low_flat_limit_up',
          evidence: {
            limitUpDate: '20260513',
            limitUpVolumeSurge: 2.13,
            cooldownVolumeRatio: 0.3423,
            cooldownRefDate: '20260513',
            daysSinceLimitUp: 71,
            close: 12.51,
          },
        },
      ],
      skipped: {},
      stocksFetched: 0,
      durationMs: 1000,
      notes: [],
      disclaimer: 'DISCLAIMER',
    }
    const blocks = screen.output!.render!({} as never, view) as { type: string; text?: string }[]
    const text = String(blocks[0] && 'text' in blocks[0] ? blocks[0].text : '')
    expect(text).toContain('limit-up   surge   cooldown  cool-ref    days  close')
    expect(text).toContain('20260513')
  })
})

describe('predicate DSL validation', () => {
  it('converts a nested all/any DSL into an engine predicate', () => {
    const predicate = toPredicate({ all: ['deep_drawdown', { any: ['platform_breakout', 'volume_limit_up'] }] }, filters)
    expect(predicate).toEqual({
      kind: 'and',
      children: [
        { kind: 'filter', filter: 'deep_drawdown' },
        {
          kind: 'or',
          children: [
            { kind: 'filter', filter: 'platform_breakout' },
            { kind: 'filter', filter: 'volume_limit_up' },
          ],
        },
      ],
    })
  })

  it('converts not groups', () => {
    expect(toPredicate({ not: 'flat_base' }, filters)).toEqual({ kind: 'not', child: { kind: 'filter', filter: 'flat_base' } })
  })

  it('rejects unknown filter ids with the available list', () => {
    expect(() => toPredicate('nope', filters)).toThrow(/unknown filter 'nope'/)
  })

  it('rejects groups with zero or multiple operator keys', () => {
    expect(() => toPredicate({}, filters)).toThrow('exactly one')
    expect(() => toPredicate({ all: ['flat_base'], any: ['flat_base'] }, filters)).toThrow('only ONE')
  })

  it('rejects empty or non-array all/any', () => {
    expect(() => toPredicate({ all: [] }, filters)).toThrow('non-empty array')
    expect(() => toPredicate({ any: 'flat_base' }, filters)).toThrow('non-empty array')
  })

  it('rejects non-string leaves', () => {
    expect(() => toPredicate({ all: [42] }, filters)).toThrow('filter id')
  })

  it('rejects nesting deeper than 3 group levels', () => {
    const deep = { all: [{ all: [{ all: [{ all: ['flat_base'] }] }] }] }
    expect(() => toPredicate(deep, filters)).toThrow('nest')
  })

  it('rejects more than 12 leaves', () => {
    const many = { all: Array.from({ length: 13 }, () => 'flat_base') }
    expect(() => toPredicate(many, filters)).toThrow('12')
  })
})
