/**
 * Tiered report generation for the CLI: splits evaluated stocks into 严格命中
 * (every gate passes) and 近邻候选 (exactly one gate fails), and renders a
 * human-readable markdown report plus a machine-readable JSON payload.
 * @module a-share-screener/report
 */
import type { StrategyDiagnosis } from './strategies/registry.js'
import type { StockMeta } from './types.js'

export interface TieredEntry {
  stock: StockMeta
  diagnosis: StrategyDiagnosis
}

export interface TieredResult {
  hits: TieredEntry[]
  nearMisses: TieredEntry[]
  others: number
}

/** Split evaluated entries into tiers; near-misses sorted by drawdown depth. */
export function tierResults(entries: TieredEntry[]): TieredResult {
  const hits: TieredEntry[] = []
  const nearMisses: TieredEntry[] = []
  let others = 0
  for (const entry of entries) {
    if (entry.diagnosis.matched) hits.push(entry)
    else if (entry.diagnosis.failedGates.length === 1) nearMisses.push(entry)
    else others++
  }
  hits.sort((a, b) => a.stock.code.localeCompare(b.stock.code))
  nearMisses.sort((a, b) => {
    const da = Number(a.diagnosis.metrics.drawdownFromHigh ?? 0)
    const db = Number(b.diagnosis.metrics.drawdownFromHigh ?? 0)
    return db - da
  })
  return { hits, nearMisses, others }
}

/** Human-readable names for the atomic-filter gates. */
const GATE_LABELS: Record<string, string> = {
  deep_drawdown: '距高点回撤',
  low_percentile: '历史分位',
  flat_base: '平台走平+均线收敛',
  volume_limit_up: '放量涨停',
  cooldown_pullback: '涨停后回落缩量',
}

export function gateLabel(gate: string): string {
  return GATE_LABELS[gate] ?? gate
}

function fmt(v: number | string | boolean | null | undefined, digits = 2): string {
  if (typeof v === 'number') return v.toFixed(digits)
  return String(v ?? '-')
}

/** Compact per-stock gate summary, e.g. "距高点-52.3%✓ 分位29.9%✗ …". */
function gateLine(entry: TieredEntry): string {
  const m = entry.diagnosis.metrics
  const gates = entry.diagnosis.gates
  const pct = (v: number | string | boolean | null | undefined): string => `${(Number(v ?? 0) * 100).toFixed(1)}%`
  const parts: string[] = []
  const push = (label: string, value: string, pass: boolean | undefined): void => {
    parts.push(`${label}${value}${pass === true ? '✓' : '✗'}`)
  }
  push('距高点', `-${pct(m.drawdownFromHigh)}`, gates.deep_drawdown)
  push('分位', pct(m.percentileInWindow), gates.low_percentile)
  push('平台净变动', pct(m.flatNetChange), gates.flat_base)
  push(
    '放量涨停',
    m.limitUpDate === null || m.limitUpDate === undefined ? '-' : `${m.limitUpDate}(${fmt(m.limitUpVolumeSurge, 1)}x)`,
    gates.volume_limit_up,
  )
  push('回落缩量', fmt(m.cooldownVolumeRatio, 2), gates.cooldown_pullback)
  return parts.join(' ')
}

export interface ReportContext {
  strategy: string
  strategyDescription: string
  params: Record<string, number | string | boolean>
  source: string
  scope: string
  generatedAt: string
  lastBarDate: string | null
  evaluated: number
  skipped: Record<string, number>
  tiered: TieredResult
}

/** Render the human-readable markdown report. */
export function renderMarkdown(ctx: ReportContext): string {
  const lines: string[] = []
  lines.push(`# 选股扫描报告 — ${ctx.strategy}`)
  lines.push('')
  lines.push(`- 生成: ${ctx.generatedAt} · 数据源: ${ctx.source} · 范围: ${ctx.scope}`)
  lines.push(`- 数据截至: ${ctx.lastBarDate ?? '未知'} · 评估 ${ctx.evaluated} 只`)
  lines.push(
    `- 严格命中 ${ctx.tiered.hits.length} / 近邻候选 ${ctx.tiered.nearMisses.length} / 其他(差≥2道闸) ${ctx.tiered.others}`,
  )
  const paramText = Object.entries(ctx.params)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
  lines.push(`- 参数: ${paramText}`)
  lines.push('')

  lines.push(`## 一、严格命中 (${ctx.tiered.hits.length}只)`)
  lines.push('')
  if (ctx.tiered.hits.length === 0) {
    lines.push('无。')
  } else {
    for (const entry of ctx.tiered.hits) {
      const m = entry.diagnosis.metrics
      lines.push(
        `- **${entry.stock.code} ${entry.stock.name}** (${entry.stock.board}) 收盘${fmt(m.close)} ` +
          gateLine(entry),
      )
    }
  }
  lines.push('')

  lines.push(`## 二、近邻候选 (${ctx.tiered.nearMisses.length}只, 只差一道闸, 供人工甄别)`)
  lines.push('')
  if (ctx.tiered.nearMisses.length === 0) {
    lines.push('无。')
  } else {
    for (const entry of ctx.tiered.nearMisses) {
      const m = entry.diagnosis.metrics
      const fail = entry.diagnosis.failedGates.map((g) => gateLabel(g)).join('、')
      lines.push(
        `- **${entry.stock.code} ${entry.stock.name}** (${entry.stock.board}) 收盘${fmt(m.close)} ` +
          gateLine(entry) + ` → 差在: ${fail}`,
      )
    }
  }
  lines.push('')

  const skipped = Object.entries(ctx.skipped)
  if (skipped.length > 0) {
    lines.push(`## 三、剔除 (${skipped.map(([k, v]) => `${k} ${v}`).join(', ')})`)
    lines.push('')
  }

  lines.push('---')
  lines.push('⚠️ 技术形态扫描结果, 仅供研究参考, 不构成投资建议。')
  return lines.join('\n')
}

/** Machine-readable payload (hits + near-misses + summary). */
export function renderJson(ctx: ReportContext): unknown {
  const entryView = (entry: TieredEntry) => ({
    code: entry.stock.code,
    fullCode: entry.stock.fullCode,
    name: entry.stock.name,
    board: entry.stock.board,
    gates: entry.diagnosis.gates,
    failedGates: entry.diagnosis.failedGates,
    metrics: entry.diagnosis.metrics,
  })
  return {
    strategy: ctx.strategy,
    source: ctx.source,
    scope: ctx.scope,
    generatedAt: ctx.generatedAt,
    lastBarDate: ctx.lastBarDate,
    evaluated: ctx.evaluated,
    skipped: ctx.skipped,
    params: ctx.params,
    summary: {
      hits: ctx.tiered.hits.length,
      nearMisses: ctx.tiered.nearMisses.length,
      others: ctx.tiered.others,
    },
    hits: ctx.tiered.hits.map(entryView),
    nearMisses: ctx.tiered.nearMisses.map(entryView),
  }
}
