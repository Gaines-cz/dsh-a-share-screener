/**
 * Data-source registry: the single place a new vendor plugs in. Add its
 * factory to {@link FACTORIES} (and extend {@link DataSourceId} to make it
 * selectable); everything downstream consumes {@link DataSource} and never
 * imports a concrete adapter.
 * @module a-share-screener/datasources
 */
import { RateLimiter } from '../http.js'
import { createEastmoneyDataSource } from './eastmoney.js'
import { createSinaDataSource } from './sina.js'
import { createTencentDataSource } from './tencent.js'
import type { DataSource } from './types.js'

const FACTORIES = {
  /** Sina Finance 前复权日线: 免费、单请求 1023 根、最新价≈市价 (推荐主源)。 */
  sina: createSinaDataSource,
  /** 东方财富: 免费、前复权、含全市场股票清单 (免费回退源)。 */
  eastmoney: createEastmoneyDataSource,
  /** 腾讯: 免费、后复权 (报告价会虚高), 仅作备胎。 */
  tencent: createTencentDataSource,
} as const

/** Selectable data-source ids. */
export type DataSourceId = keyof typeof FACTORIES

/** Build the data source for `id`, bound to the process-lifetime rate budget. */
export function createDataSource(id: DataSourceId, limiter: RateLimiter): DataSource {
  return FACTORIES[id](limiter)
}

export type { DataSource, DataSourceCapabilities } from './types.js'