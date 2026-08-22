/**
 * Plugin entry: registers the screening tools with the harness tool registry.
 *
 * The screener is data-source agnostic; the source is chosen through the
 * `dataSource` config (default `sina` — the free primary source whose 前复权
 * closes match market prices; `eastmoney` klines are TLS-blocked on some
 * networks, `tencent` is a 后复权 fallback). Adding another vendor means
 * implementing {@link DataSource} and registering it there — no changes here.
 * @module a-share-screener
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createDataSource, type DataSourceId } from './datasources/index.js'
import { RateLimiter } from './http.js'
import type { ScreenerConfig, ScreenerHost } from './screener.js'
import { StrategyRegistry } from './strategies/registry.js'
import { registerAll } from './strategies/index.js'
import { createListStrategiesTool, createScreenTool } from './tool.js'

export const name = 'a-share-screener'

export const inject = ['tools']

export interface Config {
  /** Cache directory; defaults to $DSH_HOME/a-share-screener (~/.dsh fallback). */
  cacheDir?: string | null
  /** Data source for stock list + klines. Default `sina`. */
  dataSource: DataSourceId
  /** Outbound request budget shared by every data-source call. */
  requestsPerMinute: number
  /** Trading-day bars kept per stock (window for high/percentile lookback). */
  historyBars: number
  /** Exclude ST / delisting-warning stocks. */
  excludeST: boolean
  /** Exclude Beijing Stock Exchange stocks (30% limit rules). */
  excludeBSE: boolean
  /** Exclude stocks listed fewer than this many days. */
  minListDays: number
  /** Cooperative timeout budget for one full scan, milliseconds. */
  scanTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  cacheDir: Schema.string(),
  dataSource: Schema.union(['sina', 'eastmoney', 'tencent']).default('sina'),
  requestsPerMinute: Schema.number().min(30).max(1000).default(200),
  historyBars: Schema.number().min(250).max(3000).default(800),
  excludeST: Schema.boolean().default(true),
  excludeBSE: Schema.boolean().default(true),
  minListDays: Schema.number().min(0).max(5000).default(365),
  scanTimeoutMs: Schema.number().min(60_000).max(7_200_000).default(1_800_000),
})

/** Log through the harness logger, falling back to the console. */
function log(ctx: Context, level: 'info' | 'warn', message: string): void {
  const logger = (ctx as unknown as { logger?: (title: string) => { info(m: string): void; warn(m: string): void } })
    .logger
  if (typeof logger === 'function') {
    logger('a-share-screener')[level](message)
  } else {
    console[level === 'warn' ? 'warn' : 'log'](`[a-share-screener] ${message}`)
  }
}

export function apply(ctx: Context, config: Config): void {
  const registry = new StrategyRegistry()
  registerAll(registry)
  // One rate budget for the whole plugin lifetime: concurrent scans would
  // otherwise multiply outbound requests against the data source.
  const dataSource = createDataSource(config.dataSource, new RateLimiter(config.requestsPerMinute))
  const host: ScreenerHost = { log: (level, message) => log(ctx, level, message) }
  const deps = {
    host,
    config: config as ScreenerConfig,
    dataSource,
    registry,
  }
  ctx.tools.register(createListStrategiesTool(deps))
  ctx.tools.register(createScreenTool(deps))
}