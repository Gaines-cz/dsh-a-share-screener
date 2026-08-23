# 原子过滤器扩展路线图（Filter Roadmap）

> 基于 2026-08 主干代码（PR#5 组合引擎之后）的深度研读结论，结合作者投资风格（左侧深回撤低分位 + 行业周期出清 + 高弹性次新研究）制定的扩展方案。
> 每个过滤器给出可直接落地的参数表 / 证据字段 / 实现要点 / 测试清单，按 PR 粒度切分。

## 状态（2026-08-23）

- **PR#0 已被主干吸收**：分支 `feat/list-age-and-flat-low-260823`（a9ccfce）把 report gateLine 改为动态渲染（诊断里有哪些 gate 渲染哪些），并为新过滤器铺了 `maxListDays` 宇宙上限与 `flat_base_low` 策略。新过滤器只需在 `GATE_CELLS`/`GATE_LABELS` 加条目。
- **Phase 1 已实现**（分支 `feat/phase1-filters-260823`，基于 a9ccfce）：`ma_stabilization` / `bars_since_low` / `platform_breakout` / `volatility_regime` 四个过滤器 + 策略 `low_flat_breakout` + tool 渲染泛化。
- **Phase 2 已实现**（同分支）：clist f100/f20/f21（行业 + 市值快照）、eastmoney kline amount（tuple 升 8 列、旧 7 列缓存兼容）、`industry_clearance`（两遍扫描行业聚合，`DerivedCtx.industry` 注入）/ `market_cap_band` / `amount_liquidity` 三过滤器、能力闸门（`Filter.requires` → `Strategy.requires` → 扫描开始响亮报错，绝不静默降级）。
- **Phase 3.1 已实现**：`a_share_screen` 支持 `predicate` JSON DSL（all/any/not，≤3 层、≤12 叶，与 strategy 互斥；CLI 等价 `--predicate`）；OR/NOT 树命中证据经 sanitize 去除 null；`a_share_list_filters` 输出每个过滤器的数据要求。
- **实现期设计修正**：右侧策略去掉了 `low_percentile` 闸门——突破收盘价按构造处于底部区间分布顶端（分位 ≈ 100%），与"最新价分位低"结构性互斥；位置语义由 `deep_drawdown` 承担。`platform_breakout` 自含突破前平台检验，故右侧策略也不叠 `flat_base`（突破后最新窗口必不平）。
- 顺带修复：`tool.ts` 的扫描结果表原为 limit-up 策略硬编码列，其他策略（如 `flat_base_low`）会渲染成整排 `-`；现改为 limit-up 保持原文、其余策略走通用证据列。
- **待办**：Phase 3.2 `turnover_band`（f21 流通市值 + amount 均已就绪，只差组合）、Phase 3.3 估值闸门（需独立立项）。

---

## 0. 代码现状的硬约束（设计前提）

研读 `src/` 全部 2974 行后确认的约束，所有设计都必须遵守：

