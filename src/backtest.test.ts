import { describe, expect, it } from 'vitest'
import {
  asOfIndex,
  assertBacktestable,
  chainedIndex,
  forwardReturn,
  historyBarsForBacktest,
  isValidYmd,
  medianOf,
  monthlySteps,
  parseHorizons,
  quantile,
  renderBacktestMarkdown,
  runBacktest,
  screenAsOf,
  type BacktestResult,
} from './backtest.js'
import { composeStrategy } from './engine/compose.js'
import { createFilterRegistry } from './filters/index.js'
import { historyStartDate } from './screener.js'
import type { Strategy, StrategyParams } from './strategies/registry.js'
import { dateMinusDays, ymd, type SeriesBar, type StockMeta } from './types.js'

/** Calendar date i days after 2025-01-01, UTC-formatted YYYYMMDD. */
function dateAt(i: number): string {
  const d = new Date(Date.UTC(2025, 0, 1 + i))
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

/** Series with chained closes from per-bar returns (volume constant). */
function series(rets: (number | null)[], startClose = 10): SeriesBar[] {
  let close = startClose
  return rets.map((ret, i) => {
    if (i > 0 && ret !== null) close *= 1 + ret
    return { date: dateAt(i), close, volume: 1000, ret }
  })
}

/** 320-bar profile: +1%/bar for 100, -1%/bar for 120, flat for 100 → deep drawdown afterwards. */
function deepDrawdownBars(): SeriesBar[] {
  return series([
    ...Array.from({ length: 100 }, () => 0.01),
    ...Array.from({ length: 120 }, () => -0.01),
    ...Array.from({ length: 100 }, () => 0),
  ])
}

const ddStrategy: Strategy = composeStrategy({
  id: 'dd_test',
  description: 'test-only deep drawdown',
  predicate: { kind: 'filter', filter: 'deep_drawdown' },
  filters: createFilterRegistry(),
})

const DD_PARAMS: StrategyParams = { minDrawdownFromHigh: 0.5, minBars: 240 }

/** Minimal strategy stub with injected data requirements. */
function stubStrategy(requires: Strategy['requires']): Strategy {
  return { id: 'stub', description: 'stub', paramDocs: {}, requires, screen: () => null }
}

describe('isValidYmd / monthlySteps', () => {
  it('accepts real calendar dates, rejects malformed ones', () => {
    expect(isValidYmd('20260228')).toBe(true)
    expect(isValidYmd('20260229')).toBe(false) // 2026 is not a leap year
    expect(isValidYmd('20240229')).toBe(true)
    expect(isValidYmd('20260230')).toBe(false)
    expect(isValidYmd('20261301')).toBe(false)
    expect(isValidYmd('2026-01-01')).toBe(false)
    expect(isValidYmd('2026011')).toBe(false)
  })

  it('steps back monthly from the anchor, clamping the day to the month length', () => {
    expect(monthlySteps('20260331', 3)).toEqual(['20260131', '20260228', '20260331'])
    expect(monthlySteps('20260331', 1)).toEqual(['20260331'])
    expect(monthlySteps('20260131', 13)).toHaveLength(13)
    expect(monthlySteps('20260131', 13)[0]).toBe('20250131')
  })

  it('returns strictly ascending, unique dates', () => {
    const steps = monthlySteps('20261231', 24)
    expect(steps).toEqual([...steps].sort())
    expect(new Set(steps).size).toBe(steps.length)
  })

  it('fails loudly on a bad anchor or month count', () => {
    expect(() => monthlySteps('20260230', 3)).toThrow(/invalid as-of date/)
    expect(() => monthlySteps('abcd', 3)).toThrow(/invalid as-of date/)
    expect(() => monthlySteps('20260331', 0)).toThrow(/months/)
    expect(() => monthlySteps('20260331', 12.5)).toThrow(/months/)
  })
})

describe('parseHorizons', () => {
  it('defaults to 5/20/60 and normalizes order + duplicates', () => {
    expect(parseHorizons(undefined)).toEqual([5, 20, 60])
    expect(parseHorizons('')).toEqual([5, 20, 60])
    expect(parseHorizons('20,5,5')).toEqual([5, 20])
  })

  it('rejects non-integer or out-of-range horizons', () => {
    expect(() => parseHorizons('0')).toThrow(/horizon/)
    expect(() => parseHorizons('501')).toThrow(/horizon/)
    expect(() => parseHorizons('2.5')).toThrow(/horizon/)
    expect(() => parseHorizons('abc')).toThrow(/horizon/)
  })

  it('widens the window so the oldest as-of keeps the full history beneath it', () => {
    // ~365 calendar days back → ~243 extra bars + buffer 10 → 800 + 254 ≈ 1054.
    const widened = historyBarsForBacktest(800, '20250912', '20260912')
    expect(widened).toBe(800 + Math.ceil(365 / 1.5) + 10)
    // No widening when the anchor already is today.
    expect(historyBarsForBacktest(800, '20260912', '20260912')).toBe(800 + 10)
    // A future anchor (silly input) must not shrink the window.
    expect(historyBarsForBacktest(800, '20270912', '20260912')).toBe(810)
  })

  it('end-to-end: the widened window really leaves >= requestedBars trading bars below the oldest as-of', () => {
    // Pessimistic calendar: weekdays minus every 12th weekday ≈ 239 trading
    // days/year — worse than the ~243 A-share average the 1.5x factor
    // assumes, so holiday-dense spans cannot silently break the guarantee.
    const tradingDaysBetween = (fromYmd: string, toYmdStr: string): number => {
      const days: string[] = []
      let cursor = fromYmd
      while (cursor < toYmdStr) {
        const dow = new Date(Date.UTC(+cursor.slice(0, 4), +cursor.slice(4, 6) - 1, +cursor.slice(6, 8))).getUTCDay()
        if (dow !== 0 && dow !== 6) days.push(cursor)
        cursor = dateMinusDays(cursor, -1)
      }
      return days.filter((_, i) => i % 12 !== 11).length
    }
    const today = ymd(new Date())
    for (const requestedBars of [250, 800]) {
      for (const daysBack of [90, 365, 730]) {
        const oldestAsOf = dateMinusDays(today, daysBack)
        const startDate = historyStartDate(historyBarsForBacktest(requestedBars, oldestAsOf, today))
        expect(tradingDaysBetween(startDate, oldestAsOf)).toBeGreaterThanOrEqual(requestedBars)
      }
    }
  })
})

describe('asOfIndex / chainedIndex / forwardReturn', () => {
  const bars = series([null, 0.1, -0.05, 0.02])

  it('finds the last bar on or before the as-of date', () => {
    expect(asOfIndex(bars, dateAt(0))).toBe(0)
    expect(asOfIndex(bars, dateAt(2))).toBe(2)
    expect(asOfIndex(bars, dateAt(1))).toBe(1)
    expect(asOfIndex(bars, '20240101')).toBe(-1) // before listing
    expect(asOfIndex(bars, dateAt(99))).toBe(3) // after the last bar
  })

  it('resolves an as-of between two bar dates to the earlier bar', () => {
    // Bars printed on days 0, 1, 5, 6 — an as-of on day 3 must slice after bar 1.
    const gapped = series([null, 0.01, 0.01, 0.01]).map((bar, i) => ({ ...bar, date: dateAt([0, 1, 5, 6][i]!) }))
    expect(asOfIndex(gapped, dateAt(3))).toBe(1)
  })

  it('chains the return index, treating null rets as flat', () => {
    // rets = [null, 0.1, -0.05, 0.02] → idx = [1, 1.1, 1.045, 1.0659]; the null
    // first-bar ret never enters the chain (loop starts at i = 1).
    const idx = chainedIndex(bars)
    const expected = [1, 1.1, 1.1 * 0.95, 1.1 * 0.95 * 1.02]
    expect(idx).toHaveLength(expected.length)
    for (let i = 0; i < expected.length; i++) expect(idx[i]).toBeCloseTo(expected[i]!, 12)
  })

  it('clamps a corrupt ret ≤ -1 instead of poisoning the chain', () => {
    const idx = chainedIndex(series([null, 0.01, -2, 0.01]))
    expect(idx[2]).toBeCloseTo(idx[1]! * 1e-9, 15)
    expect(idx[3]).toBeGreaterThan(0)
  })

  it('returns an empty index for an empty series', () => {
    expect(chainedIndex([])).toEqual([])
  })

  it('computes forward returns and nulls beyond the data end', () => {
    const idx = [1, 1.1, 1.21, 1.331]
    expect(forwardReturn(idx, 0, 2)).toBeCloseTo(0.21, 12)
    expect(forwardReturn(idx, 1, 2)).toBeCloseTo(1.331 / 1.1 - 1, 12)
    expect(forwardReturn(idx, 0, 5)).toBeNull()
    expect(forwardReturn(idx, -1, 1)).toBeNull()
  })
})

describe('quantile / medianOf', () => {
  it('interpolates linearly and handles degenerate inputs', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([5], 0.5)).toBe(5)
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75)
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25)
    expect(medianOf([1, 2, 3, 4])).toBe(2.5)
    expect(medianOf([3, 1, 2])).toBe(2)
    expect(medianOf([])).toBeNull()
    const input = [3, 1, 2]
    medianOf(input)
    expect(input).toEqual([3, 1, 2]) // not mutated
  })
})

