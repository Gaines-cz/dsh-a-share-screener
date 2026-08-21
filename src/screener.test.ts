import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScreen, type ScreenerConfig, type ScreenerHost } from './screener.js'
import { eastmoneyDailyBars, eastmoneyListStocks } from './datasources/eastmoney.js'
import { tencentDailyBars } from './datasources/tencent.js'
import { StrategyRegistry } from './strategies/registry.js'
import { lowFlatLimitUpStrategy } from './strategies/low-flat-limitup.js'
import type { Bar, StockMeta } from './types.js'

vi.mock('./datasources/eastmoney.js', () => ({
  eastmoneyListStocks: vi.fn(),
  eastmoneyDailyBars: vi.fn(),
}))

vi.mock('./datasources/tencent.js', () => ({
  tencentDailyBars: vi.fn(),
}))

const mockedList = vi.mocked(eastmoneyListStocks)
const mockedBars = vi.mocked(eastmoneyDailyBars)
const mockedTencent = vi.mocked(tencentDailyBars)

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

/** 800-bar positive fixture identical to the strategy test, as eastmoney bars (preClose absent). */
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

const noTokenHost: ScreenerHost = {
  resolveToken: async () => undefined,
  log: () => {},
}

function config(cacheDir: string, overrides: Partial<ScreenerConfig> = {}): ScreenerConfig {
  return {
    tokenEnv: 'TUSHARE_TOKEN',
    dataSource: 'auto',
    cacheDir,
    requestsPerMinute: 600_000,
    historyBars: 800,
    excludeST: true,
    excludeBSE: true,
    minListDays: 365,
    ...overrides,
  }
}

beforeEach(() => {
  mockedList.mockReset()
  mockedBars.mockReset()
  mockedTencent.mockReset()
})

describe('runScreen (eastmoney fallback path)', () => {
  it('filters the universe, scans, matches, and caches bar files', async () => {
    const dir = await tempDir()
    const listDate = '20100101'
    mockedList.mockResolvedValue([
      stock('600001', '好公司', 'main', listDate),
      stock('600002', 'ST差公司', 'main', listDate),
      stock('830001', '北交所公司', 'bse', listDate),
      stock('600003', '次新公司', 'main', ymd(new Date())),
    ])
    mockedBars.mockResolvedValue(fixtureBars())

    const signal = new AbortController().signal
    const result = await runScreen(noTokenHost, config(dir), registry(), {
      strategyId: 'low_flat_limit_up',
      signal,
    })

    expect(result.dataSource).toBe('eastmoney')
    expect(result.tokenConfigured).toBe(false)
    expect(result.notes.some((note) => note.includes('eastmoney'))).toBe(true)
    expect(result.scanned).toBe(1)
    expect(result.matched).toBe(1)
    expect(result.candidates[0]!.code).toBe('600001')
    expect(result.skipped).toEqual({ 'st-or-delisting': 1, bse: 1, 'recent-or-unknown-listing': 1 })
    expect(result.stocksFetched).toBe(1)
    expect(result.disclaimer).toMatch(/NOT investment advice/)

    // Second run: cache is fresh (fixture tail = today), so no refetch.
    mockedBars.mockClear()
    const again = await runScreen(noTokenHost, config(dir), registry(), {
      strategyId: 'low_flat_limit_up',
      signal,
    })
    expect(again.matched).toBe(1)
    expect(again.stocksFetched).toBe(0)
    expect(mockedBars).not.toHaveBeenCalled()
  })

  it('refetches the full window when a cached tail is stale and overlap drifts', async () => {
    const dir = await tempDir()
    mockedList.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    mockedBars.mockResolvedValueOnce(fixtureBars())
    const signal = new AbortController().signal
    await runScreen(noTokenHost, config(dir), registry(), { strategyId: 'low_flat_limit_up', signal })

    // Age only the cached tail beyond the freshness threshold.
    const barsFile = join(dir, 'eastmoney', 'bars', '600001.SH.json')
    const { writeFile } = await import('node:fs/promises')
    const cached = JSON.parse(await (await import('node:fs/promises')).readFile(barsFile, 'utf8')) as {
      bars: [string, number, number, number, number, number, number | null][]
    }
    cached.bars[cached.bars.length - 1]![0] = '20200101'
    await writeFile(barsFile, JSON.stringify(cached), 'utf8')

    mockedBars.mockClear()
    mockedBars.mockResolvedValue(fixtureBars())
    const refreshed = await runScreen(noTokenHost, config(dir), registry(), {
      strategyId: 'low_flat_limit_up',
      signal,
    })
    expect(refreshed.matched).toBe(1)
    expect(mockedBars).toHaveBeenCalled()
  })
})

