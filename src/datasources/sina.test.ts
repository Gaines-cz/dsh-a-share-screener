import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../http.js'
import { createSinaDataSource, parseJsonp, sinaSymbol } from './sina.js'

const signal = (): AbortSignal => new AbortController().signal

const JSONP =
  "/*<script>location.href='//sina.com';</script>*/\n" +
  'var _=([{"day":"2026-08-17","open":"25.750","high":"26.360","low":"25.250","close":"26.310","volume":"8009811"},' +
  '{"day":"2026-08-18","open":"26.420","high":"26.450","low":"25.860","close":"26.130","volume":"6220383"},' +
  '{"day":"2026-08-19","open":"25.800","high":"25.980","low":"24.950","close":"24.970","volume":"6635909"}])'

describe('sina datasource', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps fullCode to sina symbol', () => {
    expect(sinaSymbol('600962.SH')).toBe('sh600962')
    expect(sinaSymbol('002234.SZ')).toBe('sz002234')
    expect(sinaSymbol('920169.BJ')).toBe('bj920169')
  })

  it('parses the JSONP payload', () => {
    const rows = parseJsonp(JSONP)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ day: '2026-08-17', close: '26.310' })
  })

  it('throws on a non-JSONP response (blocked/verification page)', () => {
    expect(() => parseJsonp('<html><script>location.href="//sina.com"</script></html>')).toThrow()
  })

  it('dailyBars converts volume to lots, filters by startDate, sorts ascending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => JSONP }))
    const ds = createSinaDataSource(new RateLimiter(1000))
    const bars = await ds.dailyBars('600962.SH', '20260818', signal())
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ date: '20260818', close: 26.13, preClose: null })
    expect(bars[0]!.volume).toBeCloseTo(62203.83, 1) // 6220383 shares → 手
    expect(bars[1]!.date).toBe('20260819')
  })

  it('surfaces fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const ds = createSinaDataSource(new RateLimiter(1000))
    await expect(ds.dailyBars('600962.SH', '20260801', signal())).rejects.toThrow(/HTTP 503/)
  })
})