describe('assertBacktestable', () => {
  it('refuses gates computed from today-only inputs', () => {
    expect(() => assertBacktestable(stubStrategy({ industry: true }))).toThrow(/industry aggregation/)
    expect(() => assertBacktestable(stubStrategy({ marketCap: true }))).toThrow(/market-cap snapshot/)
  })

  it('allows price/volume-only and per-bar-amount requirements', () => {
    expect(() => assertBacktestable(stubStrategy(undefined))).not.toThrow()
    expect(() => assertBacktestable(stubStrategy({ amount: true }))).not.toThrow()
  })
})

describe('runBacktest', () => {
  const hitStock: StockMeta = META
  const flatStock: StockMeta = { ...META, code: '600002', fullCode: '600002.SH' }
  const upStock: StockMeta = { ...META, code: '600003', fullCode: '600003.SH' }

  it('evaluates each as-of date with past bars only and pools forward returns', async () => {
    const hitBars = deepDrawdownBars()
    const flatBars = series(Array.from({ length: 320 }, () => 0))
    const upBars = series(Array.from({ length: 320 }, () => 0.005))
    const byCode = new Map<string, SeriesBar[]>([
      ['600001', hitBars],
      ['600002', flatBars],
      ['600003', upBars],
    ])
    const asOfDates = [dateAt(250), dateAt(280)]
    const result = await runBacktest({
      strategy: ddStrategy,
      params: DD_PARAMS,
      stocks: [hitStock, flatStock, upStock],
      asOfDates,
      horizons: [5, 20],
      acquireBars: async (stock) => byCode.get(stock.code)!,
    })

    // Both dates slice past bar 240 (floor = max(60, minBars 240)) → all evaluable.
    expect(result.asOfResults.map((r) => r.evaluable)).toEqual([3, 3])
    // Only the deep-drawdown stock hits, at both dates.
    for (const r of result.asOfResults) {
      expect(r.hits.map((h) => h.code)).toEqual(['600001'])
      expect(r.hits[0]!.asOfBarDate).toBe(r.asOf)
    }
    // Forward returns match a manual computation on the full-series index.
    const idx = chainedIndex(hitBars)
    const hit0 = result.asOfResults[0]!.hits[0]!
    expect(hit0.forward['5']).toBeCloseTo(forwardReturn(idx, 250, 5)!, 12)
    expect(hit0.forward['20']).toBeCloseTo(forwardReturn(idx, 250, 20)!, 12)
    expect(hit0.close).toBe(hitBars[250]!.close)
    // Baseline = median forward return over all three stocks at that (date, horizon).
    for (const r of result.asOfResults) {
      const i = asOfDates.indexOf(r.asOf)
      const asOfIdx = i === 0 ? 250 : 280
      for (const stat of r.horizons) {
        const values = [hitBars, flatBars, upBars].map((b) => forwardReturn(chainedIndex(b), asOfIdx, stat.horizon)!)
        expect(stat.baselineMedian).toBeCloseTo(medianOf(values)!, 12)
        expect(stat.excessMedian).toBeCloseTo(stat.hitMedian! - stat.baselineMedian!, 12)
      }
      expect(r.horizons.every((stat) => stat.observations === 1)).toBe(true)
    }
    // Pooled: 2 dates × 1 hit each, horizons kept separate; the pooled baseline
    // pools the SAME (stock × date) observations flat, so hit/baseline medians
    // aggregate at the same level (like-for-like excess).
    expect(result.pooled.map((p) => [p.horizon, p.observations])).toEqual([
      [5, 2],
      [20, 2],
    ])
    for (const stat of result.pooled) {
      const flat: number[] = []
      for (const bars of [hitBars, flatBars, upBars]) {
        for (const asOfIdx of [250, 280]) {
          const fr = forwardReturn(chainedIndex(bars), asOfIdx, stat.horizon)
          if (fr !== null) flat.push(fr)
        }
      }
      expect(stat.baselineMedian).toBeCloseTo(medianOf(flat)!, 12)
      expect(stat.excessMedian).toBeCloseTo(stat.hitMedian! - stat.baselineMedian!, 12)
    }
    expect(result.stocksEvaluated).toBe(3)
    expect(result.skipped).toEqual({})
    expect(result.notes.join(' ')).toContain('correlated observations')
  })

  it('seeds universe-level exclusions into the report and never overwrites fetch failures', async () => {
    const result = await runBacktest({
      strategy: ddStrategy,
      params: DD_PARAMS,
      stocks: [hitStock],
      asOfDates: [dateAt(250)],
      horizons: [5],
      acquireBars: async () => deepDrawdownBars(),
      universeSkipped: { 'st-or-delisting': 478, bse: 344 },
    })
    expect(result.skipped).toEqual({ 'st-or-delisting': 478, bse: 344 })
    const withFailure = await runBacktest({
      strategy: ddStrategy,
      params: DD_PARAMS,
      stocks: [hitStock, flatStock],
      asOfDates: [dateAt(250)],
      horizons: [5],
      acquireBars: async (stock) => (stock.code === '600002' ? null : deepDrawdownBars()),
      universeSkipped: { 'st-or-delisting': 478 },
    })
    expect(withFailure.skipped).toEqual({ 'st-or-delisting': 478, 'kline-fetch-failed': 1 })
  })

  it('produces identical results regardless of acquisition concurrency', async () => {
    const byCode = new Map<string, SeriesBar[]>([
      ['600001', deepDrawdownBars()],
      ['600002', series(Array.from({ length: 320 }, () => 0))],
      ['600003', series(Array.from({ length: 320 }, () => 0.005))],
    ])
    const run = async (concurrency: number): Promise<BacktestResult> =>
      runBacktest({
        strategy: ddStrategy,
        params: DD_PARAMS,
        stocks: [hitStock, flatStock, upStock],
        asOfDates: [dateAt(250), dateAt(280)],
        horizons: [5, 20],
        concurrency,
        // A microtask hop per acquire so workers actually interleave.
        acquireBars: async (stock) => {
          await Promise.resolve()
          return byCode.get(stock.code)!
        },
      })
    const serial = await run(1)
    const concurrent = await run(4)
    const strip = (r: BacktestResult): unknown => {
      const { generatedAt, ...rest } = r
      void generatedAt
      return rest
    }
    expect(strip(concurrent)).toEqual(strip(serial))
  })

  it('excludes stocks not yet listed (or too young) at an as-of date', async () => {
    const lateBars = series(Array.from({ length: 70 }, () => 0), 10).map((bar, i) => ({
      ...bar,
      date: dateAt(250 + i),
    }))
    const lateStock: StockMeta = { ...META, code: '600004', fullCode: '600004.SH' }
    const result = await runBacktest({
      strategy: ddStrategy,
      params: DD_PARAMS,
      stocks: [META, lateStock],
      asOfDates: [dateAt(260)],
      horizons: [5],
      acquireBars: async (stock) => (stock.code === '600004' ? lateBars : deepDrawdownBars()),
    })
    // At dateAt(260): META has 261 bars (eligible), the late stock has 11 (< floor 240).
    expect(result.asOfResults[0]!.evaluable).toBe(1)
    expect(result.asOfResults[0]!.hits.map((h) => h.code)).toEqual(['600001'])
  })

  it('counts acquisition failures and continues', async () => {
    const result = await runBacktest({
      strategy: ddStrategy,
      params: DD_PARAMS,
      stocks: [hitStock, flatStock],
      asOfDates: [dateAt(250)],
      horizons: [5],
      acquireBars: async (stock) => (stock.code === '600002' ? null : deepDrawdownBars()),
    })
    expect(result.skipped['kline-fetch-failed']).toBe(1)
    expect(result.stocksEvaluated).toBe(1)
  })

  it('stops workers on an aborted signal instead of miscounting fetch failures', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await expect(
      runBacktest({
        strategy: ddStrategy,
        params: DD_PARAMS,
        stocks: [hitStock, flatStock],
        asOfDates: [dateAt(250)],
        horizons: [5],
        signal: controller.signal,
        acquireBars: async () => {
          calls++
          return deepDrawdownBars()
        },
      }),
    ).rejects.toThrow(/aborted/)
    // The top-of-loop guard fires before any acquire attempt: no fetch, no
    // kline-fetch-failed miscount.
    expect(calls).toBe(0)
  })

  it('refuses industry/market-cap strategies and bad date/horizon inputs', async () => {
    await expect(
      runBacktest({
        strategy: stubStrategy({ industry: true }),
        params: {},
        stocks: [],
        asOfDates: ['20260101'],
        horizons: [5],
        acquireBars: async () => [],
      }),
    ).rejects.toThrow(/industry aggregation/)
    await expect(
      runBacktest({
        strategy: ddStrategy,
        params: DD_PARAMS,
        stocks: [],
        asOfDates: ['20260102', '20260101'],
        horizons: [5],
        acquireBars: async () => [],
      }),
    ).rejects.toThrow(/strictly ascending/)
    await expect(
      runBacktest({
        strategy: ddStrategy,
        params: DD_PARAMS,
        stocks: [],
        asOfDates: ['20260101'],
        horizons: [],
        acquireBars: async () => [],
      }),
    ).rejects.toThrow(/horizons/)
  })
})

