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
})