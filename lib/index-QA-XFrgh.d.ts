import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts

declare const name = "a-share-screener";
declare const inject: string[];
interface Config {
  /** Env-var name whose value holds the Tushare Pro token. */
  tokenEnv: string;
  /** Data source selection; 'auto' prefers tushare when a token resolves. */
  dataSource: 'auto' | 'tushare' | 'eastmoney';
  /** Cache directory; defaults to $DSH_HOME/a-share-screener (~/.dsh fallback). */
  cacheDir?: string | null;
  /** Outbound request budget shared by all data-source calls. */
  requestsPerMinute: number;
  /** Trading-day bars kept per stock (window for high/percentile lookback). */
  historyBars: number;
  /** Exclude ST / delisting-warning stocks. */
  excludeST: boolean;
  /** Exclude Beijing Stock Exchange stocks (30% limit rules). */
  excludeBSE: boolean;
  /** Exclude stocks listed fewer than this many days. */
  minListDays: number;
  /** Cooperative timeout budget for one full scan, milliseconds. */
  scanTimeoutMs: number;
}
declare const Config: Schema<Config>;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };