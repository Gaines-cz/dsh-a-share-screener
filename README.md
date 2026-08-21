# dsh-a-share-screener

An [A-share](https://en.wikipedia.org/wiki/Stock_screener) stock-screening plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): pluggable screening strategies, a Tushare primary data source (your own token), and a free Eastmoney fallback — no token required.

**This is a technical screening tool for historical price/volume patterns. It is NOT investment advice.**

## Install

Requires the `dsh` CLI ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)).

```sh
dsh plugin --profile myprofile add github:Gaines-cz/dsh-a-share-screener
```

Git installs pull source, so pnpm runs the package's `prepare` build script. pnpm ≥ 10 blocks that until you authorize it once — copy the exact package key pnpm prints into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-a-share-screener: true
```

then re-run the `add` command. Authorizing this means you allow the package's build script to run on your machine at install time — pin a commit (`github:Gaines-cz/dsh-a-share-screener#<sha>`) if you want immutability.

Start with the profile:

```sh
dsh --profile myprofile
```

## Tushare token (optional but recommended)

The plugin's config carries only an **env-var name** (default `TUSHARE_TOKEN`), never the secret. Put your [Tushare Pro](https://tushare.pro/) token in any of:

- a `.env` file in the directory you launch `dsh` from: `TUSHARE_TOKEN=xxxxxxxx`
- your shell environment: `export TUSHARE_TOKEN=xxxxxxxx`
- dsh's managed credentials storage (resolved by the credentials layer)

The token resolves at every scan, so rotating it needs no restart. Without a token the plugin automatically uses the free Eastmoney source (see below). You need a token to force `dataSource: 'tushare'`.

## Use

Ask the agent in natural language:

> List the available screening strategies.
> Screen all A-shares with low_flat_limit_up, minDrawdownFromHigh 0.7.

Two tools are registered:

| Tool | Purpose |
|---|---|
| `a_share_list_strategies` | Strategy ids, descriptions, parameters, defaults, valid ranges |
| `a_share_screen` | Full-market scan; returns candidates with quantified evidence |

The first full scan downloads history into a local disk cache and can take many minutes (bounded by the data source's rate limit); later scans reuse the cache and only fetch new trade dates. Cancellation is cooperative — aborting the tool call stops the scan.

## The `low_flat_limit_up` strategy

"Historical low, flat base, faded volume-heavy limit-up": the stock sits deep below its window high (default ≥ 65% drawdown) at the bottom of its recent distribution (≤ 15th percentile of ~3 years), the last month is a flat, MA-converged base, and within ~6 months there was a limit-up day on ≥ 2× the prior 5-day average volume that has since pulled back below its close while volume cooled to ≤ 40% of the limit-up day.

All thresholds are per-call parameters with defaults (see `a_share_list_strategies`). Board-aware limit-up thresholds: 10% main board, 20% ChiNext/STAR, 30% BSE. All price-level math runs on a chained daily-return index, so splits and dividends cannot fake a crash or a bottom. Universe filters (all configurable): ST/delisting names, BSE, listings younger than 365 days.

## Data sources

| Source | Token | Cold scan | Incremental |
|---|---|---|---|
| [Tushare Pro](https://tushare.pro/) (primary) | your own | per-stock `daily`, rate-limited (default 200 req/min) | one `daily` call per new trade date, merged into per-stock cache files |
| Eastmoney public endpoints (fallback) | none | per-stock back-adjusted klines; clist host fails over realtime → delayed | per-stock append with overlap-consistency check |
| Tencent quote center (last resort) | none | back-adjusted klines, paged at 640 rows/request | full-window refetch when stale |

Free-path behavior: each stock tries eastmoney first, then tencent. A circuit breaker skips eastmoney for the rest of the scan after 3 consecutive failures. Back-adjustment anchors differ between vendors, so each source keeps its own cache directory — series never mix sources.

Choose with the plugin config `dataSource: auto | tushare | eastmoney` (`auto` = tushare when a token resolves, else the free path). Cache lives under `$DSH_HOME/a-share-screener/` (override with `cacheDir`).

## Plugin configuration

Set in your profile's `cordis.patch.yml` (all fields have defaults):

```yaml
- replace:
    - id: a-share-screener
      config:
        tokenEnv: TUSHARE_TOKEN
        dataSource: auto
        requestsPerMinute: 200
        historyBars: 800
        excludeST: true
        excludeBSE: true
        minListDays: 365
```

## Add a strategy

Strategies are pure predicates registered at plugin load:

```ts
// src/strategies/my-strategy.ts
import type { Strategy } from './registry.js'

export const myStrategy: Strategy = {
  id: 'my_strategy',
  description: 'What it looks for, model-facing.',
  paramDocs: { /* name → { type, default, description, min?, max? } */ },
  screen({ stock, bars }, params) {
    // bars: ascending { date, close, volume, ret } — ret is the true daily return
    return null // or { code, fullCode, name, board, strategy, evidence }
  },
}
```

Register it in `src/index.ts` next to the built-in one — no other changes. The tool schemas and `a_share_list_strategies` pick it up automatically.

## Limitations

- Tushare free tier covers `daily`/`stock_basic`/`trade_cal` at ~200–500 calls/min; the rate limiter defaults to 200 (configurable) and retries rate-limit rejections.
- Eastmoney/Tencent endpoints are public but undocumented; field drift fails loudly rather than silently, and per-stock source fallback keeps one blocked host from killing a scan.
- ST filtering uses the current stock name (no historical name-change tracking).
- Everything runs in the local process; no data leaves your machine except API calls to the chosen source.

## License

MIT
