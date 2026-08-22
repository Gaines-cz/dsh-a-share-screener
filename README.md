# dsh-a-share-screener

An [A-share](https://en.wikipedia.org/wiki/Stock_screener) stock-screening plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): pluggable screening strategies on a free, token-less Eastmoney data source, behind an extensible data-source abstraction.

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

## Use

Ask the agent in natural language:

> List the available screening strategies.
> Screen all A-shares with low_flat_limit_up, minDrawdownFromHigh 0.7.

Three tools are registered:

| Tool | Purpose |
|---|---|
| `a_share_list_strategies` | Strategy ids, descriptions, parameters, defaults, valid ranges |
| `a_share_list_filters` | Atomic filter ids, descriptions, parameters, defaults, valid ranges |
| `a_share_screen` | Full-market scan; returns candidates with quantified evidence |

The first full scan downloads history into a local disk cache and can take many minutes (bounded by the data source's rate limit); later scans reuse the cache and only fetch new trade dates. Cancellation is cooperative — aborting the tool call stops the scan.

## The `low_flat_limit_up` strategy

"Historical low, flat base, faded volume-heavy limit-up": the stock sits deep below its window high (default ≥ 65% drawdown) at the bottom of its recent distribution (≤ 15th percentile of ~3 years), the last month is a flat, MA-converged base, and within ~6 months there was a limit-up day on ≥ 2× the prior 5-day average volume that has since pulled back below its close while volume cooled to ≤ 40% of the limit-up day.

All thresholds are per-call parameters with defaults (see `a_share_list_strategies`). Board-aware limit-up thresholds: 10% main board, 20% ChiNext/STAR, 30% BSE. All price-level math runs on a chained daily-return index, so splits and dividends cannot fake a crash or a bottom. Universe filters (all configurable): ST/delisting names, BSE, listings younger than 365 days.

## Data source

The plugin ships one free, token-less data source: [Eastmoney](https://www.eastmoney.com/) public endpoints.

| Source | Token | Cold scan | Incremental |
|---|---|---|---|
| Eastmoney (built-in) | none | per-stock back-adjusted klines; clist host fails over realtime → delayed | per-stock append with overlap-consistency check |

Every adapter sits behind a `DataSource` interface (`src/datasources/types.ts`); the screener, tools, and plugin entry import only that interface, never a concrete vendor. Cache lives under `$DSH_HOME/a-share-screener/<source-id>/` (override with `cacheDir`).

### Add a data source

To support another vendor later, implement `DataSource` and register it in `src/datasources/index.ts`:

```ts
// src/datasources/my-vendor.ts
import type { DataSource } from './types.js'

export function createMyVendorDataSource(limiter: RateLimiter): DataSource {
  async function listStocks(signal: AbortSignal) { /* → StockMeta[] */ }
  async function dailyBars(fullCode: string, startDate: string, signal: AbortSignal) { /* → Bar[] */ }
  return { id: 'my-vendor', capabilities: { industry: false }, listStocks, dailyBars }
}
```

add `myvendor: createMyVendorDataSource` to `FACTORIES`. Set `capabilities.industry: true` (and populate `StockMeta.industry`) if the vendor can classify sectors.

## Plugin configuration

Set in your profile's `cordis.patch.yml` (all fields have defaults):

```yaml
- replace:
    - id: a-share-screener
      config:
        # cacheDir: /path/to/cache   # optional, defaults to $DSH_HOME/a-share-screener
        requestsPerMinute: 200
        historyBars: 800
        scanTimeoutMs: 1800000
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

## Standalone CLI (no dsh required)

The same code ships a standalone command-line tool: manual trigger, local bar cache, free multi-source data (Sina primary / Eastmoney fallback / Tencent backup), no token.

```sh
pnpm install
pnpm sync        # incremental local cache sync (weekly); default full market, narrow with --board / --codes
pnpm scan        # tiered report: strict hits + near-miss candidates, each with gate-level metrics
pnpm strategies  # list strategy ids and their parameter tables
pnpm filters     # list atomic filter ids and their parameter tables
pnpm sources     # list data source ids
```

Common options: `--source sina|eastmoney|tencent`, `--board <name>` (e.g. `--board 核能核电`), `--codes 600519,000858`, `--strategy <id>`, `--params k=v,k2=v2`, `--cache-dir <dir>`, `--out <dir>`.

`pnpm scan` writes `reports/<date>-<strategy>-<scope>.md` (+ `.json`). The near-miss tier (exactly one gate failed) exists because a strict multi-gate strategy frequently returns zero hits — it keeps every run reviewable.

## Limitations

- Eastmoney endpoints are public but undocumented; field drift fails loudly rather than silently, and the clist host fails over realtime → delayed so one blocked host does not kill a scan.
- Free sources do not classify industries (`capabilities.industry` is false); sector screening works through the Eastmoney industry/concept board-member endpoint (`--board`).
- ST filtering uses the current stock name (no historical name-change tracking).
- Everything runs in the local process; no data leaves your machine except API calls to the data source.

## License

MIT
