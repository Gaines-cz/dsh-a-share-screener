# dsh-a-share-screener

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 A 股选股插件：策略由可复用的原子过滤器组合而成，免费、无需 token 的多数据源（新浪主 / 东方财富回退 / 腾讯备胎），并抽象出可扩展的数据源接入层，附带独立 CLI。

**这是对历史量价形态的技术筛选工具，不构成任何投资建议。**

## 安装

需要 `dsh` CLI（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）。

```sh
dsh plugin --profile myprofile add github:Gaines-cz/dsh-a-share-screener
```

git 安装拉取的是源码，但预构建的 `lib/` 产物已提交进仓库，安装时不会执行任何构建脚本。如需不可变安装可锁定 commit（`github:Gaines-cz/dsh-a-share-screener#<sha>`）。

启动：

```sh
dsh --profile myprofile
```

## 使用

用自然语言对 agent 说：

> 列出可用的选股策略。
> 用 low_flat_limit_up 扫全市场，minDrawdownFromHigh 0.7。

注册了三个工具：

| 工具 | 用途 |
|---|---|
| `a_share_list_strategies` | 策略 id、描述、参数、默认值与合法范围 |
| `a_share_list_filters` | 原子过滤器 id、描述、参数、默认值与合法范围 |
| `a_share_screen` | 全市场扫描；返回候选股及量化证据 |

首次全量扫描会下载历史数据到本地磁盘缓存，耗时数分钟（受数据源限速约束）；之后复用缓存、只增量拉取新交易日。取消是协作式的——中止工具调用即停止扫描。

## 内置策略

### `flat_base_low`

"底部走平"：股价处于近期价格分布的低位（默认 ≤ 15 分位，窗口 ~3 年、按可用数据截断），同时近一个月为均线粘合的横盘平台。不要求涨停形态。配合 `minListDays` / `maxListDays` 约束上市年限——如 `minListDays: 365` + `maxListDays: 1460` 即筛选上市 1–4 年的股票。

### `low_flat_breakout`

"深低位 + 放量突破"——`low_flat_limit_up` 的右侧孪生版：股价深跌至窗口高点之下（默认回撤 ≥ 65%），近期出现一根放量阳线（≥ 前 5 日均量 2 倍）收盘突破此前一个月平台高点 ≥ 2% 且此后未跌回平台内，同时 MA20 止跌走平、股价站上 MA20。刻意不含 `low_percentile` 闸门：突破收盘价按构造就处于底部区间分布的顶端，分位必然失效。

### `low_flat_limit_up`

"历史低位、平台走平、放量涨停后回落缩量"：股价深跌至窗口高点之下（默认回撤 ≥ 65%）、处于近 ~3 年分布底部（≤ 15 分位）、近一个月为均线粘合的横盘平台、且近 ~6 个月内出现过一次放量涨停（≥ 前 5 日均量 2 倍），随后回落跌破涨停日收盘价且量能冷却至涨停日的 ≤ 40%。

所有阈值都是可按次覆盖的参数（默认值见 `a_share_list_strategies`）。涨停判定按板块：主板 10%、创业板/科创板 20%、北交所 30%。全部价格水平计算基于链式日收益率指数，除权除息不会伪造暴跌或底部。股票池过滤（均可配置）：ST/退市警示、北交所、上市不满 `minListDays` 天（默认 365）、上市超过 `maxListDays` 天（默认 0 = 不设上限）。

所有策略都是下方原子过滤器的组合。

## 原子过滤器与组合

每个策略都是对可复用原子过滤器的声明式谓词，通过 AND / OR / NOT 组合成表达式树。当前内置九个过滤器（`a_share_list_filters` 可列出各自的参数）：

| 过滤器 | 闸门 |
|---|---|
| `deep_drawdown` | 最新价较窗口高点回撤 ≥ X% |
| `low_percentile` | 最新价处于窗口 ≤ X 分位 |
| `bars_since_low` | 窗口最低点距今 ≥ N 根K线且价格仍贴近低点 |
| `flat_base` | 近期窗口横盘走平且均线粘合 |
| `platform_breakout` | 放量收盘突破前平台高点且此后守住平台上方 |
| `ma_stabilization` | 均线止跌（斜率 ≥ X）且价格站上均线 |
| `volatility_regime` | 年化已实现波动率落在 [下限, 上限] 区间 |
| `volume_limit_up` | 窗口内存在放量涨停日 |
| `cooldown_pullback` | 涨停后回落跌破收盘价且量能冷却 |

组合求值时每只股票只做一次共享推导（链式收益率指数 + 预计算的涨停日），然后对表达式树求值：短路路径产出严格命中，全量路径产出逐闸门指标供分层报告——"近邻候选"（只差一道闸）即由此而来。

## 数据源

内置三个免费、无需 token 的数据源，默认 `sina`（前复权收盘价与市价一致）：

| 数据源 | token | 说明 |
|---|---|---|
| 新浪（默认） | 无 | 前复权日线，单请求 1023 根；推荐主源 |
| 东方财富 | 无 | 按股后复权K线；列表域名实时→延迟自动故障转移 |
| 腾讯 | 无 | 后复权备胎（报告价格会虚高）；仅作后备 |

