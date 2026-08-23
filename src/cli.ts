/**
 * Standalone CLI — run screening without the dsh harness.
 *
 *   pnpm sync         增量同步本地行情缓存 (每周一次; 全市场默认)
 *   pnpm scan         按策略扫描, 生成分层报告 (严格命中 + 近邻候选)
 *   pnpm strategies   列出可用策略与参数
 *   pnpm filters      列出可用原子过滤器与参数
 *   pnpm sources      列出可用数据源
 *
 * 手动触发、本地缓存、免费数据源 (新浪主 / 东财回退 / 腾讯备胎), 无需 token。
 * @module a-share-screener/cli
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { defaultCacheDir } from './cache.js'
import { boardMemberCodes, findBoard, suggestBoards } from './datasources/boards.js'
import { createDataSource, type DataSourceId } from './datasources/index.js'
import { createFilterRegistry } from './filters/index.js'
import { RateLimiter } from './http.js'
import { renderJson, renderMarkdown, tierResults, type ReportContext, type TieredEntry } from './report.js'
import {
  acquireBarsFile,
  filterByCodes,
  aggregateIndustries,
  assertCapabilities,
  historyStartDate,
  prepareUniverse,
  syncBars,
  type ScreenerConfig,
  type ScreenerHost,
} from './screener.js'
import { StrategyRegistry } from './strategies/registry.js'
import { registerAll } from './strategies/index.js'
import { toPredicate } from './tool.js'
import { composeStrategy } from './engine/compose.js'
import type { IndustryStats } from './engine/types.js'
import { barsToSeries, fromBarTuple, ymd } from './types.js'

const SOURCE_NOTES: Record<DataSourceId, string> = {
  sina: '新浪 前复权日线 (推荐: 免费、单请求1023根、最新价≈市价)',
  eastmoney: '东方财富 前复权日线 (免费回退源)',
  tencent: '腾讯 后复权日线 (备胎; 报告价会虚高)',
}

const DEFAULT_REQUESTS_PER_MINUTE = 200
const DEFAULT_HISTORY_BARS = 800

function host() {
  return {
    log(level: 'info' | 'warn', message: string): void {
      const line = `[a-share-screener] ${message}`
      if (level === 'warn') console.warn(line)
      else console.log(line)
    },
  }
}

/** Parse a non-negative numeric CLI option; fail loudly on garbage input. */
function numOption(values: Record<string, unknown>, key: string, fallback: number): number {
  const raw = values[key]
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`参数错误: --${key} 应为非负数字, 遇到: ${String(raw)}`)
    process.exit(2)
  }
  return n
}

function configFrom(values: Record<string, unknown>): ScreenerConfig {
  return {
    cacheDir: (values['cache-dir'] as string | undefined) ?? null,
    requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
    historyBars: Number(values['history-bars'] ?? DEFAULT_HISTORY_BARS),
    excludeST: true,
    excludeBSE: true,
    minListDays: numOption(values, 'min-list-days', 365),
    maxListDays: numOption(values, 'max-list-days', 0),
    scanTimeoutMs: 7_200_000,
  }
}

function parseCodes(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return raw
    .split(',')
    .map((code) => code.trim())
    .filter((code) => /^\d{6}$/.test(code))
}

/** Resolve the scan scope to a code list + a human label. */
async function resolveScope(
  values: Record<string, unknown>,
  limiter: RateLimiter,
  signal: AbortSignal,
): Promise<{ codes: string[] | undefined; label: string; slug: string }> {
  const codes = parseCodes(values.codes as string | undefined)
  if (codes !== undefined && codes.length > 0) return { codes, label: `自选 ${codes.length} 只`, slug: `codes-${codes.length}` }
  const board = (values.board as string | undefined)?.trim()
  if (board !== undefined && board !== '') {
    const hits = await findBoard(board, limiter, signal)
    if (hits === null) {
      const suggestions = await suggestBoards(board, limiter, signal)
      const hint = suggestions.length > 0 ? ` 相近板块: ${suggestions.slice(0, 8).join('、')}` : ''
      throw new Error(`找不到板块「${board}」, 检查名称(如 核能核电 / 农林牧渔)。${hint}`)
    }
    const members = new Set<string>()
    for (const hit of hits) {
      for (const code of await boardMemberCodes(hit.id, limiter, signal)) members.add(code)
    }
    const label = `${board} (${hits.map((h) => `${h.kind}:${h.name}`).join(' + ')}, ${members.size}只)`
    return { codes: [...members], label, slug: board }
  }
  return { codes: undefined, label: '全市场', slug: 'full-market' }
}