| # | 约束 | 来源 | 影响 |
|---|---|---|---|
| C1 | `SeriesBar` 只有 `date/close/volume/ret`，**无 open/high/low、无 amount** | `types.ts:84` | Phase 1 过滤器只能基于收盘价指数、成交量、日收益；日内形态（炸板、长上影）不可实现 |
| C2 | `DerivedCtx` 是**参数无关**的（idx / limitUpDays / last / current） | `engine/derive.ts` | 需要窗口参数的派生量（MA、波动率）必须在 filter 内用 `smaAtIndex`/`meanVolume` 现算，不得进 ctx |
| C3 | ParamDoc 合并规则：**同名同签名自动去重，异签名响亮报错** | `engine/compose.ts:67` | 新过滤器要么用全新参数名，要么刻意复用现有参数名且文档完全一致（含 default） |
| C4 | `report.ts` 的 `GATE_LABELS` + `gateLine()` 对现有 5 个 filter **硬编码** | `report.ts:41-84` | 每加一个 filter 要同步改 report 两处 → 应在 PR#0 顺带重构为 filter 自带 label 元数据 |
| C5 | 三个源的 volume 统一为**手**；sina 是前复权（最新 close≈市价），tencent/emoney 是后复权 | `datasources/sina.ts` | 任何用到"绝对价格×量"的过滤器（成交额估算）只在 sina 上语义正确 → 必须走数据源能力位，不得静默近似 |
| C6 | eastmoney kline 响应**已含 amount**（fields2 f57）但适配器丢弃了；clist 可加 f100(行业)/f20(总市值)/f21(流通市值) | `datasources/eastmoney.ts:148,56` | 成交额/行业/市值是"轻量数据扩展"，不用换数据商 |
| C7 | `StockMeta.industry?` 与 `capabilities.industry` **已预留**（注释明说是未来扩展点） | `types.ts:44` / `datasources/types.ts:11` | 行业过滤器只需填充数据 + 建聚合管道，接口不用动 |
| C8 | `a_share_screen` 的 strategy enum 是 `registry.ids()` **动态生成** | `tool.ts:94-108` | 新注册策略自动出现在工具里，无需改工具层（但 tool description 里"Available: …"是拼接的，也自动） |
| C9 | Bar 缓存 tuple 是 7 列 `[date,o,h,l,c,v,preClose]` | `types.ts:71` | 加 amount = tuple v2 + 容错解析 + 一次性迁移 |
| C10 | 全市场扫描性能基线：**4989 只 / 41s（缓存热）** | 实测 20260822 | 新 filter 必须 O(window)，禁止 O(n·w) 滚动重算 |

**风格结论**（来自 `industry-cycle-position.json` / `new-stock-double.json` / 现有策略）：
现有 5 个过滤器全是"位置闸门"（够低、够平、余温散尽），缺三类东西——
**① 动能确认**（低位的"平"不能区分底和下跌中继）、**② 弹性闸门**（深回撤筛选同时放进死票和妖票）、**③ 行业维度**（你独立脚本里已经在做的行业出清统计）。

---

## PR#0（重构铺垫，无行为变化）

**report 标签泛化**：`Filter` 接口增加 `readonly label?: string`（中文短标签，如 `'均线企稳'`），
`report.ts` 的 `GATE_LABELS` 改为从 filter registry 读取，`gateLine()` 拆成 per-filter 的
`evidenceLine(filter, metrics, pass)` 注册表。现有 5 个 filter 补 label，输出不变（快照测试守护）。

**验收**：`pnpm vitest` 全绿 + 现有报告字节级不变。

---

## Phase 1 — 纯量价过滤器（零数据源改动，4 个新 filter + 1 个新策略）

全部只依赖 C1 的 close/volume/ret，直接进 `src/filters/`，`registerAllFilters` 各加一行。

### 1.1 `ma_stabilization` 均线企稳

**语义**：低位平台之上叠加"止跌转平转上翘"的最便宜右侧确认。

```ts
paramDocs: {
  maWindow:        { type:'number', default:20, min:5,  max:120, integer:true,
                     description:'MA window on the return index.' },
  slopeBars:       { type:'number', default:5,  min:2,  max:30,  integer:true,
                     description:'Bars over which the MA slope is measured.' },
  minMaSlope:      { type:'number', default:0,  min:-0.05, max:0.2,
                     description:'Min relative MA change over slopeBars (0 = stopped falling).' },
  requireCloseAbove: { type:'boolean', default:true,
                     description:'Latest close must sit at or above the MA.' },
}
evidence: { maSlope, closeVsMaPct }   // null 当 bars < maWindow + slopeBars
```

**实现**：`ma = smaAtIndex(idx, len, W)`，`maPrev = smaAtIndex(idx, len - slopeBars, W)`，
`slope = ma/maPrev - 1`；`closeVsMaPct = idx[last]/ma - 1`。全部在 idx 上算（C2 合规，防除权）。

**测试**：下跌中 MA 下拐（fail）｜横盘 MA 平（slope≈0, pass）｜上翘 + 站上（pass）｜序列不足（fail, evidence null）｜除权缺口不产生假上翘（用 idx 链验证）。

