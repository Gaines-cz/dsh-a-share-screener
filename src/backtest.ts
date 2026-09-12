/**
 * Backtest-lite: historical as-of evaluation of a strategy over cached bars.
 *
 * For each as-of date the strategy sees ONLY the bars printed up to that date
 * (prefix slice), so no future data can leak into a gate; forward returns are
 * measured on the chained return index of the full series. The hit pool is
 * compared against a same-date universe baseline (median forward return) so
 * market drift is subtracted from every number.
 *
 * Loud limits, never silent degradation:
 * - strategies whose gates need industry aggregation or a market-cap snapshot
 *   are REFUSED — those inputs are computed from today's data and would be
 *   anachronistic at a historical as-of date (per-bar amounts are historical
 *   and therefore fine);
 * - the survivorship/short-history biases that cannot be avoided (the cached
 *   universe is today's listing) are spelled out in the report disclaimer.
 *
 * Use the numbers for RELATIVE comparison (threshold A vs threshold B), not
 * as return forecasts. @module a-share-screener/backtest
 */
import type { Strategy, StrategyHit, StrategyParams } from './strategies/registry.js'
import type { Board, SeriesBar, StockMeta } from './types.js'

export const BACKTEST_DISCLAIMER =
  'Backtest-lite evaluates a strategy at historical as-of dates using only past bars (no look-ahead). ' +
  "The universe is TODAY'S listing (survivorship bias inflates results); ST/listing-age metadata are current " +
  'snapshots; the same stock hitting at adjacent dates yields correlated observations. Use for relative ' +
  'comparison of thresholds/strategies, NOT as return forecasts or investment advice.'

