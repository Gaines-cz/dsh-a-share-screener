import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScreen, type ScreenerConfig, type ScreenerHost } from './screener.js'
import type { DataSource } from './datasources/index.js'
import { StrategyRegistry } from './strategies/registry.js'
import { lowFlatLimitUpStrategy } from './strategies/low-flat-limitup.js'
import type { Bar, StockMeta } from './types.js'

const listStocks = vi.fn<(signal: AbortSignal) => Promise<StockMeta[]>>()
const dailyBars = vi.fn<(fullCode: string, startDate: string, signal: AbortSignal) => Promise<Bar[]>>()

const dataSource: DataSource = {
  id: 'eastmoney',
  capabilities: { industry: false },
  listStocks,
  dailyBars,
}

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'screener-e2e-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.useRealTimers()
})

function ymd(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

function stock(code: string, name: string, board: StockMeta['board'], listDate: string): StockMeta {
  const suffix = code.startsWith('6') ? 'SH' : board === 'bse' ? 'BJ' : 'SZ'
  return { code, fullCode: `${code}.${suffix}`, name, board, listDate }
}

/** 800-bar positive fixture identical to the strategy test, as source bars (preClose absent). */
function fixtureBars(): Bar[] {
  const closes: number[] = []
  const vols: number[] = []
  for (let i = 0; i <= 649; i++) closes.push(10 * Math.pow(0.28, i / 649))
  for (let i = 650; i <= 739; i++) closes.push(2.8 * (i % 2 === 0 ? 1.001 : 0.999))
  closes.push(closes[739]! * 1.1)
  for (let i = 0; i <= 14; i++) closes.push(3.02 - 0.3 * (i / 14))
  for (let i = 756; i <= 799; i++) closes.push(2.72 * (i % 2 === 0 ? 1.0005 : 0.9995))
  for (let i = 0; i <= 739; i++) vols.push(1000)
  vols.push(3500)
  for (let i = 0; i <= 14; i++) vols.push(1500 - 40 * i)
  for (let i = 756; i <= 799; i++) vols.push(300)
  const today = new Date()
  return closes.map((close, i) => {
    const date = new Date(today)
    date.setDate(date.getDate() - (closes.length - 1 - i))
    return { date: ymd(date), open: close, high: close, low: close, close, volume: vols[i]!, preClose: null }
  })
}

function registry(): StrategyRegistry {
  const reg = new StrategyRegistry()
  reg.register(lowFlatLimitUpStrategy)
  return reg
}

const host: ScreenerHost = { log: () => {} }

function config(cacheDir: string, overrides: Partial<ScreenerConfig> = {}): ScreenerConfig {
  return {
    cacheDir,
    requestsPerMinute: 600_000,
    historyBars: 800,
    excludeST: true,
    excludeBSE: true,
    minListDays: 365,
    scanTimeoutMs: 3_600_000,
    ...overrides,
  }
}

function scan(
  cacheDir: string,
  cfg: ScreenerConfig,
  args: { strategyId: string; params?: unknown; refresh?: boolean; signal: AbortSignal },
): ReturnType<typeof runScreen> {
  return runScreen(host, cfg, dataSource, registry(), args)
}

beforeEach(() => {
  listStocks.mockReset()
  dailyBars.mockReset()
})

describe('runScreen (data-source path)', () => {
  it('filters the universe, scans, matches, and caches bar files', async () => {
    const dir = await tempDir()
    const listDate = '20100101'
    listStocks.mockResolvedValue([
      stock('600001', '好公司', 'main', listDate),
      stock('600002', 'ST差公司', 'main', listDate),
      stock('830001', '北交所公司', 'bse', listDate),
      stock('600003', '次新公司', 'main', ymd(new Date())),
    ])
    dailyBars.mockResolvedValue(fixtureBars())

    const signal = new AbortController().signal
    const result = await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })

    expect(result.dataSource).toBe('eastmoney')
    expect(result.scanned).toBe(1)
    expect(result.matched).toBe(1)
    expect(result.candidates[0]!.code).toBe('600001')
    expect(result.skipped).toEqual({ 'st-or-delisting': 1, bse: 1, 'recent-or-unknown-listing': 1 })
    expect(result.stocksFetched).toBe(1)
    expect(result.disclaimer).toMatch(/NOT investment advice/)

    // Second run: cache is fresh (fixture tail = today), so no refetch.
    dailyBars.mockClear()
    const again = await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })
    expect(again.matched).toBe(1)
    expect(again.stocksFetched).toBe(0)
    expect(dailyBars).not.toHaveBeenCalled()
  })

  it('excludes stocks listed longer than maxListDays', async () => {
    const dir = await tempDir()
    const twoYearsAgo = new Date()
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)
    listStocks.mockResolvedValue([
      stock('600001', '老公司', 'main', '20100101'), // ~16 years: too old
      stock('600002', '适龄公司', 'main', ymd(twoYearsAgo)), // 2 years: in range
      stock('600003', '太新公司', 'main', ymd(new Date())), // too new
    ])
    dailyBars.mockResolvedValue(fixtureBars())

    const signal = new AbortController().signal
    const result = await scan(dir, config(dir, { maxListDays: 1460 }), { strategyId: 'low_flat_limit_up', signal })

    expect(result.scanned).toBe(1)
    expect(result.matched).toBe(1)
    expect(result.candidates[0]!.code).toBe('600002')
    expect(result.skipped).toEqual({ 'too-old-listing': 1, 'recent-or-unknown-listing': 1 })
  })

  it('refetches the full window when a cached tail is stale', async () => {
    const dir = await tempDir()
    listStocks.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    dailyBars.mockResolvedValue(fixtureBars())
    const signal = new AbortController().signal
    await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })

    // Age both the tail date and the fetchedAt stamp beyond the freshness rules.
    const barsFile = join(dir, 'eastmoney', 'bars', '600001.SH.json')
    const { writeFile } = await import('node:fs/promises')
    const cached = JSON.parse(await (await import('node:fs/promises')).readFile(barsFile, 'utf8')) as {
      fetchedAt?: string
      bars: [string, number, number, number, number, number, number | null][]
    }
    cached.bars[cached.bars.length - 1]![0] = '20200101'
    cached.fetchedAt = '20200101'
    await writeFile(barsFile, JSON.stringify(cached), 'utf8')

    dailyBars.mockClear()
    const refreshed = await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })
    expect(refreshed.matched).toBe(1)
    expect(dailyBars).toHaveBeenCalled()
  })

  it('refetches once per day at most: a second same-day scan after a stale refresh stays cached', async () => {
    const dir = await tempDir()
    listStocks.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    dailyBars.mockResolvedValue(fixtureBars())
    const signal = new AbortController().signal
    await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })

    // Age the tail so the file is stale, but keep fetchedAt = today.
    const barsFile = join(dir, 'eastmoney', 'bars', '600001.SH.json')
    const { writeFile } = await import('node:fs/promises')
    const cached = JSON.parse(await (await import('node:fs/promises')).readFile(barsFile, 'utf8')) as {
      bars: [string, number, number, number, number, number, number | null][]
    }
    cached.bars[cached.bars.length - 1]![0] = '20200101'
    await writeFile(barsFile, JSON.stringify(cached), 'utf8')

    dailyBars.mockClear()
    const again = await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })
    // Stale tail but already attempted today → no network call.
    expect(dailyBars).not.toHaveBeenCalled()
    expect(again.stocksFetched).toBe(0)
  })
})