### 1.2 `platform_breakout` 平台放量突破（右侧版核心）

**语义**：先有 `baseWindowBars` 的平平台，随后某日放量收盘越过平台高点，且此后**从未跌回平台内**。与 `cooldown_pullback` 互为镜像（一个确认回踩、一个确认启动）。本 filter 自含"突破前平台"检验，因此右侧策略**不需要也不应该**再叠加 `flat_base`（后者量测的是"最新窗口"平度，突破后必然不平）。

```ts
paramDocs: {
  breakoutWindowBars: { type:'number', default:10,  min:1,  max:60,  integer:true,
                        description:'Bars back from the latest bar to search for the breakout day.' },
  baseWindowBars:     { type:'number', default:30,  min:10, max:250, integer:true,
                        description:'Flat-base window immediately BEFORE the breakout day.' },
  maxBaseRangeChange: { type:'number', default:0.08, min:0.005, max:0.5,
                        description:'Max abs net change of the return index over the base window.' },
  minBreakoutMargin:  { type:'number', default:0.02, min:0, max:0.3,
                        description:'Breakout close must clear the base high by this fraction.' },
  minBreakoutSurge:   { type:'number', default:2,   min:1.1, max:20,
                        description:'Breakout-day volume / mean(prior 5 bars) ≥ this.' },
  minBarsAfterBreakout:{ type:'number', default:1,  min:1, max:30, integer:true,
                        description:'Breakout day must be ≥ this many bars before the latest bar.' },
  maxBaseGiveback:    { type:'number', default:0,   min:0, max:0.1,
                        description:'Max fraction the index may dip below the base high after breakout (0 = never re-enter the base).' },
}
evidence: { breakoutDate, breakoutSurge, barsSinceBreakout, baseToClosePct }
```

**实现**（自新到旧扫描候选日 b，取最近合格者）：
1. `b ∈ [last - breakoutWindowBars, last - minBarsAfterBreakout]`，且 `b - baseWindowBars ≥ 0`；
2. 平台度：`|idx[b-1]/idx[b-baseWindowBars] - 1| ≤ maxBaseRangeChange`；
3. `baseMax = max(idx[b-baseWindowBars … b-1])`（**不含突破日**）；`idx[b] ≥ baseMax × (1+minBreakoutMargin)`；
4. `vol[b]/meanVolume(bars, b-5, b) ≥ minBreakoutSurge`；
5. 保持：`∀e∈[b, last]: idx[e] ≥ baseMax × (1 - maxBaseGiveback)`。

**测试**：教科书平台突破（pass，evidence 引用最近合格日）｜突破后跌回平台（fail）｜放量不足（fail）｜平台前有趋势突变（fail）｜多个候选日取最近｜紧贴最新 bar 的突破（minBarsAfterBreakout 边界）。

### 1.3 `volatility_regime` 波动率区间（弹性闸门）

**语义**：双向限幅。下限滤"死票"（无人交易、无弹性），上限滤"妖票"（情绪末期）。匹配你次新研究里"高波动但买点极深"的偏好。

```ts
paramDocs: {
  volWindow:    { type:'number', default:60, min:20, max:250, integer:true,
                  description:'Bar window for realized volatility.' },
  minAnnualVol: { type:'number', default:0.15, min:0.01, max:3,
                  description:'Min annualized realized volatility.' },
  maxAnnualVol: { type:'number', default:0.80, min:0.05, max:5,
                  description:'Max annualized realized volatility.' },
}
evidence: { annualVol }   // σ(ret, volWindow) × √252，ret 取 bars[].ret（首 bar null 跳过）
```

**实现**：单遍收集窗口内 `ret`（null 跳过），算样本标准差。**不做**滚动分位（C10：避免 O(n·w)）；分位模式留作后续可选参数。

**测试**：死票 vol≈0.05（fail 下限）｜妖票 vol≈2.0（fail 上限）｜正常区间（pass）｜窗口内含 null ret 不炸。

