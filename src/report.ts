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
  bars_since_low: '距低点时长',
  flat_base: '平台走平+均线收敛',
  platform_breakout: '平台放量突破',
  ma_stabilization: '均线企稳',
  volatility_regime: '波动率区间',
  volume_limit_up: '放量涨停',
  cooldown_pullback: '涨停后回落缩量',
  volume_dry_up: '地量',
  industry_clearance: '行业出清',
  industry_position: '行业位置',
  market_cap_band: '市值区间',
  amount_liquidity: '成交额下限',
  turnover_band: '换手率区间',
}

export function gateLabel(gate: string): string {
  return GATE_LABELS[gate] ?? gate
}

function fmt(v: number | string | boolean | null | undefined, digits = 2): string {
  if (typeof v === 'number') return v.toFixed(digits)
  return String(v ?? '-')
}

function pct(v: number | string | boolean | null | undefined): string {
  return v === null || v === undefined ? '-' : `${(Number(v) * 100).toFixed(1)}%`
}

function drawdownPct(v: number | string | boolean | null | undefined): string {
  return v === null || v === undefined ? '-' : `-${(Number(v) * 100).toFixed(1)}%`
}

type DiagnosisMetrics = StrategyDiagnosis['metrics']

interface GateCell {
  /** Short label used inside the compact gate line. */
  label: string
  /** Renders the metric behind the gate ('-' when the filter reported null). */
  value: (m: DiagnosisMetrics) => string
}

/**
 * Compact gate cells (short label + value formatter) in canonical render
 * order. `gateLine` renders only the gates a strategy's diagnosis actually
 * contains, so composed strategies with fewer filters show no phantom ✗.
 */
const GATE_CELLS: Record<string, GateCell> = {
  deep_drawdown: { label: '距高点', value: (m) => drawdownPct(m.drawdownFromHigh) },
  low_percentile: { label: '分位', value: (m) => pct(m.percentileInWindow) },
  bars_since_low: {
    label: '距低点',
    value: (m) => (m.barsSinceLow == null ? '-' : `${fmt(m.barsSinceLow, 0)}日/${pct(m.pctAboveLow)}`),
  },
  flat_base: { label: '平台净变动', value: (m) => pct(m.flatNetChange) },
  platform_breakout: {
    label: '突破',
    value: (m) =>
      m.breakoutDate === null || m.breakoutDate === undefined
        ? '-'
        : `${m.breakoutDate}(${fmt(m.breakoutSurge, 1)}x/${fmt(m.barsSinceBreakout, 0)}日)`,
  },
  ma_stabilization: {
    label: 'MA斜率',
    value: (m) => (m.maSlope == null ? '-' : `${pct(m.maSlope)}·离MA${pct(m.closeVsMaPct)}`),
  },
  volatility_regime: { label: '年化波动', value: (m) => pct(m.annualVol) },
  volume_limit_up: {
    label: '放量涨停',
    value: (m) =>
      m.limitUpDate === null || m.limitUpDate === undefined ? '-' : `${m.limitUpDate}(${fmt(m.limitUpVolumeSurge, 1)}x)`,
  },
  volume_dry_up: { label: '地量', value: (m) => (m.dryUpVolumeRatio == null ? '-' : `${pct(m.dryUpVolumeRatio)}`) },
  industry_position: {
    label: '行业位置',
    value: (m) =>
      m.industryMedPos == null
        ? '-'
        : `${String(m.industry ?? '?')}·中位分位${pct(m.industryMedPos)}/${fmt(m.industryMembers, 0)}家`,
  },
  industry_clearance: {
    label: '行业出清',
    value: (m) =>
      m.industryMedDrawdown == null
        ? '-'
        : `${String(m.industry ?? '?')}·中位回撤${pct(m.industryMedDrawdown)}/深跌${pct(m.industryDeepShare)}/${fmt(m.industryMembers, 0)}家`,
  },
  market_cap_band: { label: '市值', value: (m) => (m.marketCapYi == null ? '-' : `${fmt(m.marketCapYi, 0)}亿`) },
  amount_liquidity: { label: '日成交额中位', value: (m) => (m.medianAmountYi == null ? '-' : `${fmt(m.medianAmountYi, 2)}亿`) },
  turnover_band: { label: '中位换手', value: (m) => (m.medianTurnoverPct == null ? '-' : `${fmt(m.medianTurnoverPct, 2)}%`) },
  cooldown_pullback: {
    label: '回落缩量',
    value: (m) => {
      // The cooldown metrics cite their own reference day (cooldownRefDate),
      // which may be an older limit-up day than limitUpDate — flag divergence.
      const ref = m.cooldownRefDate === null || m.cooldownRefDate === undefined ? null : String(m.cooldownRefDate)
      const suffix = ref !== null && ref !== String(m.limitUpDate ?? '') ? `@${ref}` : ''
      return `${pct(m.cooldownVolumeRatio)}${suffix}`
    },
  },
}

/** Compact per-stock gate summary, e.g. "距高点-52.3%✓ 分位29.9%✗ …". */
function gateLine(entry: TieredEntry): string {
  const m = entry.diagnosis.metrics
  const gates = entry.diagnosis.gates
  const parts: string[] = []
  const push = (gate: string): void => {
    const cell = GATE_CELLS[gate]
    const label = cell?.label ?? gateLabel(gate)
    const value = cell === undefined ? '' : cell.value(m)
    parts.push(`${label}${value}${gates[gate] === true ? '✓' : '✗'}`)
  }
  const present = Object.keys(gates)
  for (const gate of Object.keys(GATE_CELLS)) if (present.includes(gate)) push(gate)
  for (const gate of present) if (!(gate in GATE_CELLS)) push(gate)
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
