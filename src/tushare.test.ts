import { afterEach, describe, expect, it, vi } from 'vitest'
import { tushareDailyForDate, tushareListStocks } from './datasources/tushare.js'
import { RateLimiter } from './http.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const limiter = new RateLimiter(600_000)
const deps = { token: 'test-token', limiter }
const signal = new AbortController().signal

function tushareOk(items: unknown[][]): object {
  return {
    code: 0,
    data: { fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'vol'], items },
  }
}

describe('tushareDailyForDate row validation', () => {
  it('drops rows with non-positive closes, malformed codes, and missing fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          tushareOk([
            ['600001.SH', '20260101', 10, 10.5, 9.8, 10.2, 10, 1000],
            ['600002.SH', '20260101', 10, 10.5, 9.8, 0, 10, 1000], // close = 0
            ['BAD/CODE', '20260101', 10, 10.5, 9.8, 10.2, 10, 1000], // malformed code
            ['600004.SH', '20260101', 'None', 10.5, 9.8, 10.2, 10, 1000], // missing open
          ]),
        ),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await tushareDailyForDate('20260101', deps, signal)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.fullCode).toBe('600001.SH')
    expect(rows[0]!.bar.close).toBe(10.2)
  })
})

describe('tushare callApi error handling', () => {
  it('retries rate-limit rejections with backoff, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: -1, msg: '抱歉，您每分钟最多访问该接口500次' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: -1, msg: '抱歉，您每分钟最多访问该接口500次' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(tushareOk([['600001.SH', '20260101', 10, 10.5, 9.8, 10.2, 10, 1000]])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const rows = await tushareDailyForDate('20260101', deps, signal)
    expect(rows).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails loudly on non-rate-limit API errors without retrying', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: -1, msg: '积分不足' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(tushareDailyForDate('20260101', deps, signal)).rejects.toThrow(/积分不足/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('tushareListStocks industry mapping', () => {
  it('maps Shenwan industry and treats null/empty as undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            fields: ['ts_code', 'name', 'list_date', 'industry'],
            items: [
              ['600001.SH', '浦发银行', '19991110', '银行'],
              ['300750.SZ', '宁德时代', '20180611', '电力设备'],
              ['600002.SH', 'ST某某', '19980101', null],
              ['000001.SZ', '平安银行', '19910403', ''],
            ],
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const stocks = await tushareListStocks(deps, signal)
    expect(stocks).toHaveLength(4)
    expect(stocks[0]!.industry).toBe('银行')
    expect(stocks[1]!.industry).toBe('电力设备')
    expect(stocks[2]!.industry).toBeUndefined()
    expect(stocks[3]!.industry).toBeUndefined()
  })
})
