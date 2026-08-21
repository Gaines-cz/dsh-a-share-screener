import { describe, expect, it } from 'vitest'
import { createListStrategiesTool, createScreenTool } from './tool.js'
import type { ScreenerConfig, ScreenerHost } from './screener.js'
import { StrategyRegistry } from './strategies/registry.js'
import { lowFlatLimitUpStrategy } from './strategies/low-flat-limitup.js'
import { Config } from './index.js'

const host: ScreenerHost = { resolveToken: async () => undefined, log: () => {} }
const config: ScreenerConfig = {
  tokenEnv: 'TUSHARE_TOKEN',
  dataSource: 'auto',
  cacheDir: null,
  requestsPerMinute: 200,
  historyBars: 800,
  excludeST: true,
  excludeBSE: true,
  minListDays: 365,
}
const registry = new StrategyRegistry()
registry.register(lowFlatLimitUpStrategy)
const deps = { host, config, registry }

describe('tool construction', () => {
  it('builds both tools with valid DSL schemas (defineTool compiles them)', () => {
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
})

describe('plugin Config schema', () => {
  it('fills defaults for absent fields', () => {
    const resolved = Config({} as unknown as Config) as unknown as Record<string, unknown>
    expect(resolved.tokenEnv).toBe('TUSHARE_TOKEN')
    expect(resolved.dataSource).toBe('auto')
    expect(resolved.requestsPerMinute).toBe(200)
    expect(resolved.historyBars).toBe(800)
    expect(resolved.excludeST).toBe(true)
    expect(resolved.excludeBSE).toBe(true)
    expect(resolved.minListDays).toBe(365)
  })
})
