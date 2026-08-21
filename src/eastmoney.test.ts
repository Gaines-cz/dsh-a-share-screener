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