/** Month length, 1-based month, proleptic Gregorian. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whether a string is a real YYYYMMDD calendar date. */
export function isValidYmd(s: string): boolean {
  if (!/^\d{8}$/.test(s)) return false
  const year = Number(s.slice(0, 4))
  const month = Number(s.slice(4, 6))
  const day = Number(s.slice(6, 8))
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

/**
 * Monthly as-of dates ending at `anchorYmd` (inclusive), ASCENDING:
 * [anchor-(months-1), …, anchor-1m, anchor]. Day-of-month clamps to the target
 * month's length (e.g. anchor 20260331 steps over 20260228).
 */
export function monthlySteps(anchorYmd: string, months: number): string[] {
  if (!isValidYmd(anchorYmd)) throw new Error(`invalid as-of date '${anchorYmd}' (expected YYYYMMDD)`)
  if (!Number.isInteger(months) || months < 1 || months > 60) {
    throw new Error(`months must be an integer in [1, 60], got ${months}`)
  }
  const y = Number(anchorYmd.slice(0, 4))
  const m = Number(anchorYmd.slice(4, 6))
  const d = Number(anchorYmd.slice(6, 8))
  const out: string[] = []
  for (let k = months - 1; k >= 0; k--) {
    let mm = m - k
    let yy = y
    while (mm <= 0) {
      mm += 12
      yy--
    }
    const day = Math.min(d, daysInMonth(yy, mm))
    out.push(`${yy}${String(mm).padStart(2, '0')}${String(day).padStart(2, '0')}`)
  }
  return out
}

/** Parse a comma-separated horizon list ("5,20,60") into unique ascending bar counts. */
export function parseHorizons(raw: string | undefined): number[] {
  const text = raw === undefined || raw.trim() === '' ? '5,20,60' : raw
  const seen = new Set<number>()
  for (const part of text.split(',')) {
    const n = Number(part.trim())
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw new Error(`invalid horizon '${part}' (expected integer in [1, 500])`)
    }
    seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

/** UTC epoch of a YYYYMMDD string. */
function ymdToUtc(s: string): number {
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
}

/**
 * Widen the lookback window so the OLDEST as-of date still sits on the full
 * requested bar history beneath it. Without this, a 12-month backtest on the
 * default 800-bar window would evaluate old dates over a silently clamped
 * percentile/flat window (~557 bars) — exactly the silent degradation this
 * project refuses to commit. Conversion mirrors historyStartDate's 1.5x
 * calendar→trading factor plus a small buffer; the first widened run
 * backfills the cache (same cost as the initial sync).
 */
export function historyBarsForBacktest(requestedBars: number, oldestAsOf: string, todayYmdStr: string): number {
  const daysBack = Math.max(0, Math.ceil((ymdToUtc(todayYmdStr) - ymdToUtc(oldestAsOf)) / 86_400_000))
  return requestedBars + Math.ceil(daysBack / 1.5) + 10
}

/** Index of the last bar with date ≤ asOf; -1 when the stock had not listed yet. */
export function asOfIndex(bars: SeriesBar[], asOf: string): number {
  let i = -1
  for (let k = 0; k < bars.length; k++) {
    if (bars[k]!.date <= asOf) i = k
    else break
  }
  return i
}

/**
 * Chained return index over the full series, with the same strictly-positive
 * clamp as {@link derive} (a corrupt ret ≤ -1 must not poison downstream
 * ratios). Prefix values are identical to an index computed over a prefix
 * slice — this is what makes as-of evaluation leak-free.
 */
export function chainedIndex(bars: SeriesBar[]): number[] {
  if (bars.length === 0) return []
  const idx: number[] = new Array(bars.length)
  idx[0] = 1
  for (let i = 1; i < bars.length; i++) {
    const ret = bars[i]!.ret
    idx[i] = idx[i - 1]! * Math.max(1e-9, 1 + (ret === null ? 0 : ret))
  }
  return idx
}

/** Forward return over `horizon` bars after the as-of bar; null when not measurable. */
export function forwardReturn(idx: number[], asOfIdx: number, horizon: number): number | null {
  const end = asOfIdx + horizon
  if (asOfIdx < 0 || end >= idx.length) return null
  const base = idx[asOfIdx]!
  return base > 0 ? idx[end]! / base - 1 : null
}

/** Linear-interpolation quantile over an already-ASCENDING array; null when empty. */
export function quantile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null
  const pos = (sortedAsc.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sortedAsc[lo]!
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo)
}

/** Median via sort + quantile(0.5); the input is NOT mutated. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  return quantile([...values].sort((a, b) => a - b), 0.5)
}

/**
 * Evaluate a strategy exactly as it would have run on `asOf`: it only ever
 * sees the bar prefix up to that date. Appending or mutating bars AFTER the
 * as-of date cannot change the result — the leak-free property tests assert.
 */
export function screenAsOf(
  strategy: Strategy,
  stock: StockMeta,
  bars: SeriesBar[],
  asOf: string,
  params: StrategyParams,
): StrategyHit | null {
  const i = asOfIndex(bars, asOf)
  if (i < 0) return null
  return strategy.screen({ stock, bars: bars.slice(0, i + 1) }, params)
}

/**
 * Refuse strategies whose gates depend on today-computed inputs: industry
 * aggregation is built from current bars, and market-cap/turnover filters use
 * the current float snapshot. Evaluating them "as of" a past date would inject
 * future data into a gate — a silent degradation this module never commits.
 */
export function assertBacktestable(strategy: Strategy): void {
  const req = strategy.requires
  if (!req) return
  const anachronistic: string[] = []
  if (req.industry) anachronistic.push('industry aggregation')
  if (req.marketCap) anachronistic.push('market-cap snapshot')
  if (anachronistic.length > 0) {
    throw new Error(
      `strategy '${strategy.id}' needs ${anachronistic.join(', ')} — inputs computed from TODAY's data, ` +
        `which would leak into historical as-of gates. Backtest-lite supports price/volume strategies only.`,
    )
  }
}

/** One (as-of date × stock) hit with its forward returns per horizon (string keys, JSON-safe). */
export interface BacktestHit {
  code: string
  fullCode: string
  name: string
  board: Board
  strategy: string
  /** Requested calendar as-of date. */
  asOf: string
  /** Last bar actually used (≤ asOf; the stock's own trading calendar). */
  asOfBarDate: string
  /** Close of the as-of bar, in the source's native (possibly adjusted) units. */
  close: number
  /** horizon (bars) → forward return; null when the horizon extends past cached data. */
  forward: Record<string, number | null>
  evidence: Record<string, number | string | boolean>
}

/** Per-horizon statistics for one as-of date (or pooled across dates). */
export interface BacktestHorizonStat {
  horizon: number
  /** Hits with a measurable forward return at this horizon. */
  observations: number
  hitMedian: number | null
  hitP25: number | null
  hitP75: number | null
  /** Median forward return of the evaluable universe (market drift). */
  baselineMedian: number | null
  /** hitMedian − baselineMedian. */
  excessMedian: number | null
  /** Share of hits whose return beat their own date's baseline median. */
  beatShare: number | null
}

export interface BacktestAsOf {
  /** Requested calendar as-of date. */
  asOf: string
  /** Market-wide latest bar ≤ asOf across evaluable stocks. */
  asOfBarDate: string | null
  evaluable: number
  hits: BacktestHit[]
  horizons: BacktestHorizonStat[]
}

export interface BacktestResult {
  strategy: string
  strategyDescription: string
  params: Record<string, number | string | boolean>
  source: string
  scope: string
  generatedAt: string
  /** Latest bar date across all fetched stocks (the data horizon). */
  lastBarDate: string | null
  asOfDates: string[]
  horizons: number[]
  asOfResults: BacktestAsOf[]
  pooled: BacktestHorizonStat[]
  /** Stocks whose bars were acquired (listed or not at each as-of). */
  stocksEvaluated: number
  skipped: Record<string, number>
  notes: string[]
  disclaimer: string
}

export interface BacktestArgs {
  strategy: Strategy
  params: StrategyParams
  stocks: StockMeta[]
  /** Ascending as-of dates (e.g. from {@link monthlySteps}). */
  asOfDates: string[]
  /** Ascending, unique horizon bar counts (e.g. from {@link parseHorizons}). */
  horizons: number[]
  /** Bar acquisition; return null to count a kline-fetch-failure and move on. */
  acquireBars(stock: StockMeta): Promise<SeriesBar[] | null>
  log?: (message: string) => void
  /** Data-source id and scope label for the report header (cosmetic). */
  source?: string
  scope?: string
}

function horizonStat(
  horizon: number,
  hitReturns: number[],
  hitBeats: boolean[],
  baselineValues: number[],
): BacktestHorizonStat {
  const sorted = [...hitReturns].sort((a, b) => a - b)
  const hitMedian = quantile(sorted, 0.5)
  const baselineMedian = medianOf(baselineValues)
  return {
    horizon,
    observations: hitReturns.length,
    hitMedian,
    hitP25: quantile(sorted, 0.25),
    hitP75: quantile(sorted, 0.75),
    baselineMedian,
    excessMedian: hitMedian !== null && baselineMedian !== null ? hitMedian - baselineMedian : null,
    beatShare: hitBeats.length > 0 ? hitBeats.filter(Boolean).length / hitBeats.length : null,
  }
}

/**
 * Run the as-of evaluation loop. Serial by design: backtests assume a warm
 * cache (`pnpm sync` first) and stay trivially reproducible; the CLI mirrors
 * the scan commands' systemic-failure guard on top of the skipped counts.
 */
export async function runBacktest(args: BacktestArgs): Promise<BacktestResult> {
  const { strategy, params, stocks, asOfDates, horizons, acquireBars } = args
  const log = args.log ?? (() => undefined)
  assertBacktestable(strategy)
  if (asOfDates.length === 0) throw new Error('asOfDates must not be empty')
  if (horizons.length === 0) throw new Error('horizons must not be empty')
  for (let i = 1; i < asOfDates.length; i++) {
    if (asOfDates[i]! <= asOfDates[i - 1]!) throw new Error(`asOfDates must be strictly ascending: ${asOfDates.join(', ')}`)
  }

  // Eligibility floor: a (stock, date) pair joins baseline and hit-attempt
  // accounting only when the stock had at least this many bars by then —
  // mirrors the strategies' own minBars default so hits and baseline describe
  // the same population.
  const floor = Math.max(60, Number(params.minBars ?? 240))

  // hits[date]: that date's hit list; baseline[date][horizon]: forward returns
  // of every evaluable stock at that (date, horizon) — the drift baseline.
  const hits = new Map<string, BacktestHit[]>(asOfDates.map((d) => [d, []]))
  const baseline = new Map<string, Map<number, number[]>>(asOfDates.map((d) => [d, new Map(horizons.map((h) => [h, [] as number[]]))]))
  const evaluable = new Map<string, number>(asOfDates.map((d) => [d, 0]))
  const marketBarDate = new Map<string, string>(asOfDates.map((d) => [d, '']))
  const skipped: Record<string, number> = {}
  let stocksEvaluated = 0
  let lastBarDate: string | null = null
  let done = 0

  for (const stock of stocks) {
    const bars = await acquireBars(stock)
    if (bars === null) {
      skipped['kline-fetch-failed'] = (skipped['kline-fetch-failed'] ?? 0) + 1
      continue
    }
    stocksEvaluated++
    done++
    if (done % 200 === 0) log(`backtest progress: ${done}/${stocks.length}`)
    if (bars.length === 0) continue
    const tail = bars[bars.length - 1]!.date
    if (lastBarDate === null || tail > lastBarDate) lastBarDate = tail
    const idx = chainedIndex(bars)

    for (const asOf of asOfDates) {
      const i = asOfIndex(bars, asOf)
      if (i < 0 || i + 1 < floor) continue
      evaluable.set(asOf, evaluable.get(asOf)! + 1)
      const barDate = bars[i]!.date
      if (barDate > marketBarDate.get(asOf)!) marketBarDate.set(asOf, barDate)

      const hit = strategy.screen({ stock, bars: bars.slice(0, i + 1) }, params)
      let bhit: BacktestHit | undefined
      if (hit) {
        bhit = {
          code: hit.code,
          fullCode: hit.fullCode,
          name: hit.name,
          board: hit.board,
          strategy: hit.strategy,
          asOf,
          asOfBarDate: barDate,
          close: bars[i]!.close,
          forward: {},
          evidence: hit.evidence,
        }
      }
      for (const horizon of horizons) {
        const fr = forwardReturn(idx, i, horizon)
        if (fr !== null) baseline.get(asOf)!.get(horizon)!.push(fr)
        if (bhit) bhit.forward[String(horizon)] = fr
      }
      if (bhit) hits.get(asOf)!.push(bhit)
    }
  }

  const statFor = (asOf: string, horizon: number, dateHits: BacktestHit[]): BacktestHorizonStat => {
    const baseMedian = medianOf(baseline.get(asOf)!.get(horizon)!)
    const hitReturns: number[] = []
    const hitBeats: boolean[] = []
    for (const hit of dateHits) {
      const fr = hit.forward[String(horizon)]
      if (fr === null || fr === undefined) continue
      hitReturns.push(fr)
      if (baseMedian !== null) hitBeats.push(fr > baseMedian)
    }
    return horizonStat(horizon, hitReturns, hitBeats, baseline.get(asOf)!.get(horizon)!)
  }

  const asOfResults: BacktestAsOf[] = asOfDates.map((asOf) => {
    const dateHits = hits.get(asOf)!
    return {
      asOf,
      asOfBarDate: marketBarDate.get(asOf) || null,
      evaluable: evaluable.get(asOf)!,
      hits: dateHits,
      horizons: horizons.map((horizon) => statFor(asOf, horizon, dateHits)),
    }
  })

  // Pool (date, hit) observations per horizon. Baseline for the pooled view is
  // the median of per-date baseline medians (each date contributes equally,
  // regardless of how many stocks were evaluable that day).
  const pooled = horizons.map((horizon) => {
    const hitReturns: number[] = []
    const hitBeats: boolean[] = []
    const baselineMedians: number[] = []
    for (const result of asOfResults) {
      const baseMedian = medianOf(baseline.get(result.asOf)!.get(horizon)!)
      if (baseMedian !== null) baselineMedians.push(baseMedian)
      for (const hit of result.hits) {
        const fr = hit.forward[String(horizon)]
        if (fr === null || fr === undefined) continue
        hitReturns.push(fr)
        if (baseMedian !== null) hitBeats.push(fr > baseMedian)
      }
    }
    return horizonStat(horizon, hitReturns, hitBeats, baselineMedians)
  })

  const totalHits = asOfResults.reduce((sum, r) => sum + r.hits.length, 0)
  const notes = [
    `${totalHits} (date × stock) hit observations over ${asOfDates.length} as-of dates — the same stock hitting at adjacent dates yields correlated observations, not independent samples`,
    `baseline = median forward return of evaluable stocks (≥ ${floor} bars) at each date; excess = hit median − baseline median`,
  ]

  return {
    strategy: strategy.id,
    strategyDescription: strategy.description,
    params: params as Record<string, number | string | boolean>,
    source: args.source ?? '',
    scope: args.scope ?? '',
    generatedAt: new Date().toISOString(),
    lastBarDate,
    asOfDates,
    horizons,
    asOfResults,
    pooled,
    stocksEvaluated,
    skipped,
    notes,
    disclaimer: BACKTEST_DISCLAIMER,
  }
}

function spct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
}

