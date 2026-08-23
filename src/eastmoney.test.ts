import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEastmoneyDataSource } from './datasources/eastmoney.js'
import { RateLimiter } from './http.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const dataSource = createEastmoneyDataSource(new RateLimiter(600_000))

interface PageOpts {
  count: number
  total?: number
}

/** Build a clist page response with `count` entries; codes unique across pages via `page` offset. */
function pageResponse({ count, total, page = 1 }: PageOpts & { page?: number }): object {
  const diff = Array.from({ length: count }, (_, i) => ({
    f12: String(600_000 + (page - 1) * 100 + i),
    f13: 1,
    f14: `股${i}`,
    f26: 20100101,
  }))
  return { data: { total, diff } }
}

describe('eastmoney listStocks pagination', () => {
  it('keeps paging when total is missing, stopping only on a short page (regression: old code truncated to page 1)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse({ count: 100, page: 1 })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse({ count: 100, page: 2 })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse({ count: 37, page: 3 })), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const stocks = await dataSource.listStocks(new AbortController().signal)
    expect(stocks.length).toBe(237) // 100 + 100 + 37, not just the first 100
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops at total when it is present and reached before a short page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse({ count: 100, total: 150, page: 1 })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pageResponse({ count: 50, total: 150, page: 2 })), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const stocks = await dataSource.listStocks(new AbortController().signal)
    expect(stocks.length).toBe(150)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips non-A-share codes and keeps valid ones', async () => {
    const diff = [
      { f12: '600519', f13: 1, f14: '茅台', f26: 20010827 },
      { f12: 'notacode', f13: 1, f14: '脏数据', f26: 0 },
      { f12: '12345', f13: 1, f14: '坏代码', f26: 0 },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { total: 1, diff } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const stocks = await dataSource.listStocks(new AbortController().signal)
    expect(stocks).toHaveLength(1)
    expect(stocks[0]!.fullCode).toBe('600519.SH')
  })
})
describe('eastmoney list metadata (industry / market caps)', () => {
  it('populates industry and caps when the clist carries f100/f20/f21', async () => {
    const diff = [
      { f12: '600519', f13: 1, f14: '茅台', f26: 20010827, f100: '白酒', f20: 2.1e12, f21: 2.1e12 },
      { f12: '000001', f13: 0, f14: '平安银行', f26: 19910403, f100: '-', f20: '-', f21: 0 },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { total: 2, diff } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const stocks = await dataSource.listStocks(new AbortController().signal)
    expect(stocks[0]).toMatchObject({ industry: '白酒', totalMarketCapYuan: 2.1e12, floatMarketCapYuan: 2.1e12 })
    // Placeholder industry ('-') and non-finite caps degrade to undefined.
    expect(stocks[1]!.industry).toBeUndefined()
    expect(stocks[1]!.totalMarketCapYuan).toBeUndefined()
    expect(stocks[1]!.floatMarketCapYuan).toBeUndefined()
  })
})

describe('eastmoney kline amount', () => {
  it('parses the traded-value column into Bar.amount', async () => {
    const kline = { data: { klines: ['2026-08-20,10,10.5,10.6,9.9,1000,1050000000,7.0'] } }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(kline), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const bars = await dataSource.dailyBars('600519.SH', '20200101', new AbortController().signal)
    expect(bars).toHaveLength(1)
    expect(bars[0]!.amount).toBe(1_050_000_000)
  })

  it('tolerates rows without the amount column (null)', async () => {
    const kline = { data: { klines: ['2026-08-20,10,10.5,10.6,9.9,1000'] } }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(kline), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const bars = await dataSource.dailyBars('600519.SH', '20200101', new AbortController().signal)
    expect(bars[0]!.amount).toBeNull()
  })
})
