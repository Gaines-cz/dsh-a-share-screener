import { afterEach, describe, expect, it, vi } from 'vitest'
import { tencentDailyBars } from './datasources/tencent.js'
import { RateLimiter } from './http.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const limiter = new RateLimiter(600_000)
const signal = new AbortController().signal

/** Sequential ISO dates stepping backward one day each, from `startIso` (YYYY-MM-DD). */
function isoDates(count: number, startIso: string): string[] {
  const out: string[] = []
  const date = new Date(`${startIso}T00:00:00Z`)
  for (let i = 0; i < count; i++) {
    out.push(date.toISOString().slice(0, 10))
    date.setUTCDate(date.getUTCDate() - 1)
  }
  return out
}

/** Day before an ISO date — how the adapter computes the next page's window end. */
function dayBefore(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

function row(date: string, close: number): string[] {
  return [date, String(close), String(close), String(close), String(close), '1000']
}

/** Build a tencent page payload: `rows` tuples [date, open, close, high, low, volume]. */
function page(symbol: string, rows: string[][]): object {
  return {
    code: 0,
    data: { [symbol]: { hfqday: rows } },
  }
}

describe('tencentDailyBars pagination', () => {
  it('pages backward across 640-row pages, dedupes, filters to startDate, and sorts', async () => {
    const page1Dates = isoDates(640, '2026-12-31')
    const page2Dates = isoDates(640, dayBefore(page1Dates[page1Dates.length - 1]!))
    const page3Dates = isoDates(100, dayBefore(page2Dates[page2Dates.length - 1]!))
    const expected = [...page1Dates, ...page2Dates, ...page3Dates].filter((d) => d.replace(/\D/g, '') >= '20250101')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('sh600519', page1Dates.map((d) => row(d, 10)))), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('sh600519', page2Dates.map((d) => row(d, 9)))), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('sh600519', page3Dates.map((d) => row(d, 8)))), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const bars = await tencentDailyBars('600519.SH', '20250101', limiter, signal)
    expect(bars.length).toBe(expected.length)
    expect(bars[0]!.date).toBe(expected[expected.length - 1]!.replace(/\D/g, ''))
    expect(bars.at(-1)!.date).toBe(expected[0]!.replace(/\D/g, ''))
    // Ascending and deduped.
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.date > bars[i - 1]!.date).toBe(true)
    }
  })

  it('drops rows with non-positive prices', async () => {
    const bad = [
      row('2026-01-01', 10),
      ['2026-01-02', '0', '0', '0', '0', '1000'],
      row('2026-01-03', 11),
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('sz300750', bad)), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const bars = await tencentDailyBars('300750.SZ', '20260101', limiter, signal)
    expect(bars).toHaveLength(2)
  })
})