describe('no look-ahead leakage', () => {
  it('mutating bars AFTER the as-of date cannot change the as-of result', () => {
    const bars = deepDrawdownBars()
    const asOf = dateAt(250)
    const before = screenAsOf(ddStrategy, META, bars, asOf, DD_PARAMS)
    expect(before).not.toBeNull() // the fixture genuinely hits at bar 250
    const mutated = bars.map((bar, i) =>
      i > 250 ? { ...bar, ret: i % 2 === 0 ? 0.098 : -0.098 } : bar,
    )
    const after = screenAsOf(ddStrategy, META, mutated, asOf, DD_PARAMS)
    expect(after).toEqual(before)
  })

  it('an as-of before the stock listed evaluates to null', () => {
    expect(screenAsOf(ddStrategy, META, deepDrawdownBars(), '20240101', DD_PARAMS)).toBeNull()
  })
})

describe('renderBacktestMarkdown', () => {
  let result: BacktestResult

  it('renders the loud bias section, per-date table, pooled table and detail rows', async () => {
    const hitBars = deepDrawdownBars()
    result = await runBacktest({
      strategy: ddStrategy,
      params: DD_PARAMS,
      stocks: [META, { ...META, code: '600002', fullCode: '600002.SH' }],
      asOfDates: [dateAt(250), dateAt(280)],
      horizons: [5, 20],
      acquireBars: async (stock) => (stock.code === '600002' ? series(Array.from({ length: 320 }, () => 0)) : hitBars),
      source: 'sina',
      scope: '测试范围 (2只)',
    })
    const md = renderBacktestMarkdown(result)
    expect(md).toContain('# 回测报告 (lite) — dd_test')
    expect(md).toContain('方法与偏差声明')
    expect(md).toContain('幸存者偏差')
    expect(md).toContain('| 时点 | 实际数据日 | 可评估 | 命中 | 窗口 |')
    expect(md).toContain('| 窗口 | 观测数 | 命中中位 |')
    expect(md).toContain('基准中位(合并口径)')
    expect(md).toContain('## 三、命中明细 (2 行)')
    expect(md).toContain(dateAt(250))
    expect(md).toContain('| 时点 | 实际数据日 | 代码 | 名称 | 板块 | 时点收盘 |')
    expect(md).toContain('| 5日 | 20日 |')
    expect(md).toContain('不构成投资建议')
    // The canonical disclaimer (shared with the JSON payload) is rendered in
    // full so the two artifacts cannot drift apart.
    expect(md).toContain(result.disclaimer)
    expect(md).toContain('survivorship bias')
  })

  it('caps detail rows and says so', async () => {
    const md = renderBacktestMarkdown(result, 1)
    expect(md).toContain('仅列前 1 行')
    expect(md).toContain('## 三、命中明细 (2 行, 仅列前 1 行)')
  })

  it('keeps the result JSON-serializable with string horizon keys', () => {
    const roundTripped = JSON.parse(JSON.stringify(result)) as BacktestResult
    expect(roundTripped.asOfResults[0]!.hits[0]!.forward['5']).toBeCloseTo(result.asOfResults[0]!.hits[0]!.forward['5']!, 12)
    expect(Object.keys(roundTripped.asOfResults[0]!.hits[0]!.forward)).toEqual(['5', '20'])
  })
})