describe('runScreen failure modes', () => {
  it('falls back to tencent klines when eastmoney fails, with separate cache dirs', async () => {
    const dir = await tempDir()
    mockedList.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    mockedBars.mockRejectedValue(new Error('socket reset'))
    mockedTencent.mockResolvedValue(fixtureBars())

    const result = await runScreen(noTokenHost, config(dir), registry(), {
      strategyId: 'low_flat_limit_up',
      signal: new AbortController().signal,
    })
    expect(result.matched).toBe(1)
    expect(result.notes.some((note) => note.includes('tencent for 1'))).toBe(true)
    expect(mockedTencent).toHaveBeenCalledWith('600001.SH', expect.any(String), expect.anything(), expect.anything())

    // Second run: tencent cache dir holds the file and stays fresh, so no refetch.
    mockedTencent.mockClear()
    const again = await runScreen(noTokenHost, config(dir), registry(), {
      strategyId: 'low_flat_limit_up',
      signal: new AbortController().signal,
    })
    expect(again.matched).toBe(1)
    expect(mockedTencent).not.toHaveBeenCalled()
  })

  it('trips the eastmoney circuit breaker after 3 consecutive failures', async () => {
    const dir = await tempDir()
    mockedList.mockResolvedValue([
      stock('600001', '甲公司', 'main', '20100101'),
      stock('600002', '乙公司', 'main', '20100101'),
      stock('600003', '丙公司', 'main', '20100101'),
      stock('600004', '丁公司', 'main', '20100101'),
      stock('600005', '戊公司', 'main', '20100101'),
    ])
    mockedBars.mockRejectedValue(new Error('socket reset'))
    mockedTencent.mockResolvedValue(fixtureBars())

    const result = await runScreen(noTokenHost, config(dir), registry(), {
      strategyId: 'low_flat_limit_up',
      signal: new AbortController().signal,
    })
    expect(result.scanned).toBe(5)
    // Stocks 1-3 try eastmoney then tencent; the breaker skips eastmoney after that.
    expect(mockedBars).toHaveBeenCalledTimes(3)
    expect(mockedTencent).toHaveBeenCalledTimes(5)
    expect(result.notes.some((note) => note.includes('tencent for 5'))).toBe(true)
  })

  it('throws with both causes when every kline source fails', async () => {
    const dir = await tempDir()
    mockedList.mockResolvedValue([stock('600001', '好公司', 'main', '20100101')])
    mockedBars.mockRejectedValue(new Error('east down'))
    mockedTencent.mockRejectedValue(new Error('tencent down'))
    await expect(
      runScreen(noTokenHost, config(dir), registry(), {
        strategyId: 'low_flat_limit_up',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/all kline sources failed .*east down \| tencent: tencent down/)
  })

  it('throws loud guidance for explicit tushare without a token', async () => {
    const dir = await tempDir()
    await expect(
      runScreen(noTokenHost, config(dir, { dataSource: 'tushare' }), registry(), {
        strategyId: 'low_flat_limit_up',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/TUSHARE_TOKEN/)
  })

  it('throws with the available strategies for an unknown id', async () => {
    const dir = await tempDir()
    await expect(
      runScreen(noTokenHost, config(dir), registry(), {
        strategyId: 'moon_phase',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Available: low_flat_limit_up/)
  })

  it('rejects bad strategy params loudly', async () => {
    const dir = await tempDir()
    await expect(
      runScreen(noTokenHost, config(dir), registry(), {
        strategyId: 'low_flat_limit_up',
        params: { minVolumeSurge: 0.1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/>=/)
  })
})