function num(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(digits)
}

/** Human-readable markdown report (mirrors report.ts conventions). */
export function renderBacktestMarkdown(result: BacktestResult, maxDetailRows = 200): string {
  const lines: string[] = []
  lines.push(`# 回测报告 (lite) — ${result.strategy}`)
  lines.push('')
  lines.push(`- 生成: ${result.generatedAt} · 数据源: ${result.source} · 范围: ${result.scope}`)
  lines.push(
    `- 数据截至: ${result.lastBarDate ?? '未知'} · 股票 ${result.stocksEvaluated} 只 · 时点 ${result.asOfDates.length} 个 (每月一步) · 前瞻窗口 ${result.horizons.join('/')} 交易日`,
  )
  const paramText = Object.entries(result.params)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
  lines.push(`- 参数: ${paramText}`)
  lines.push('')

  lines.push('## 〇、方法与偏差声明 (先读这个)')
  lines.push('')
  lines.push('- 每个历史时点只用该时点之前的K线评估策略, 前瞻收益在链式收益率指数上度量; 需要行业聚合或市值快照的策略已被拒绝回测 (避免未来数据泄入门内)。')
  lines.push('- ⚠️ 幸存者偏差: 股票池为当前上市名单, 已退市股票缺失 → 结果系统性偏乐观。')
  lines.push('- ⚠️ ST / 上市天数等元数据为当前快照, 非历史值。')
  lines.push('- 同一股票相邻时点重复命中会产生相关观测, 汇总样本非独立。')
  lines.push('- 定位: 用于**相对比较** (阈值A vs 阈值B、策略 vs 策略), 不构成收益预测或投资建议。')
  lines.push('')

  lines.push('## 一、按时间点 × 前瞻窗口')
  lines.push('')
  lines.push('| 时点 | 实际数据日 | 可评估 | 命中 | 窗口 | 命中中位 | 基准中位 | 超额中位 | 跑赢基准 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of result.asOfResults) {
    for (let h = 0; h < r.horizons.length; h++) {
      const stat = r.horizons[h]!
      const lead = h === 0 ? `| ${r.asOf} | ${r.asOfBarDate ?? '-'} | ${r.evaluable} | ${r.hits.length}` : '|  |  |  |  '
      lines.push(
        `${lead} | ${stat.horizon}日 | ${spct(stat.hitMedian)} | ${spct(stat.baselineMedian)} | ${spct(stat.excessMedian)} | ${stat.beatShare === null ? '-' : `${(stat.beatShare * 100).toFixed(0)}%`} |`,
      )
    }
  }
  lines.push('')

  lines.push('## 二、汇总 (全部时点合并)')
  lines.push('')
  lines.push('| 窗口 | 观测数 | 命中中位 | P25–P75 | 基准中位(各日中位的中位) | 超额中位 | 跑赢基准 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const stat of result.pooled) {
    lines.push(
      `| ${stat.horizon}日 | ${stat.observations} | ${spct(stat.hitMedian)} | ${spct(stat.hitP25)} ~ ${spct(stat.hitP75)} | ${spct(stat.baselineMedian)} | ${spct(stat.excessMedian)} | ${stat.beatShare === null ? '-' : `${(stat.beatShare * 100).toFixed(0)}%`} |`,
    )
  }
  lines.push('')

  const allHits = result.asOfResults.flatMap((r) => r.hits)
  const truncated = allHits.length > maxDetailRows
  lines.push(`## 三、命中明细 (${allHits.length} 行${truncated ? `, 仅列前 ${maxDetailRows} 行` : ''})`)
  lines.push('')
  if (allHits.length === 0) {
    lines.push('无。')
  } else {
    lines.push(`| 时点 | 代码 | 名称 | 板块 | 时点收盘 | ${result.horizons.map((h) => `${h}日`).join(' | ')} |`)
    lines.push(`|---|---|---|---|---|${result.horizons.map(() => '---').join('|')}|`)
    for (const hit of allHits.slice(0, maxDetailRows)) {
      const forwards = result.horizons.map((h) => spct(hit.forward[String(h)] ?? null)).join(' | ')
      lines.push(`| ${hit.asOf} | ${hit.code} | ${hit.name} | ${hit.board} | ${num(hit.close, 2)} | ${forwards} |`)
    }
  }
  lines.push('')

  if (Object.keys(result.skipped).length > 0) {
    lines.push(`剔除: ${Object.entries(result.skipped).map(([k, v]) => `${k} ${v}`).join(', ')}`)
    lines.push('')
  }
  for (const note of result.notes) lines.push(`- ${note}`)
  lines.push('')
  lines.push('---')
  lines.push('⚠️ 回测 lite 仅供研究参考, 不构成投资建议。')
  return lines.join('\n')
}
