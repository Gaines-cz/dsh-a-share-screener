import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../http.js'
import { createTencentDataSource, parseRows, tencentSymbol } from './tencent.js'

const signal = (): AbortSignal => new AbortController().signal

/** Tencent row order: [date, open, close, high, low, volume, extra?]. */
const HFQ_ROWS: unknown[] = [
  ['2026-08-19', '25.800', '24.970', '25.980', '24.950', '66359.000'],
  ['2026-08-20', '25.130', '25.260', '25.470', '24.810', '54189.000'],
  ['2026-08-21', '25.000', '25.430', '25.550', '24.620', '47956.000'],
]

function klineJson(rows: unknown[]): string {
  return JSON.stringify({ code: 0, msg: '', data: { sh600962: { hfqday: rows } } })
}

describe('tencent datasource', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps fullCode to tencent symbol', () => {
    expect(tencentSymbol('600962.SH')).toBe('sh600962')
    expect(tencentSymbol('002234.SZ')).toBe('sz002234')
    expect(tencentSymbol('920169.BJ')).toBe('bj920169')
  })

  it('parses rows with tencent column order', () => {
    const bars = parseRows(HFQ_ROWS)
    expect(bars).toHaveLength(3)
    expect(bars[0]).toMatchObject({ date: '20260819', open: 25.8, close: 24.97, high: 25.98, low: 24.95, volume: 66359 })
    expect(bars[0]!.preClose).toBeNull()
  })

  it('dailyBars parses, filters by startDate and sorts ascending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => JSON.parse(klineJson(HFQ_ROWS)) }))
    const ds = createTencentDataSource(new RateLimiter(1000))
    const bars = await ds.dailyBars('600962.SH', '20260820', signal())
    expect(bars).toHaveLength(2)
    expect(bars[0]!.date).toBe('20260820')
    expect(bars[1]!.date).toBe('20260821')
  })

  it('fails over to the second host when the first errors', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        calls++
        if (calls === 1) throw new Error('host1 down')
        expect(String(url)).toContain('proxy.finance.qq.com')
        return { ok: true, json: async () => JSON.parse(klineJson(HFQ_ROWS)) }
      }),
    )
    const ds = createTencentDataSource(new RateLimiter(1000))
    const bars = await ds.dailyBars('600962.SH', '20260801', signal())
    expect(bars).toHaveLength(3)
  })
})