### 1.4 `bars_since_low` 低点距今时长

**语义**：你 `new-stock-double.json` 里的经验——低点到启动往往隔数月到两年。区分"刚跌完的刀"和"磨透的底"。

```ts
paramDocs: {
  lowLookbackBars:  { type:'number', default:500, min:60,  max:3000, integer:true,
                      description:'Window in which to locate the minimum of the return index.' },
  minBarsSinceLow:  { type:'number', default:40,  min:1,  max:1000, integer:true,
                      description:'Latest bar must be ≥ this many bars after the window low.' },
  maxPctAboveLow:   { type:'number', default:0.5, min:0.01, max:5,
                      description:'Latest price may sit at most this fraction above the window low (still near the bottom).' },
}
evidence: { barsSinceLow, pctAboveLow }
```

**实现**：`lowIdx = argmin(idx[last-lookback … last])`（窗口按 `min(lowLookbackBars, len)` 截断，与 `low_percentile` 同约定）；`pctAboveLow = current/idx[lowIdx] - 1`。

**测试**：新低就在昨天（fail）｜磨底 60 日（pass）｜已从底反弹 80%（fail 上限）｜窗口短于参数时截断。

### 1.5 新策略 `low_flat_breakout`（右侧启动版，注册进 strategies/）

```ts
composeStrategy({
  id: 'low_flat_breakout',
  description: 'Historical low + flat base + volume breakout … (右侧确认版)',
  predicate: { kind:'and', children: [
    deep_drawdown, low_percentile,           // 位置闸门（沿用）
    platform_breakout,                        // 自含平台检验
    ma_stabilization,                         // 动能确认
  ]},
  extraParamDocs: { minBars: { default: 240, … } },
  canEvaluate: bars ≥ max(60, minBars, baseWindowBars + breakoutWindowBars + 1),
})
```

组合全景（Phase 3 落地后可自由拼装）：

```
左侧（现有）:  dd AND lp AND flat_base AND volume_limit_up AND cooldown_pullback
右侧（新增）:  dd AND lp AND platform_breakout AND ma_stabilization
弹性加压:      任一 AND volatility_regime AND bars_since_low
```

**Phase 1 验收**：4 filter × 各 5+ 用例全绿；全市场扫描（缓存热）回归 < 60s；默认参数下 `low_flat_limit_up` 输出与主干完全一致（金样对照 20260822 报告的 6 只）；README/README.zh 同步。

---

## Phase 2 — 数据轻扩展（行业周期 + 规模/流动性）

### 2.1 `industry_clearance` 行业出清（你 `industry-cycle-position.json` 的插件化）

**数据**：`fetchEastmoneyStockList` 的 clist 请求加 `f100`（行业板块名）→ `StockMeta.industry` 填充，三个源共享该列表函数，一处改动全部生效；`capabilities.industry: true`。

**架构**（这是本方案唯一的管道改动）：两遍扫描。
- Pass 1（新增，O(n) 单遍、无内存驻留）：对每只股票计算**参数无关**指标 —— `dd = 1 - last/max(idx)`（全窗口）、`pos = 窗口内分位`、`deep = dd ≥ 0.6`；按行业聚合出 `{ med_dd, med_pos, deep_pct, members }`，结构与你现有 JSON 完全同构，按日缓存为 `industry-cycle.json`。
- Pass 2（现有扫描）：`DerivedCtx` 增加可选字段 `industry?: IndustryStats`，由 screener 注入；无行业能力的源上，引用该 filter 的策略在**扫描开始时响亮报错**（遵守 C7 注释里的 no-silent-gap 原则）。

```ts
paramDocs: {
  minIndustryMedDrawdown: { default:0.40, min:0.1, max:0.9,
    description:'Median drawdown-from-high of the industry must be ≥ this.' },
  minIndustryDeepShare:   { default:0.25, min:0.05, max:1,
    description:'Share of the industry\'s members ≥60% below their window highs.' },
  minIndustryMembers:     { default:8, min:3, max:100, integer:true,
    description:'Industries with fewer members are not statistically meaningful.' },
}
evidence: { industry, industryMedDrawdown, industryDeepShare, industryMembers }
```