每个适配器都位于 `DataSource` 接口之后（`src/datasources/types.ts`）；screener、工具、插件入口只依赖该接口，绝不 import 具体厂商。缓存在 `$DSH_HOME/a-share-screener/<source-id>/`（可用 `cacheDir` 覆盖）。

### 新增数据源

后续接入其他厂商时，实现 `DataSource` 并在 `src/datasources/index.ts` 注册即可：

```ts
// src/datasources/my-vendor.ts
import type { DataSource } from './types.js'

export function createMyVendorDataSource(limiter: RateLimiter): DataSource {
  async function listStocks(signal: AbortSignal) { /* → StockMeta[] */ }
  async function dailyBars(fullCode: string, startDate: string, signal: AbortSignal) { /* → Bar[] */ }
  return { id: 'my-vendor', capabilities: { industry: false }, listStocks, dailyBars }
}
```

把 `myvendor: createMyVendorDataSource` 加进 `FACTORIES`。若厂商能提供板块分类，则设 `capabilities.industry: true`（并填充 `StockMeta.industry`）。

## 插件配置

在 profile 的 `cordis.patch.yml` 中设置（所有字段均有默认值）：

```yaml
- replace:
    - id: a-share-screener
      config:
        # cacheDir: /path/to/cache   # 可选，默认 $DSH_HOME/a-share-screener
        dataSource: sina             # sina（默认）| eastmoney | tencent
        requestsPerMinute: 200
        historyBars: 800
        scanTimeoutMs: 1800000
        excludeST: true
        excludeBSE: true
        minListDays: 365
        maxListDays: 0                # 0 = 不设上限; 如 1460 ≈ 4 年
```

## 新增策略

推荐方式是把现有原子过滤器组合成谓词树——无需编写任何筛选代码，逐闸门诊断自动获得：

```ts
// src/strategies/my-strategy.ts
import { composeStrategy } from '../engine/compose.js'
import { createFilterRegistry } from '../filters/index.js'

export const myStrategy = composeStrategy({
  id: 'my_strategy',
  description: '策略寻找什么（模型可见）。',
  // 深度回撤 AND 平台走平（这次不要求涨停形态）
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

若原子过滤器覆盖不了所需形态，可手工实现 `Strategy` 接口（`screen` 返回命中或 null；可选的 `diagnose` 驱动分层报告）。新的原子过滤器通过 `src/filters/index.ts` 以与内置过滤器相同的 `Filter` 接口接入。

两种方式都在 `src/index.ts` 里与内置策略并列注册即可——无需改动其他代码。工具 schema 和 `a_share_list_strategies` 自动纳入。

## 独立 CLI (无需 dsh)

除作为 dsh 插件外，同一套代码提供独立命令行工具：手动触发、本地缓存、免费数据源，无需 token。

```sh
pnpm install
pnpm sync        # 每周一次: 增量同步本地行情缓存 (默认全市场; 用 --board / --codes 缩小范围)
pnpm scan        # 选股: 生成分层报告 (严格命中 + 近邻候选)
pnpm strategies  # 列出策略 id 及参数表
pnpm filters     # 列出原子过滤器 id 及参数表
pnpm sources     # 列出数据源 id
```

常用选项:

| 选项 | 说明 |
|---|---|
| `--source sina\|eastmoney\|tencent` | 数据源 (默认 `sina`) |
| `--board <板块名>` | 只扫东财板块成分, 如 `--board 核能核电` / `--board 农林牧渔` |
| `--codes 600519,000858` | 只扫指定代码 |
| `--strategy <id>` | 策略 (默认 `low_flat_limit_up`) |
| `--params k=v,k2=v2` | 覆盖策略参数, 如 `--params minDrawdownFromHigh=0.5` |
| `--min-list-days <n>` | 剔除上市不足 n 天 (默认 365) |
| `--max-list-days <n>` | 剔除上市超过 n 天 (默认 0 = 不设上限; 如 1460 ≈ 4 年) |
| `--cache-dir <dir>` | 缓存目录 (默认 `~/.dsh/a-share-screener`) |
| `--out <dir>` | 报告输出目录 (默认 `reports/`) |

`pnpm scan` 把报告写到 `reports/<日期>-<策略>-<范围>.md` (+ `.json`)。报告分两层:

- **严格命中**: 该策略的全部闸门通过 (闸门数随策略而定, 见 `pnpm strategies`);
- **近邻候选**: 只差一道闸的票, 每只标明各闸门的量化指标和卡在哪一道 —— 专为人工二次甄别设计 (严格条件常为 0 命中, 近邻层保证每次都有可甄别的候选)。

## 已知限制

- 免费接口（新浪 / 东方财富 / 腾讯）公开但非官方文档化；字段漂移会响亮失败而非静默出错，东财列表域名实时→延迟自动故障转移，单一域名被封不会中断扫描。
- 免费源均不提供申万行业分类（`capabilities.industry` 为 false）；板块选股通过东财行业/概念板块成分接口（`--board`）实现，无需行业字段。
- ST 过滤基于当前股票名称（不追踪历史更名）。
- 全部计算在本地进程内完成；除数据源的 API 调用外不外发任何数据。

## 许可

MIT
