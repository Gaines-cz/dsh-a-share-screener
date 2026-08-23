# dsh-a-share-screener

An [A-share](https://en.wikipedia.org/wiki/Stock_screener) stock-screening plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): strategies composed from reusable atomic filters on free, token-less data sources, behind an extensible data-source abstraction.

**This is a technical screening tool for historical price/volume patterns. It is NOT investment advice.**

## Install

Requires the `dsh` CLI ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)).

```sh
dsh plugin --profile myprofile add github:Gaines-cz/dsh-a-share-screener
```

Git installs pull source, but the prebuilt `lib/` output is committed to the repo, so no build script runs at install time. Pin a commit (`github:Gaines-cz/dsh-a-share-screener#<sha>`) if you want immutability.

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

## Built-in strategies

### `flat_base_low`

"Bottom + flat base": the stock trades at or below the 15th percentile of its recent price distribution (~3 years, clamped to available bars) while the last month is a flat, MA-converged base. No limit-up pattern is required. Pair it with `minListDays` / `maxListDays` to constrain listing age — e.g. `minListDays: 365` + `maxListDays: 1460` screens stocks listed 1–4 years.

### `low_flat_breakout`

"Deep low + near-bottom volume breakout" — the right-side twin of `low_flat_limit_up`: deep below the window high (default ≥ 65% drawdown) while staying near the window low (low ≥ 40 bars back, price ≤ 50% above it), a volume-heavy day (≥ 2× the prior 5-day average) closed ≥ 2% above the high of the preceding one-month flat base with the price holding out of the base since (default ≥ 2 confirming closes), and the MA20 stopped falling with price at or above it. Deliberately no `low_percentile` gate: a breakout close above the base high sits at the top of the bottom-side distribution by construction.

### `low_flat_limit_up`

"Historical low, flat base, faded volume-heavy limit-up": the stock sits deep below its window high (default ≥ 65% drawdown) at the bottom of its recent distribution (≤ 15th percentile of ~3 years), the last month is a flat, MA-converged base, and within ~6 months there was a limit-up day on ≥ 2× the prior 5-day average volume that has since pulled back below its close while volume cooled to ≤ 40% of the limit-up day.

All thresholds are per-call parameters with defaults (see `a_share_list_strategies`). Board-aware limit-up thresholds: 10% main board, 20% ChiNext/STAR, 30% BSE. All price-level math runs on a chained daily-return index, so splits and dividends cannot fake a crash or a bottom. Universe filters (all configurable): ST/delisting names, BSE, listings younger than `minListDays` (default 365) or older than `maxListDays` (default 0 = no upper bound).

All strategies are compositions of the atomic filters below.

## Atomic filters & composition

Every strategy is a declarative predicate over reusable atomic filters, combined with AND / OR / NOT into an expression tree. Fifteen filters ship today (`a_share_list_filters` lists them with their parameters):

| Filter | Gate | Needs |
|---|---|---|
| `deep_drawdown` | latest price ≥ X% below the window high | — |
| `low_percentile` | latest price ranks ≤ Xth percentile of the window | — |
| `bars_since_low` | the window low lies ≥ N bars back while price stays near it | — |
| `flat_base` | recent window is flat with converged MAs | — |
| `platform_breakout` | a volume-heavy close cleared the preceding flat base's high and held | — |
| `ma_stabilization` | the MA stopped falling (slope ≥ X) and price sits at/above it | — |
| `volatility_regime` | annualized realized volatility inside [min, max] | — |
| `volume_limit_up` | a volume-heavy limit-up day exists in the window | — |
| `cooldown_pullback` | price pulled back below that close and volume cooled off | — |
| `volume_dry_up` | absolute volume drought: recent average ≤ X% of the preceding baseline | — |
| `industry_clearance` | the industry board itself is in deep clearance (median member drawdown / deep share) | industry (all shipped sources) |
| `industry_position` | the industry board sits low in its own range (median member window percentile) | industry (all shipped sources) |
| `market_cap_band` | total market cap inside [min, max] 亿元 | marketCap (all shipped sources) |
| `amount_liquidity` | median daily traded value ≥ X 亿元 | amount (eastmoney only) |
| `turnover_band` | median daily turnover inside [min, max] % | marketCap (all shipped sources) |

