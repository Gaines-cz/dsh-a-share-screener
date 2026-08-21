import { afterEach, describe, expect, it, vi } from 'vitest'
import { tushareDailyForDate } from './datasources/tushare.js'
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
