import Schema from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts

declare const name = "a-share-screener";
declare const inject: string[];
interface Config {
  /** Cache directory; defaults to $DSH_HOME/a-share-screener (~/.dsh fallback). */
  cacheDir?: string | null;
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
  /** Cooperative timeout budget for one full scan, milliseconds. */
  scanTimeoutMs: number;
}
declare const Config: Schema<Config>;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };