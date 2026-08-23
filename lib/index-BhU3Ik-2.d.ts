import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/http.d.ts

/**
 * Rate-limited JSON fetching with signal-aware retries.
 * @module a-share-screener/http
 */
/**
 * Serial rate limiter: enforces a minimum interval between request starts.
 * Requests queue in call order; an aborted acquire rejects immediately.
 */
declare class RateLimiter {
  readonly requestsPerMinute: number;
  private nextAt;
  private queue;
  constructor(requestsPerMinute: number);
  /** Wait for this request's slot. Rejects when `signal` aborts while waiting. */
  acquire(signal: AbortSignal): Promise<void>;
  private wait;
}
/** Sleep that rejects with an AbortError when `signal` fires first. */
//#endregion
//#region src/types.d.ts
/**
 * Shared domain types for the A-share screener: board classification, stock
 * metadata, daily bars, and the strategy-facing bar series.
 * @module a-share-screener/types
 */
/** Exchange board, deciding the daily price-limit rule. */
type Board = 'main' | 'chinext' | 'star' | 'bse';
/**
 * Daily-return threshold for a close-at-limit-up day, by board. Exchange price
 * rounding keeps achieved limit-up percentages within roughly ±0.2 points of
 * the nominal 10/20/30%, so these thresholds catch every true limit-up close.
 */

/** One listed stock. `code` is the 6-digit symbol, `fullCode` the exchange-suffixed form data APIs use. */
interface StockMeta {
  code: string;
  fullCode: string;
  name: string;
  board: Board;
  /** Listing date, YYYYMMDD. */
  listDate: string;
  /**
   * Industry/sector classification. Only populated by sources whose
   * `capabilities.industry` is true (extension point for future vendors).
   */
  industry?: string;
  /**
   * Total market capitalization in CNY yuan (list-time snapshot). Only
   * populated by sources whose `capabilities.marketCap` is true.
   */
  totalMarketCapYuan?: number;
  /**
   * Free-float market capitalization in CNY yuan (list-time snapshot). Only
   * populated by sources whose `capabilities.marketCap` is true.
   */
  floatMarketCapYuan?: number;
}
/**
 * One daily bar. Prices are in the source's native units (raw or
 * back-adjusted CNY, depending on the vendor) — never mix bars from different
 * sources in one series. Volume is in lots (手). Price-level conditions must
 * use the chained return index, not raw closes, so ex-rights events stay correct.
 */
interface Bar {
  /** Trade date, YYYYMMDD. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * Traded value of the bar in CNY yuan. Only published by sources whose
   * `capabilities.amount` is true (e.g. Eastmoney klines); null/undefined
   * otherwise. Filters that need it declare `requires.amount` and refuse to
   * run on sources without the capability instead of approximating.
   */
  amount?: number | null;
  /**
   * Previous close as published by the source. When present and positive it is
   * the ex-rights-adjusted previous close, so `close / preClose - 1` is the
   * true daily return even across corporate actions. Null when the source does
   * not publish one (e.g. Eastmoney klines).
   */
  preClose: number | null;
}
/**
 * Cache tuple form of {@link Bar}: [date, open, high, low, close, volume,
 * preClose, amount?]. The 8th element is optional so caches written before
 * the amount field existed (7-column tuples) still parse — their amount is
 * simply undefined.
 */
//#endregion
//#region src/datasources/types.d.ts
/** Optional capabilities a source may or may not provide. */
interface DataSourceCapabilities {
  /**
   * Whether {@link DataSource.listStocks} populates `StockMeta.industry`.
   * When false, industry/sector filtering is unavailable and callers surface a
   * clear capability gap instead of failing silently.
   */
  readonly industry: boolean;
  /**
   * Whether `listStocks` populates `StockMeta.totalMarketCapYuan` /
   * `floatMarketCapYuan`. Absent/false means market-cap filters are
   * unavailable on this source.
   */
  readonly marketCap?: boolean;
  /**
   * Whether `dailyBars` populates `Bar.amount` (traded value per bar).
   * Absent/false means amount/liquidity filters are unavailable.
   */
  readonly amount?: boolean;
}
/** What a filter may declare it needs from the active data source. */

/** A stock-list / kline vendor, e.g. Eastmoney. */
interface DataSource {
  /** Stable identifier surfaced in results and logs. */
  readonly id: string;
  readonly capabilities: DataSourceCapabilities;
  /** All currently listed A-share stocks (universe candidates), paged internally. */
  listStocks(signal: AbortSignal): Promise<StockMeta[]>;
  /** Daily bars for one stock from `startDate` (YYYYMMDD) onward, ascending. */
  dailyBars(fullCode: string, startDate: string, signal: AbortSignal): Promise<Bar[]>;
  /**
   * Optional incremental refresh: given the bars already cached for a stock,
   * return the merged, up-to-date series, or `null` when no change is needed.
   * Sources omit this when their data needs a full re-fetch on every refresh;
   * the screener then falls back to {@link DataSource.dailyBars}.
   */
  refreshBars?(fullCode: string, startDate: string, cached: Bar[], signal: AbortSignal): Promise<Bar[] | null>;
}
//#endregion
//#region src/datasources/eastmoney.d.ts
/**
 * Build the Eastmoney data source, binding it to the shared rate limiter so
 * callers never pass request-budget plumbing around.
 */
declare function createEastmoneyDataSource(limiter: RateLimiter): DataSource;
//#endregion
//#region src/datasources/sina.d.ts
/**
 * Build the Sina data source, bound to the shared rate limiter. Bars are
 * 前复权 daily; volume is converted from shares to lots (手) to match the
 * domain convention.
 */
declare function createSinaDataSource(limiter: RateLimiter): DataSource;
/** Export for tests. */
//#endregion
//#region src/datasources/tencent.d.ts
/**
 * Build the Tencent data source, bound to the shared rate limiter. Bars are
 * 后复权 daily; use as a fallback only (reported closes are not market prices).
 */
declare function createTencentDataSource(limiter: RateLimiter): DataSource;
/** Export for tests. */
//#endregion
//#region src/datasources/index.d.ts
declare const FACTORIES: {
  /** Sina Finance 前复权日线: 免费、单请求 1023 根、最新价≈市价 (推荐主源)。 */
  readonly sina: typeof createSinaDataSource;
  /** 东方财富: 免费、前复权、含全市场股票清单 (免费回退源)。 */
  readonly eastmoney: typeof createEastmoneyDataSource;
  /** 腾讯: 免费、后复权 (报告价会虚高), 仅作备胎。 */
  readonly tencent: typeof createTencentDataSource;
};
/** Selectable data-source ids. */
type DataSourceId = keyof typeof FACTORIES;
/** Build the data source for `id`, bound to the process-lifetime rate budget. */
//#endregion
//#region src/index.d.ts
declare const name = "a-share-screener";
declare const inject: string[];
interface Config {
  /** Cache directory; defaults to $DSH_HOME/a-share-screener (~/.dsh fallback). */
  cacheDir?: string | null;
  /** Data source for stock list + klines. Default `sina`. */
  dataSource: DataSourceId;
  /** Outbound request budget shared by every data-source call. */
  requestsPerMinute: number;
  /** Trading-day bars kept per stock (window for high/percentile lookback). */
  historyBars: number;
  /** Exclude ST / delisting-warning stocks. */
  excludeST: boolean;
  /** Exclude Beijing Stock Exchange stocks (30% limit rules). */
  excludeBSE: boolean;
  /** Exclude stocks listed fewer than this many days. */
  minListDays: number;
  /** Exclude stocks listed longer than this many days (0 = no upper bound). */
  maxListDays: number;
  /** Cooperative timeout budget for one full scan, milliseconds. */
  scanTimeoutMs: number;
}
declare const Config: Schema<Config>;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };