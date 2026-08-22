import { describe, expect, it } from 'vitest'
import { createListFiltersTool, createListStrategiesTool, createScreenTool } from './tool.js'
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