function parseParams(raw: string | undefined): Record<string, number> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const out: Record<string, number> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq === -1) throw new Error(`参数格式应为 k=v,k2=v2, 遇到: ${pair}`)
    const key = pair.slice(0, eq).trim()
    const value = Number(pair.slice(eq + 1).trim())
    if (key === '' || !Number.isFinite(value)) throw new Error(`参数格式错误: ${pair}`)
    out[key] = value
  }
  return out
}

function parseArgsSafe(args: string[], options: NonNullable<ParseArgsConfig['options']>): { values: Record<string, unknown>; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true })
    return { values: values as Record<string, unknown>, positionals }
  } catch (err) {
    console.error(`参数错误: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
}

function commonOptions(): NonNullable<ParseArgsConfig['options']> {
  return {
    'cache-dir': { type: 'string', short: 'c' },
    source: { type: 'string', default: 'sina' },
    refresh: { type: 'boolean' },
    concurrency: { type: 'string', default: '12' },
    'history-bars': { type: 'string' },
    'min-list-days': { type: 'string' },
    'max-list-days': { type: 'string' },
    codes: { type: 'string' },
    board: { type: 'string', short: 'b' },
  }
}

function printHelp(): void {
  console.log(`A股选股扫描 CLI (免费数据源, 无需 token)

用法:
  pnpm sync [选项]                 增量同步本地行情缓存 (每周一次)
  pnpm scan [选项]                 按策略扫描并生成分层报告
  pnpm strategies                  列出可用策略与参数
  pnpm filters                     列出可用原子过滤器与参数
  pnpm sources                     列出可用数据源
  pnpm cli help                    显示本帮助

选项:
  --source <sina|eastmoney|tencent>  数据源 (默认 sina)
  --codes 600519,000858              只扫指定代码
  --board <板块名>                   只扫东财板块成分 (如 核能核电 / 农林牧渔)
  --strategy <id>                    扫描策略 (默认 low_flat_limit_up)
  --params k=v,k2=v2                 覆盖策略参数
  --top <n>                          近邻候选最多列 n 只 (默认 30)
  --out <dir>                        报告输出目录 (默认 reports/)
  --cache-dir <dir>                  缓存目录 (默认 ~/.dsh/a-share-screener)
  --refresh                          强制刷新股票清单与K线
  --concurrency <n>                  并发请求数 (默认 12)
  --history-bars <n>                 K线回看窗口 (默认 800)
  --min-list-days <n>                剔除上市不足 n 天 (默认 365)
  --max-list-days <n>                剔除上市超过 n 天 (默认 0 = 不限; 如 1460 ≈ 4年)`)
}

async function cmdSync(values: Record<string, unknown>): Promise<void> {
  const config = configFrom(values)
  const source = values.source as DataSourceId
  if (!(source in SOURCE_NOTES)) {
    console.error(`未知数据源 '${source}'. 可用: ${Object.keys(SOURCE_NOTES).join(', ')}`)
    process.exit(2)
  }
  const limiter = new RateLimiter(config.requestsPerMinute)
  const dataSource = createDataSource(source, limiter)
  const signal = new AbortController().signal
  const { codes, label } = await resolveScope(values, limiter, signal)
  const result = await syncBars(host(), config, dataSource, {
    refresh: values.refresh === true,
    codes,
    concurrency: Number(values.concurrency ?? 12),
    signal,
  })
  console.log(`同步完成: ${label} · 数据源 ${dataSource.id} · 处理 ${result.scanned} 只 / 本次拉取 ${result.stocksFetched} 只`)
  const skipped = Object.entries(result.skipped)
  if (skipped.length > 0) console.log(`剔除: ${skipped.map(([k, v]) => `${k} ${v}`).join(', ')}`)
}

async function cmdScan(values: Record<string, unknown>): Promise<void> {
  const config = configFrom(values)
  let registry = new StrategyRegistry()
  registerAll(registry)
  const predicateRaw = values.predicate as string | undefined
  const strategyId = predicateRaw !== undefined ? 'custom' : ((values.strategy as string) ?? 'low_flat_limit_up')
  if (predicateRaw !== undefined) {
    // Ad-hoc composition over atomic filters (JSON DSL), same as the tool layer.
    let predicateJson: unknown
    try {
      predicateJson = JSON.parse(predicateRaw)
    } catch (err) {
      console.error(`--predicate 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(2)
    }
    const predicate = toPredicate(predicateJson, createFilterRegistry())
    const custom = composeStrategy({
      id: 'custom',
      description: `Ad-hoc composition: ${predicateRaw}`,
      predicate,
      filters: createFilterRegistry(),
      extraParamDocs: {
        minBars: { type: 'number', default: 240, min: 60, max: 3000, integer: true, description: 'Minimum bar count to evaluate a stock at all.' },
      },
      canEvaluate: (input, params) => input.bars.length >= Math.max(60, params.minBars as number),
    })
    registry = new StrategyRegistry()
    registry.register(custom)
  }
  const strategy = registry.get(strategyId)
  if (strategy === undefined) {
    console.error(`未知策略 '${strategyId}'. 可用: ${registry.ids().join(', ')}`)
    process.exit(2)
  }
  const params = registry.resolveParams(strategyId, parseParams(values.params as string | undefined))

  const limiter = new RateLimiter(config.requestsPerMinute)
  const source = values.source as DataSourceId
  if (!(source in SOURCE_NOTES)) {
    console.error(`未知数据源 '${source}'. 可用: ${Object.keys(SOURCE_NOTES).join(', ')}`)
    process.exit(2)
  }
  const dataSource = createDataSource(source, limiter)
  assertCapabilities(strategy, dataSource)
  const { codes, label, slug } = await resolveScope(values, limiter, new AbortController().signal)
  const signal = new AbortController().signal

  const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, signal, values.refresh === true, (m) => console.warn(m))
  const universe = filterByCodes(filtered, codes, skipped)
  console.log(`范围 ${label} · 评估前剔除: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(', ') || '无'}`)

  const startDate = historyStartDate(config.historyBars)
  const fetched = new Set<string>()
  const entries: TieredEntry[] = []
  // Industry strategies need market-level stats before any candidate is judged.
  let industryByStock: Map<string, IndustryStats> | undefined
  if (strategy.requires?.industry) {
    const cliHost: ScreenerHost = { log: (_level, message) => console.log(message) }
    const stats = await aggregateIndustries(cliHost, config, dataSource, filtered, startDate, today, signal, fetched)
    industryByStock = new Map()
    for (const stock of filtered) {
      const stat = stock.industry === undefined ? undefined : stats.get(stock.industry)
      if (stat !== undefined) industryByStock.set(stock.code, stat)
    }
    console.log(`行业聚合完成: ${stats.size} 个板块`)
  }
  let unevaluated = 0
  let lastBarDate: string | null = null
  const concurrency = Math.max(1, Math.floor(Number(values.concurrency ?? 12)))
  const queue = [...universe]
  const work = async (): Promise<void> => {
    for (;;) {
      const stock = queue.shift()
      if (stock === undefined) return
      try {
        const fileData = await acquireBarsFile(config, dataSource, stock, startDate, today, signal, fetched)
        const tail = fileData.bars[fileData.bars.length - 1]?.[0]
        if (tail !== undefined && (lastBarDate === null || tail > lastBarDate)) lastBarDate = tail
        const series = barsToSeries(fileData.bars.map(fromBarTuple))
        if (strategy.diagnose === undefined) {
          const hit = strategy.screen({ stock, bars: series, industryStats: industryByStock?.get(stock.code) }, params)
          if (hit) {
            entries.push({ stock, diagnosis: { matched: true, gates: {}, failedGates: [], metrics: hit.evidence } })
          }
          continue
        }
        const diag = strategy.diagnose({ stock, bars: series, industryStats: industryByStock?.get(stock.code) }, params)
        if (diag === null) {
          unevaluated++
          continue
        }
        entries.push({ stock, diagnosis: diag })
      } catch (err) {
        skipped['kline-fetch-failed'] = (skipped['kline-fetch-failed'] ?? 0) + 1
        console.warn(`K线获取失败 ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => work()))
  const failures = skipped['kline-fetch-failed'] ?? 0
  if (failures > Math.max(10, Math.floor(universe.length * 0.1))) {
    throw new Error(`K线获取失败 ${failures}/${universe.length} — 疑似数据源故障, 可换 --source 重试`)
  }

  const tiered = tierResults(entries)
  const top = Math.max(1, Math.floor(Number(values.top ?? 30)))
  if (tiered.nearMisses.length > top) tiered.nearMisses.length = top

  const ctx: ReportContext = {
    strategy: strategyId,
    strategyDescription: strategy.description,
    params: params as Record<string, number | string | boolean>,
    source: dataSource.id,
    scope: label,
    generatedAt: new Date().toISOString(),
    lastBarDate,
    evaluated: entries.length,
    skipped,
    tiered,
  }
  const outDir = (values.out as string | undefined) ?? 'reports'
  await mkdir(outDir, { recursive: true })
  const base = `${ymd(new Date())}-${strategyId}-${slug}`
  await writeFile(join(outDir, `${base}.md`), renderMarkdown(ctx), 'utf8')
  await writeFile(join(outDir, `${base}.json`), JSON.stringify(renderJson(ctx), null, 2), 'utf8')

  console.log(
    `扫描完成: ${label} · 数据源 ${dataSource.id} · 评估 ${entries.length} (未评估 ${unevaluated}) / ` +
      `严格命中 ${tiered.hits.length} / 近邻候选 ${tiered.nearMisses.length} / 其他 ${tiered.others}`,
  )
  console.log(`报告: ${join(outDir, `${base}.md`)} (+ .json)`)
}

async function cmdStrategies(): Promise<void> {
  const registry = new StrategyRegistry()
  registerAll(registry)
  for (const strategy of registry.list()) {
    console.log(`\n# ${strategy.id}`)
    console.log(strategy.description)
    console.log(JSON.stringify(strategy.paramDocs, null, 2))
  }
}

async function cmdFilters(): Promise<void> {
  const filters = createFilterRegistry()
  for (const filter of filters.list()) {
    console.log(`\n# ${filter.id}`)
    console.log(filter.description)
    console.log(JSON.stringify(filter.paramDocs, null, 2))
  }
}

async function cmdSources(): Promise<void> {
  for (const [id, note] of Object.entries(SOURCE_NOTES)) {
    console.log(`- ${id}: ${note}`)
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'sync': {
      const { values } = parseArgsSafe(args, commonOptions())
      await cmdSync(values)
      break
    }
    case 'scan': {
      const { values } = parseArgsSafe(args, { ...commonOptions(), strategy: { type: 'string' }, predicate: { type: 'string' }, params: { type: 'string' }, top: { type: 'string' }, out: { type: 'string' } })
      await cmdScan(values)
      break
    }
    case 'strategies':
      await cmdStrategies()
      break
    case 'filters':
      await cmdFilters()
      break
    case 'sources':
      await cmdSources()
      break
    case 'help':
    case undefined:
      printHelp()
      break
    default:
      console.error(`未知命令 '${command}'. 可用: sync, scan, strategies, filters, sources, help`)
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(`错误: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
