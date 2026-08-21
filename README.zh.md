# dsh-a-share-screener

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 A 股选股插件：可扩展的选股策略注册表，tushare 主数据源（用户自己的 token）+ 东方财富免费回退（无需 token）。

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

## tushare token（可选，推荐）

插件配置只携带**环境变量名**（默认 `TUSHARE_TOKEN`），绝不携带机密本身。把你的 [tushare pro](https://tushare.pro/) token 放在任一处：

- 启动 dsh 的目录下 `.env` 文件：`TUSHARE_TOKEN=xxxxxxxx`
- shell 环境：`export TUSHARE_TOKEN=xxxxxxxx`
- dsh 的凭据托管存储（由 credentials 分层解析）

token 在每次扫描时解析，轮换无需重启。没有 token 时插件自动使用免费的东方财富源；强制 `dataSource: 'tushare'` 则必须有 token。

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

| 数据源 | token | 冷启动 | 增量 |
|---|---|---|---|
| [tushare pro](https://tushare.pro/)（主源） | 用户自备 | 按股拉 `daily`，限速（默认 200 次/分钟） | 每个新交易日一次 `daily` 调用，合并进每股缓存文件 |
| 东方财富公开接口（回退） | 无 | 按股拉后复权K线 | 按股追加 + 重叠一致性校验 |

插件配置 `dataSource: auto | tushare | eastmoney` 选择（`auto` = 有 token 用 tushare，否则东方财富）。缓存在 `$DSH_HOME/a-share-screener/`（可用 `cacheDir` 覆盖）。

## 插件配置

在 profile 的 `cordis.patch.yml` 中设置（所有字段均有默认值）：

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

## 已知限制

- tushare 免费档可用 `daily`/`stock_basic`/`trade_cal`，约 200–500 次/分钟；限速器默认 200（可配置），对限频拒绝自动退避重试。
- 东方财富接口公开但非官方文档化；字段漂移会响亮失败而非静默出错。
- ST 过滤基于当前股票名称（不追踪历史更名）。
- 全部计算在本地进程内完成；除所选数据源的 API 调用外不外发任何数据。

## 许可

MIT