Filters that need a capability the active source lacks refuse to run — the scan aborts loudly with the missing capability named instead of silently degrading.

## Ad-hoc predicates

`a_share_screen` also accepts a `predicate` (mutually exclusive with `strategy`): a small JSON DSL over the atomic filter ids, e.g.

```json
{ "all": ["deep_drawdown", { "any": ["platform_breakout", "volume_limit_up"] }] }
```

Groups are `{ "all": [...] }` (AND), `{ "any": [...] }` (OR), `{ "not": … }` (NOT); leaves are filter ids from `a_share_list_filters`; max depth 3, max 12 leaves. `params` tunes the composition exactly like a registered strategy. The CLI equivalent is `--predicate '<json>'`. Strategies using `industry_clearance` trigger a market-wide aggregation pre-pass; its per-board statistics (median drawdown, deep share, members) appear in each candidate's evidence.

Composition runs one shared derivation pass per stock (chained return index + pre-computed limit-up days), then evaluates the tree: a short-circuit pass for strict hits and a full pass that produces per-gate metrics for the tiered report — which is how "near-miss" candidates (one gate short) are surfaced.

## Data source

Three free, token-less sources ship today; `sina` is the default (its 前复权 closes match market prices).

| Source | Token | Notes |
|---|---|---|
| Sina (default) | none | 前复权 daily bars, 1023 bars per request; the recommended primary |
| Eastmoney | none | back-adjusted klines per stock (the only source with per-bar amount); clist host fails over realtime → delayed |
| Tencent | none | 后复权 fallback (report prices run high); backup only |

The stock list (with industry + market caps) comes from the shared Eastmoney clist endpoint for all three sources.

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
        dataSource: sina             # sina (default) | eastmoney | tencent
        requestsPerMinute: 200
        historyBars: 800
        scanTimeoutMs: 1800000
        excludeST: true
        excludeBSE: true
        minListDays: 365
        maxListDays: 0                # 0 = no upper bound; e.g. 1460 ≈ 4 years
```

## Add a strategy

The preferred way is composing existing atomic filters into a predicate tree — no screening code to write, per-gate diagnosis comes for free:

```ts
// src/strategies/my-strategy.ts
import { composeStrategy } from '../engine/compose.js'
import { createFilterRegistry } from '../filters/index.js'

export const myStrategy = composeStrategy({
  id: 'my_strategy',
  description: 'What it looks for, model-facing.',
  // deep drawdown AND flat base (no limit-up requirement this time)
  predicate: {
    kind: 'and',
    children: [
      { kind: 'filter', filter: 'deep_drawdown' },
      { kind: 'filter', filter: 'flat_base' },
    ],
  },
  filters: createFilterRegistry(),
})
```

For shapes the atomic filters do not cover, implement the `Strategy` interface by hand (`screen` returns a hit or null; an optional `diagnose` powers the tiered report). New atomic filters plug in through `src/filters/index.ts` with the same `Filter` interface the built-ins use.

Either way, register it in `src/index.ts` next to the built-in one — no other changes. The tool schemas and `a_share_list_strategies` pick it up automatically.

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

Common options: `--source sina|eastmoney|tencent`, `--board <name>` (e.g. `--board 核能核电`), `--codes 600519,000858`, `--strategy <id>`, `--params k=v,k2=v2`, `--min-list-days <n>`, `--max-list-days <n>` (0 = no upper bound), `--cache-dir <dir>`, `--out <dir>`.

`pnpm scan` writes `reports/<date>-<strategy>-<scope>.md` (+ `.json`). The near-miss tier (exactly one gate failed) exists because a strict multi-gate strategy frequently returns zero hits — it keeps every run reviewable.

## Limitations

- The free endpoints (Sina / Eastmoney / Tencent) are public but undocumented; field drift fails loudly rather than silently, and Eastmoney's clist host fails over realtime → delayed so one blocked host does not kill a scan.
- Industry classification is Eastmoney's own taxonomy (`f100` on the shared stock list — all shipped sources expose it via `capabilities.industry`), not the SW (申万) L1/L2 scheme; `industry_clearance` aggregates on it. Separately, `--board` screening uses the Eastmoney industry/concept board-member endpoint.
- ST filtering uses the current stock name (no historical name-change tracking).
- Everything runs in the local process; no data leaves your machine except API calls to the data source.

## License

MIT
