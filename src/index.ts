/**
 * Plugin entry: registers the screening tools with the harness tool registry.
 *
 * Configuration carries only a reference to the tushare token (an env-var
 * name), never the secret itself; the value resolves per scan through the dsh
 * credentials service (process env → managed credentials → .env layers) with a
 * plain process-env fallback, so rotating the token needs no restart.
 * @module a-share-screener
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { RateLimiter } from './http.js'
import type { ScreenerConfig, ScreenerHost } from './screener.js'
import { lowFlatLimitUpStrategy } from './strategies/low-flat-limitup.js'
import { StrategyRegistry } from './strategies/registry.js'
import { createListStrategiesTool, createScreenTool } from './tool.js'

export const name = 'a-share-screener'

export const inject = ['tools']

export interface Config {
  /** Env-var name whose value holds the Tushare Pro token. */
  tokenEnv: string
  /** Data source selection; 'auto' prefers tushare when a token resolves. */
  dataSource: 'auto' | 'tushare' | 'eastmoney'
  /** Cache directory; defaults to $DSH_HOME/a-share-screener (~/.dsh fallback). */
  cacheDir?: string | null
  /** Outbound request budget shared by all data-source calls. */
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
  tokenEnv: Schema.string().default('TUSHARE_TOKEN'),
  dataSource: Schema.union(['auto', 'tushare', 'eastmoney']).default('auto'),
  cacheDir: Schema.string(),
  requestsPerMinute: Schema.number().min(30).max(1000).default(200),
  historyBars: Schema.number().min(250).max(3000).default(800),
  excludeST: Schema.boolean().default(true),
  excludeBSE: Schema.boolean().default(true),
  minListDays: Schema.number().min(0).max(5000).default(365),
  scanTimeoutMs: Schema.number().min(60_000).max(7_200_000).default(1_800_000),
})

interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}

/** Build the host adapter: token resolution + logging through the harness. */
function createHost(ctx: Context): ScreenerHost {
  return {
    async resolveToken(envName) {
      const credentials = (ctx as unknown as { credentials?: CredentialsLike }).credentials
      if (credentials) {
        try {
          const hit = await credentials.resolve(envName)
          if (hit?.value) return hit.value
        } catch {
          // Fall through to the plain environment lookup.
        }
      }
      return process.env[envName] || undefined
    },
    log(level, message) {
      const logger = (ctx as unknown as { logger?: (title: string) => { info(m: string): void; warn(m: string): void } })
        .logger
      if (typeof logger === 'function') {
        logger('a-share-screener')[level](message)
      } else {
        console[level === 'warn' ? 'warn' : 'log'](`[a-share-screener] ${message}`)
      }
    },
  }
}

export function apply(ctx: Context, config: Config): void {
  const registry = new StrategyRegistry()
  registry.register(lowFlatLimitUpStrategy)
  // One rate budget for the whole plugin lifetime: concurrent scans would
  // otherwise multiply outbound requests against the data source.
  const limiter = new RateLimiter(config.requestsPerMinute)
  const deps = {
    host: createHost(ctx),
    config: config as ScreenerConfig,
    registry,
    limiter,
  }
  ctx.tools.register(createListStrategiesTool(deps))
  ctx.tools.register(createScreenTool(deps))
}