### 2.2 `market_cap_band` 市值区间

clist 加 `f20`（总市值，元）→ `StockMeta.totalMarketCapYuan?` + `capabilities.marketCap`。
参数 `minCapYi`(默认 20 亿) / `maxCapYi`(默认 5000 亿)。快照口径（列表时刻），足够做闸门用。
次新研究的天然搭档：小市值上限放开即可筛高弹性池。

### 2.3 `amount_liquidity` 成交额下限

**数据**：`Bar.amount?`（元）——eastmoney kline 的 `parts[6]` 本来就有（C6），解析保留；`BarTuple` 升 v2（8 列，`fromBarTuple` 对 7 列旧缓存容错，`undefined` 视为缺失）。sina/tencent 无 amount → `capabilities.amount: false`，引用该 filter 的策略在无能力源上启动即报错（不静默近似，遵守 C5）。

```ts
medianAmountYi: median(amount, last liquidityWindowBars=20) ≥ minMedianAmountYi (默认 0.3 亿)
```

**Phase 2 验收**：行业聚合输出与你手算 JSON 抽样对齐（≥3 个行业 med_dd 误差 < 0.02）；两遍扫描全市场 < 90s（缓存热）；缓存 v1→v2 迁移后老扫描无 diff。

---

## Phase 3 — 战略层（组合自由度 + 估值）

### 3.1 `a_share_screen` 支持临时组合（把引擎的声明式能力暴露给 agent）

`params` 之外新增可选 `predicate` 参数（受限 JSON-DSL）：
`{ all:[...], any:[...], not:'id' }` 嵌套深度 ≤ 3，叶节点为 filter id 或 `{id, params}`。
校验复用 `FilterRegistry.require`（未知 id 已有响亮报错）+ `resolveParams` 全套范围校验。
工具层拼 `evaluate()`，策略注册表不动。这是整个路线图**杠杆最大**的一步：`a_share_list_filters` 本来就是为此铺的路。

### 3.2 `turnover_band` 换手率区间（Phase 2 的免费副产品）

`turnover ≈ amount / 流通市值(f21)`，两个数据 Phase 2 都有了。低换手筛选"冷灶"，高换手上限防情绪票。

### 3.3 `valuation_band` 估值闸门（量级最大，接口先行）

clist `f9`(PE-TTM)/`f23`(PB) 为快照值；**横截面**分位（个股 PE 低于行业中位数 × 系数）可做，**时序**估值分位需要历史序列，建议单独立项（新 enrichment 源 + 按日缓存），不塞进本路线图。

---

## 实施顺序与里程碑

| PR | 内容 | 依赖 | 预估 |
|---|---|---|---|
| #0 | report 标签泛化（重构） | — | 0.5 天 |
| #1 | `ma_stabilization` + `bars_since_low` | #0 | 0.5 天 |
| #2 | `platform_breakout` + 策略 `low_flat_breakout` | #0 | 1 天 |
| #3 | `volatility_regime` | #0 | 0.5 天 |
| #4 | 行业数据（clist f100）+ 两遍扫描 + `industry_clearance` | — | 1.5 天 |
| #5 | f20/f21 + `market_cap_band`；kline amount + tuple v2 + `amount_liquidity` | #4 同批数据改动 | 1 天 |
| #6 | `predicate` DSL 暴露到 `a_share_screen` | #1–#3 | 1 天 |
| #7+ | turnover / valuation（按需） | #5/#6 | — |

每个 PR 统一动作：filter 实现 + 合成序列测试（沿用 `cooldown-pullback.test.ts` 的 fixture 风格）+ README(EN/ZH) + `pnpm vitest` 全绿 + 全市场性能回归。发布后 `pnpm update dsh-a-share-screener` 同步到 profile。

**总原则**：位置闸门（现有 5 个）不动，新增全部是正交维度；每一步默认行为零变化，能力靠组合表达。
