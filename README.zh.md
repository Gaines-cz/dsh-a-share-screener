# dsh-a-share-screener

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 A 股选股插件：可扩展的选股策略注册表 + 独立 CLI，免费、无需 token 的多数据源（新浪主 / 东方财富回退 / 腾讯备胎），并抽象出可扩展的数据源接入层。

**这是对历史量价形态的技术筛选工具，不构成任何投资建议。**

## 安装

需要 `dsh` CLI（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）。

```sh
dsh plugin --profile myprofile add github:Gaines-cz/dsh-a-share-screener
```

git 安装拉取的是源码，pnpm 会执行包的 `prepare` 构建脚本。pnpm ≥ 10 在你授权前会拦截——把 pnpm 打印的确切包键复制进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-a-share-screener: true
```

然后重新执行 `add`。授权意味着你允许该包的构建脚本在安装时于本机执行；如需不可变安装可锁定 commit（`github:Gaines-cz/dsh-a-share-screener#<sha>`）。

启动：

```sh
dsh --profile myprofile
```

## 使用

用自然语言对 agent 说：

> 列出可用的选股策略。
> 用 low_flat_limit_up 扫全市场，minDrawdownFromHigh 0.7。

注册了两个工具：

| 工具 | 用途 |
|---|---|
| `a_share_list_strategies` | 策略 id、描述、参数、默认值与合法范围 |
| `a_share_screen` | 全市场扫描；返回候选股及量化证据 |

首次全量扫描会下载历史数据到本地磁盘缓存，耗时数分钟（受数据源限速约束）；之后复用缓存、只增量拉取新交易日。取消是协作式的——中止工具调用即停止扫描。

## `low_flat_limit_up` 策略

"历史低位、平台走平、放量涨停后回落缩量"：股价深跌至窗口高点之下（默认回撤 ≥ 65%）、处于近 ~3 年分布底部（≤ 15 分位）、近一个月为均线粘合的横盘平台、且近 ~6 个月内出现过一次放量涨停（≥ 前 5 日均量 2 倍），随后回落跌破涨停日收盘价且量能冷却至涨停日的 ≤ 40%。

所有阈值都是可按次覆盖的参数（默认值见 `a_share_list_strategies`）。涨停判定按板块：主板 10%、创业板/科创板 20%、北交所 30%。全部价格水平计算基于链式日收益率指数，除权除息不会伪造暴跌或底部。股票池过滤（均可配置）：ST/退市警示、北交所、上市不满 365 天。

## 数据源

插件内置唯一一个免费、无需 token 的数据源：[东方财富](https://www.eastmoney.com/) 公开接口。

| 数据源 | token | 冷启动 | 增量 |
|---|---|---|---|
| 东方财富（内置） | 无 | 按股拉后复权K线；列表域名实时→延迟自动故障转移 | 按股追加 + 重叠一致性校验 |

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
        requestsPerMinute: 200
        historyBars: 800
        scanTimeoutMs: 1800000
        excludeST: true
        excludeBSE: true
        minListDays: 365
```

## 新增策略

策略是插件加载时注册的纯谓词函数：

```ts
// src/strategies/my-strategy.ts
import type { Strategy } from './registry.js'

export const myStrategy: Strategy = {
  id: 'my_strategy',
  description: '策略寻找什么（模型可见）。',
  paramDocs: { /* 参数名 → { type, default, description, min?, max? } */ },
  screen({ stock, bars }, params) {
    // bars: 升序 { date, close, volume, ret }——ret 为真实日收益率
    return null // 或 { code, fullCode, name, board, strategy, evidence }
  },
}
```

在 `src/index.ts` 里与内置策略并列注册即可——无需改动其他代码。工具 schema 和 `a_share_list_strategies` 自动纳入。

## 独立 CLI (无需 dsh)

除作为 dsh 插件外，同一套代码提供独立命令行工具：手动触发、本地缓存、免费数据源，无需 token。

```sh
pnpm install
pnpm sync    # 每周一次: 增量同步本地行情缓存 (默认全市场; 用 --board / --codes 缩小范围)
pnpm scan    # 选股: 生成分层报告 (严格命中 + 近邻候选)
```

常用选项:

| 选项 | 说明 |
|---|---|
| `--source sina\|eastmoney\|tencent` | 数据源 (默认 `sina`) |
| `--board <板块名>` | 只扫东财板块成分, 如 `--board 核能核电` / `--board 农林牧渔` |
| `--codes 600519,000858` | 只扫指定代码 |
| `--strategy <id>` | 策略 (默认 `low_flat_limit_up`) |
| `--params k=v,k2=v2` | 覆盖策略参数, 如 `--params minDrawdownFromHigh=0.5` |
| `--cache-dir <dir>` | 缓存目录 (默认 `~/.dsh/a-share-screener`) |
| `--out <dir>` | 报告输出目录 (默认 `reports/`) |

`pnpm scan` 把报告写到 `reports/<日期>-<策略>-<范围>.md` (+ `.json`)。报告分两层:

- **严格命中**: 四道闸门全过;
- **近邻候选**: 只差一道闸的票, 每只标明各闸门的量化指标和卡在哪一道 —— 专为人工二次甄别设计 (严格条件常为 0 命中, 近邻层保证每次都有可甄别的候选)。

## 已知限制

- 东方财富接口公开但非官方文档化；字段漂移会响亮失败而非静默出错，列表域名实时→延迟自动故障转移，单一域名被封不会中断扫描。
- 免费源均不提供申万行业分类（`capabilities.industry` 为 false）；板块选股通过东财行业/概念板块成分接口（`--board`）实现，无需行业字段。
- ST 过滤基于当前股票名称（不追踪历史更名）。
- 全部计算在本地进程内完成；除数据源的 API 调用外不外发任何数据。

## 许可

MIT
