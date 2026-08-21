/**
 * Data-source registry: the single place a new vendor plugs in. Add its
 * factory to {@link FACTORIES} (and extend {@link DataSourceId} to make it
 * selectable); everything downstream consumes {@link DataSource} and never
 * imports a concrete adapter.
 * @module a-share-screener/datasources
 */
import { RateLimiter } from '../http.js'
import { createEastmoneyDataSource } from './eastmoney.js'
import type { DataSource } from './types.js'

const FACTORIES = {
  eastmoney: createEastmoneyDataSource,
} as const

/** Selectable data-source ids (currently a single source). */
export type DataSourceId = keyof typeof FACTORIES

/** Build the data source for `id`, bound to the process-lifetime rate budget. */
export function createDataSource(id: DataSourceId, limiter: RateLimiter): DataSource {
  return FACTORIES[id](limiter)
}

export type { DataSource, DataSourceCapabilities } from './types.js'