describe('runScreen failure modes', () => {
  it('skips stocks whose klines fail, counting them as kline-fetch-failed', async () => {
    const dir = await tempDir()
    listStocks.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    dailyBars.mockRejectedValue(new Error('east down'))
    const result = await scan(dir, config(dir), {
      strategyId: 'low_flat_limit_up',
      signal: new AbortController().signal,
    })
    expect(result.scanned).toBe(0)
    expect(result.matched).toBe(0)
    expect(result.skipped['kline-fetch-failed']).toBe(1)
  })

  it('aborts the scan when kline failures exceed 10% of the universe', async () => {
    const dir = await tempDir()
    const universe = Array.from({ length: 100 }, (_, i) =>
      stock(`600${String(i + 1).padStart(3, '0')}`, `公司${i}`, 'main', '20100101'),
    )
    listStocks.mockResolvedValue(universe)
    dailyBars.mockRejectedValue(new Error('outage'))
    await expect(
      scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal: new AbortController().signal }),
    ).rejects.toThrow(/aborting scan: kline fetch failed for 100/)
  })

  it('throws with the available strategies for an unknown id', async () => {
    const dir = await tempDir()
    await expect(
      scan(dir, config(dir), { strategyId: 'moon_phase', signal: new AbortController().signal }),
    ).rejects.toThrow(/Available: low_flat_limit_up/)
  })

  it('rejects bad strategy params loudly', async () => {
    const dir = await tempDir()
    await expect(
      scan(dir, config(dir), {
        strategyId: 'low_flat_limit_up',
        params: { minVolumeSurge: 0.1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/>=/)
  })

  it('rejects fractional bar-count params loudly', async () => {
    const dir = await tempDir()
    await expect(
      scan(dir, config(dir), {
        strategyId: 'low_flat_limit_up',
        params: { percentileWindowBars: 729.5 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/must be an integer/)
  })

  it('falls back to the cached stock list when the list endpoint fails', async () => {
    const dir = await tempDir()
    listStocks.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    dailyBars.mockResolvedValue(fixtureBars())
    const signal = new AbortController().signal
    const first = await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal })
    expect(first.scanned).toBe(1)

    // List endpoint now dead; a forced refresh must still run on the cached list.
    listStocks.mockRejectedValue(new Error('list host down'))
    dailyBars.mockClear()
    const second = await scan(dir, config(dir), { strategyId: 'low_flat_limit_up', refresh: true, signal })
    expect(second.scanned).toBe(1)
    expect(second.matched).toBe(1)
    expect(dailyBars).not.toHaveBeenCalled() // bars already cached with a fresh tail
  })

  it('throws when the list endpoint fails and no cache exists', async () => {
    const dir = await tempDir()
    listStocks.mockRejectedValue(new Error('list host down'))
    await expect(
      scan(dir, config(dir), { strategyId: 'low_flat_limit_up', signal: new AbortController().signal }),
    ).rejects.toThrow(/list host down/)
  })
})

describe('runScreen (capability gating)', () => {
  it('refuses loudly when the strategy needs amount data the source lacks', async () => {
    const dir = await tempDir()
    const reg = new StrategyRegistry()
    // Wire an amount-requiring strategy through the real composition engine.
    const { composeStrategy } = await import('./engine/compose.js')
    const { createFilterRegistry } = await import('./filters/index.js')
    reg.register(
      composeStrategy({
        id: 'needs-amount',
        description: 'test',
        predicate: { kind: 'filter', filter: 'amount_liquidity' },
        filters: createFilterRegistry(),
      }),
    )
    listStocks.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    dailyBars.mockResolvedValue(fixtureBars())
    await expect(
      runScreen(host, config(dir), dataSource, reg, { strategyId: 'needs-amount', signal: new AbortController().signal }),
    ).rejects.toThrow(/requires.*traded value.*does not provide/)
  })
})

describe('runScreen (industry pre-pass)', () => {
  it('aggregates industry stats and injects them into the strategy input', async () => {
    const dir = await tempDir()
    const { composeStrategy } = await import('./engine/compose.js')
    const { createFilterRegistry } = await import('./filters/index.js')
    // deep_drawdown AND industry_clearance: members of a cleared industry hit.
    const reg = new StrategyRegistry()
    reg.register(
      composeStrategy({
        id: 'industry-test',
        description: 'test',
        predicate: {
          kind: 'and',
          children: [
            { kind: 'filter', filter: 'deep_drawdown' },
            { kind: 'filter', filter: 'industry_clearance' },
          ],
        },
        filters: createFilterRegistry(),
        extraParamDocs: {
          minBars: { type: 'number', default: 60, min: 10, max: 3000, integer: true, description: 'x' },
        },
      }),
    )
    const industrySource: DataSource = {
      id: 'test-industry',
      capabilities: { industry: true },
      listStocks,
      dailyBars,
    }
    listStocks.mockResolvedValue([
      { ...stock('600001', '深跌甲', 'main', '20100101'), industry: '出清行业' },
      { ...stock('600002', '深跌乙', 'main', '20100101'), industry: '出清行业' },
      { ...stock('600004', '深跌丁', 'main', '20100101'), industry: '出清行业' },
      { ...stock('600003', '浅跌丙', 'main', '20100101'), industry: '景气行业' },
    ])
    // 出清行业: two deep members (dd ≥ 0.6); 景气行业: shallow.
    dailyBars.mockImplementation(async (fullCode: string) => {
      const bars = fixtureBars() // deep: dd ~0.72
      if (fullCode.startsWith('600003')) {
        return bars.map((bar) => ({ ...bar, close: bar.close * 3 + 10, open: bar.open * 3 + 10, high: bar.high * 3 + 10, low: bar.low * 3 + 10 }))
      }
      return bars
    })
    const result = await runScreen(host, config(dir, { minListDays: 100 }), industrySource, reg, {
      strategyId: 'industry-test',
      params: { minIndustryMembers: 3, minIndustryMedDrawdown: 0.5, minIndustryDeepShare: 0.5, minDrawdownFromHigh: 0.6 },
      signal: new AbortController().signal,
    })
    expect(result.matched).toBe(3)
    const evidence = result.candidates[0]!.evidence as Record<string, unknown>
    expect(evidence.industry).toBe('出清行业')
    expect(evidence.industryMembers).toBe(3)
    expect(evidence.industryMedDrawdown as number).toBeGreaterThan(0.5)
    expect(result.notes[0]).toMatch(/industry cycle aggregated/)
  })

  it('warns visibly when the pre-pass fetch fails systemically, while the main loop retries clean', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const loggingHost: ScreenerHost = { log: (_level, message) => logs.push(message) }
    const { composeStrategy } = await import('./engine/compose.js')
    const { createFilterRegistry } = await import('./filters/index.js')
    const reg = new StrategyRegistry()
    reg.register(
      composeStrategy({
        id: 'industry-test',
        description: 'test',
        predicate: {
          kind: 'and',
          children: [
            { kind: 'filter', filter: 'deep_drawdown' },
            { kind: 'filter', filter: 'industry_clearance' },
          ],
        },
        filters: createFilterRegistry(),
        extraParamDocs: {
          minBars: { type: 'number', default: 60, min: 10, max: 3000, integer: true, description: 'x' },
        },
      }),
    )
    const industrySource: DataSource = {
      id: 'test-industry',
      capabilities: { industry: true },
      listStocks,
      dailyBars,
    }
    // 12 members so 12 failures exceed the systemic threshold max(10, 10%).
    listStocks.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        ...stock(`6000${String(i + 10)}`, `成员${i}`, 'main', '20100101'),
        industry: '出清行业',
      })),
    )
    // First fetch of every code fails (the whole pre-pass); the retry succeeds.
    const calls = new Map<string, number>()
    dailyBars.mockImplementation(async (fullCode: string) => {
      const n = (calls.get(fullCode) ?? 0) + 1
      calls.set(fullCode, n)
      if (n === 1) throw new Error('transient outage')
      return fixtureBars()
    })
    const result = await runScreen(loggingHost, config(dir, { minListDays: 100 }), industrySource, reg, {
      strategyId: 'industry-test',
      params: { minIndustryMembers: 3, minIndustryMedDrawdown: 0.5, minIndustryDeepShare: 0.5, minDrawdownFromHigh: 0.6 },
      signal: new AbortController().signal,
    })
    // The pre-pass failed for all 12 → empty industry stats → no candidate passes industry_clearance,
    // but the run itself must NOT abort: the main loop retried every member cleanly.
    expect(result.matched).toBe(0)
    expect(result.skipped['kline-fetch-failed'] ?? 0).toBe(0)
    expect(
      logs.some((m) => m.includes('industry pre-pass') && m.includes('12/12')),
    ).toBe(true)
    expect(logs.some((m) => m.includes('12 fetch failures'))).toBe(true)
  })
})
