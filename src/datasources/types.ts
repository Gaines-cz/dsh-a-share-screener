/**
 * Data-source abstraction: every quote vendor plugs in behind this interface,
 * so the screener, tools, and plugin entry never import a concrete source.
 * Adding a source means implementing {@link DataSource} and registering it in
 * {@link createDataSource} — no other code changes.
 * @module a-share-screener/datasources/types
 */
import type { Bar, StockMeta } from '../types.js'

/** Optional capabilities a source may or may not provide. */
export interface DataSourceCapabilities {
  /**
   * Whether {@link DataSource.listStocks} populates `StockMeta.industry`.
   * When false, industry/sector filtering is unavailable and callers surface a
   * clear capability gap instead of failing silently.
   */
  readonly industry: boolean
}

/** A stock-list / kline vendor, e.g. Eastmoney. */
export interface DataSource {
  /** Stable identifier surfaced in results and logs. */
  readonly id: string
  readonly capabilities: DataSourceCapabilities

  /** All currently listed A-share stocks (universe candidates), paged internally. */
  listStocks(signal: AbortSignal): Promise<StockMeta[]>

  /** Daily bars for one stock from `startDate` (YYYYMMDD) onward, ascending. */
  dailyBars(fullCode: string, startDate: string, signal: AbortSignal): Promise<Bar[]>

  /**
   * Optional incremental refresh: given the bars already cached for a stock,
   * return the merged, up-to-date series, or `null` when no change is needed.
   * Sources omit this when their data needs a full re-fetch on every refresh;
   * the screener then falls back to {@link DataSource.dailyBars}.
   */
  refreshBars?(fullCode: string, startDate: string, cached: Bar[], signal: AbortSignal): Promise<Bar[] | null>
}