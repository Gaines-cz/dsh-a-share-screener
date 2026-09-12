import { S as fetchJson, _ as barsToSeries, a as registerAll, b as RateLimiter, c as acquireBarsFile, d as filterByCodes, f as historyStartDate, g as createDataSource, h as createFilterRegistry, i as toPredicate, l as aggregateIndustries, m as syncBars, o as composeStrategy, p as prepareUniverse, s as StrategyRegistry, u as assertCapabilities, v as fromBarTuple, x as abortError, y as ymd } from "./tool-7TPU1vEy.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
//#region src/backtest.ts
const BACKTEST_DISCLAIMER = "Backtest-lite evaluates a strategy at historical as-of dates using only past bars (no look-ahead). The universe is TODAY'S listing (survivorship bias inflates results); ST/listing-age metadata are current snapshots; the same stock hitting at adjacent dates yields correlated observations. Use for relative comparison of thresholds/strategies, NOT as return forecasts or investment advice.";
/** Month length, 1-based month, proleptic Gregorian. */
function daysInMonth(year, month) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
/** Whether a string is a real YYYYMMDD calendar date. */
function isValidYmd(s) {
	if (!/^\d{8}$/.test(s)) return false;
	const year = Number(s.slice(0, 4));
	const month = Number(s.slice(4, 6));
	const day = Number(s.slice(6, 8));
	if (month < 1 || month > 12) return false;
	return day >= 1 && day <= daysInMonth(year, month);
}
/**
* Monthly as-of dates ending at `anchorYmd` (inclusive), ASCENDING:
* [anchor-(months-1), …, anchor-1m, anchor]. Day-of-month clamps to the target
* month's length (e.g. anchor 20260331 steps over 20260228).
*/
function monthlySteps(anchorYmd, months) {
	if (!isValidYmd(anchorYmd)) throw new Error(`invalid as-of date '${anchorYmd}' (expected YYYYMMDD)`);
	if (!Number.isInteger(months) || months < 1 || months > 60) throw new Error(`months must be an integer in [1, 60], got ${months}`);
	const y = Number(anchorYmd.slice(0, 4));
	const m = Number(anchorYmd.slice(4, 6));
	const d = Number(anchorYmd.slice(6, 8));
	const out = [];
	for (let k = months - 1; k >= 0; k--) {
		let mm = m - k;
		let yy = y;
		while (mm <= 0) {
			mm += 12;
			yy--;
		}
		const day = Math.min(d, daysInMonth(yy, mm));
		out.push(`${yy}${String(mm).padStart(2, "0")}${String(day).padStart(2, "0")}`);
	}
	return out;
}
/** Parse a comma-separated horizon list ("5,20,60") into unique ascending bar counts. */
function parseHorizons(raw) {
	const text = raw === void 0 || raw.trim() === "" ? "5,20,60" : raw;
	const seen = /* @__PURE__ */ new Set();
	for (const part of text.split(",")) {
		const n = Number(part.trim());
		if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error(`invalid horizon '${part}' (expected integer in [1, 500])`);
		seen.add(n);
	}
	return [...seen].sort((a, b) => a - b);
}
/** UTC epoch of a YYYYMMDD string. */
function ymdToUtc(s) {
	return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}
/**
* Widen the lookback window so the OLDEST as-of date still sits on the full
* requested bar history beneath it. Without this, a 12-month backtest on the
* default 800-bar window would evaluate old dates over a silently clamped
* percentile/flat window (~557 bars) — exactly the silent degradation this
* project refuses to commit. Conversion mirrors historyStartDate's 1.5x
* calendar→trading factor plus a small buffer; the first widened run
* backfills the cache (same cost as the initial sync).
*/
function historyBarsForBacktest(requestedBars, oldestAsOf, todayYmdStr) {
	const daysBack = Math.max(0, Math.ceil((ymdToUtc(todayYmdStr) - ymdToUtc(oldestAsOf)) / 864e5));
	return requestedBars + Math.ceil(daysBack / 1.5) + 10;
}
/** Index of the last bar with date ≤ asOf; -1 when the stock had not listed yet. */
function asOfIndex(bars, asOf) {
	let i = -1;
	for (let k = 0; k < bars.length; k++) if (bars[k].date <= asOf) i = k;
	else break;
	return i;
}
/**
* Chained return index over the full series, with the same strictly-positive
* clamp as {@link derive} (a corrupt ret ≤ -1 must not poison downstream
* ratios). Prefix values are identical to an index computed over a prefix
* slice — this is what makes as-of evaluation leak-free.
*/
function chainedIndex(bars) {
	if (bars.length === 0) return [];
	const idx = new Array(bars.length);
	idx[0] = 1;
	for (let i = 1; i < bars.length; i++) {
		const ret = bars[i].ret;
		idx[i] = idx[i - 1] * Math.max(1e-9, 1 + (ret === null ? 0 : ret));
	}
	return idx;
}
/** Forward return over `horizon` bars after the as-of bar; null when not measurable. */
function forwardReturn(idx, asOfIdx, horizon) {
	const end = asOfIdx + horizon;
	if (asOfIdx < 0 || end >= idx.length) return null;
	const base = idx[asOfIdx];
	return base > 0 ? idx[end] / base - 1 : null;
}
/** Linear-interpolation quantile over an already-ASCENDING array; null when empty. */
function quantile(sortedAsc, q) {
	if (sortedAsc.length === 0) return null;
	const pos = (sortedAsc.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sortedAsc[lo];
	return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
/** Median via sort + quantile(0.5); the input is NOT mutated. */
function medianOf(values) {
	if (values.length === 0) return null;
	return quantile([...values].sort((a, b) => a - b), .5);
}
/**
* Refuse strategies whose gates depend on today-computed inputs: industry
* aggregation is built from current bars, and market-cap/turnover filters use
* the current float snapshot. Evaluating them "as of" a past date would inject
* future data into a gate — a silent degradation this module never commits.
*/
function assertBacktestable(strategy) {
	const req = strategy.requires;
	if (!req) return;
	const anachronistic = [];
	if (req.industry) anachronistic.push("industry aggregation");
	if (req.marketCap) anachronistic.push("market-cap snapshot");
	if (anachronistic.length > 0) throw new Error(`strategy '${strategy.id}' needs ${anachronistic.join(", ")} — inputs computed from TODAY's data, which would leak into historical as-of gates. Backtest-lite supports price/volume strategies only.`);
}
function horizonStat(horizon, hitReturns, hitBeats, baselineValues) {
	const sorted = [...hitReturns].sort((a, b) => a - b);
	const hitMedian = quantile(sorted, .5);
	const baselineMedian = medianOf(baselineValues);
	return {
		horizon,
		observations: hitReturns.length,
		hitMedian,
		hitP25: quantile(sorted, .25),
		hitP75: quantile(sorted, .75),
		baselineMedian,
		excessMedian: hitMedian !== null && baselineMedian !== null ? hitMedian - baselineMedian : null,
		beatShare: hitBeats.length > 0 ? hitBeats.filter(Boolean).length / hitBeats.length : null
	};
}
/**
* Run the as-of evaluation loop. Serial by design: backtests assume a warm
* cache (`pnpm sync` first) and stay trivially reproducible; the CLI mirrors
* the scan commands' systemic-failure guard on top of the skipped counts.
*/
async function runBacktest(args) {
	const { strategy, params, stocks, asOfDates, horizons, acquireBars } = args;
	const log = args.log ?? (() => void 0);
	assertBacktestable(strategy);
	if (asOfDates.length === 0) throw new Error("asOfDates must not be empty");
	if (horizons.length === 0) throw new Error("horizons must not be empty");
	for (let i = 1; i < asOfDates.length; i++) if (asOfDates[i] <= asOfDates[i - 1]) throw new Error(`asOfDates must be strictly ascending: ${asOfDates.join(", ")}`);
	const floor = Math.max(60, Number(params.minBars ?? 240));
	const hits = new Map(asOfDates.map((d) => [d, []]));
	const baseline = new Map(asOfDates.map((d) => [d, new Map(horizons.map((h) => [h, []]))]));
	const evaluable = new Map(asOfDates.map((d) => [d, 0]));
	const marketBarDate = new Map(asOfDates.map((d) => [d, ""]));
	const skipped = {};
	let stocksEvaluated = 0;
	let lastBarDate = null;
	let done = 0;
	for (const stock of stocks) {
		const bars = await acquireBars(stock);
		if (bars === null) {
			skipped["kline-fetch-failed"] = (skipped["kline-fetch-failed"] ?? 0) + 1;
			continue;
		}
		stocksEvaluated++;
		done++;
		if (done % 200 === 0) log(`backtest progress: ${done}/${stocks.length}`);
		if (bars.length === 0) continue;
		const tail = bars[bars.length - 1].date;
		if (lastBarDate === null || tail > lastBarDate) lastBarDate = tail;
		const idx = chainedIndex(bars);
		for (const asOf of asOfDates) {
			const i = asOfIndex(bars, asOf);
			if (i < 0 || i + 1 < floor) continue;
			evaluable.set(asOf, evaluable.get(asOf) + 1);
			const barDate = bars[i].date;
			if (barDate > marketBarDate.get(asOf)) marketBarDate.set(asOf, barDate);
			const hit = strategy.screen({
				stock,
				bars: bars.slice(0, i + 1)
			}, params);
			let bhit;
			if (hit) bhit = {
				code: hit.code,
				fullCode: hit.fullCode,
				name: hit.name,
				board: hit.board,
				strategy: hit.strategy,
				asOf,
				asOfBarDate: barDate,
				close: bars[i].close,
				forward: {},
				evidence: hit.evidence
			};
			for (const horizon of horizons) {
				const fr = forwardReturn(idx, i, horizon);
				if (fr !== null) baseline.get(asOf).get(horizon).push(fr);
				if (bhit) bhit.forward[String(horizon)] = fr;
			}
			if (bhit) hits.get(asOf).push(bhit);
		}
	}
	const statFor = (asOf, horizon, dateHits) => {
		const baseMedian = medianOf(baseline.get(asOf).get(horizon));
		const hitReturns = [];
		const hitBeats = [];
		for (const hit of dateHits) {
			const fr = hit.forward[String(horizon)];
			if (fr === null || fr === void 0) continue;
			hitReturns.push(fr);
			if (baseMedian !== null) hitBeats.push(fr > baseMedian);
		}
		return horizonStat(horizon, hitReturns, hitBeats, baseline.get(asOf).get(horizon));
	};
	const asOfResults = asOfDates.map((asOf) => {
		const dateHits = hits.get(asOf);
		return {
			asOf,
			asOfBarDate: marketBarDate.get(asOf) || null,
			evaluable: evaluable.get(asOf),
			hits: dateHits,
			horizons: horizons.map((horizon) => statFor(asOf, horizon, dateHits))
		};
	});
	const pooled = horizons.map((horizon) => {
		const hitReturns = [];
		const hitBeats = [];
		const baselineMedians = [];
		for (const result of asOfResults) {
			const baseMedian = medianOf(baseline.get(result.asOf).get(horizon));
			if (baseMedian !== null) baselineMedians.push(baseMedian);
			for (const hit of result.hits) {
				const fr = hit.forward[String(horizon)];
				if (fr === null || fr === void 0) continue;
				hitReturns.push(fr);
				if (baseMedian !== null) hitBeats.push(fr > baseMedian);
			}
		}
		return horizonStat(horizon, hitReturns, hitBeats, baselineMedians);
	});
	const notes = [`${asOfResults.reduce((sum, r) => sum + r.hits.length, 0)} (date × stock) hit observations over ${asOfDates.length} as-of dates — the same stock hitting at adjacent dates yields correlated observations, not independent samples`, `baseline = median forward return of evaluable stocks (≥ ${floor} bars) at each date; excess = hit median − baseline median`];
	return {
		strategy: strategy.id,
		strategyDescription: strategy.description,
		params,
		source: args.source ?? "",
		scope: args.scope ?? "",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		lastBarDate,
		asOfDates,
		horizons,
		asOfResults,
		pooled,
		stocksEvaluated,
		skipped,
		notes,
		disclaimer: BACKTEST_DISCLAIMER
	};
}
function spct(v) {
	if (v === null || v === void 0 || !Number.isFinite(v)) return "-";
	return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}
function num(v, digits = 0) {
	return v === null || v === void 0 || !Number.isFinite(v) ? "-" : v.toFixed(digits);
}
/** Human-readable markdown report (mirrors report.ts conventions). */
function renderBacktestMarkdown(result, maxDetailRows = 200) {
	const lines = [];
	lines.push(`# 回测报告 (lite) — ${result.strategy}`);
	lines.push("");
	lines.push(`- 生成: ${result.generatedAt} · 数据源: ${result.source} · 范围: ${result.scope}`);
	lines.push(`- 数据截至: ${result.lastBarDate ?? "未知"} · 股票 ${result.stocksEvaluated} 只 · 时点 ${result.asOfDates.length} 个 (每月一步) · 前瞻窗口 ${result.horizons.join("/")} 交易日`);
	const paramText = Object.entries(result.params).map(([k, v]) => `${k}=${String(v)}`).join(", ");
	lines.push(`- 参数: ${paramText}`);
	lines.push("");
	lines.push("## 〇、方法与偏差声明 (先读这个)");
	lines.push("");
	lines.push("- 每个历史时点只用该时点之前的K线评估策略, 前瞻收益在链式收益率指数上度量; 需要行业聚合或市值快照的策略已被拒绝回测 (避免未来数据泄入门内)。");
	lines.push("- ⚠️ 幸存者偏差: 股票池为当前上市名单, 已退市股票缺失 → 结果系统性偏乐观。");
	lines.push("- ⚠️ ST / 上市天数等元数据为当前快照, 非历史值。");
	lines.push("- 同一股票相邻时点重复命中会产生相关观测, 汇总样本非独立。");
	lines.push("- 定位: 用于**相对比较** (阈值A vs 阈值B、策略 vs 策略), 不构成收益预测或投资建议。");
	lines.push("");
	lines.push("## 一、按时间点 × 前瞻窗口");
	lines.push("");
	lines.push("| 时点 | 实际数据日 | 可评估 | 命中 | 窗口 | 命中中位 | 基准中位 | 超额中位 | 跑赢基准 |");
	lines.push("|---|---|---|---|---|---|---|---|---|");
	for (const r of result.asOfResults) for (let h = 0; h < r.horizons.length; h++) {
		const stat = r.horizons[h];
		const lead = h === 0 ? `| ${r.asOf} | ${r.asOfBarDate ?? "-"} | ${r.evaluable} | ${r.hits.length}` : "|  |  |  |  ";
		lines.push(`${lead} | ${stat.horizon}日 | ${spct(stat.hitMedian)} | ${spct(stat.baselineMedian)} | ${spct(stat.excessMedian)} | ${stat.beatShare === null ? "-" : `${(stat.beatShare * 100).toFixed(0)}%`} |`);
	}
	lines.push("");
	lines.push("## 二、汇总 (全部时点合并)");
	lines.push("");
	lines.push("| 窗口 | 观测数 | 命中中位 | P25–P75 | 基准中位(各日中位的中位) | 超额中位 | 跑赢基准 |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const stat of result.pooled) lines.push(`| ${stat.horizon}日 | ${stat.observations} | ${spct(stat.hitMedian)} | ${spct(stat.hitP25)} ~ ${spct(stat.hitP75)} | ${spct(stat.baselineMedian)} | ${spct(stat.excessMedian)} | ${stat.beatShare === null ? "-" : `${(stat.beatShare * 100).toFixed(0)}%`} |`);
	lines.push("");
	const allHits = result.asOfResults.flatMap((r) => r.hits);
	const truncated = allHits.length > maxDetailRows;
	lines.push(`## 三、命中明细 (${allHits.length} 行${truncated ? `, 仅列前 ${maxDetailRows} 行` : ""})`);
	lines.push("");
	if (allHits.length === 0) lines.push("无。");
	else {
		lines.push(`| 时点 | 代码 | 名称 | 板块 | 时点收盘 | ${result.horizons.map((h) => `${h}日`).join(" | ")} |`);
		lines.push(`|---|---|---|---|---|${result.horizons.map(() => "---").join("|")}|`);
		for (const hit of allHits.slice(0, maxDetailRows)) {
			const forwards = result.horizons.map((h) => spct(hit.forward[String(h)] ?? null)).join(" | ");
			lines.push(`| ${hit.asOf} | ${hit.code} | ${hit.name} | ${hit.board} | ${num(hit.close, 2)} | ${forwards} |`);
		}
	}
	lines.push("");
	if (Object.keys(result.skipped).length > 0) {
		lines.push(`剔除: ${Object.entries(result.skipped).map(([k, v]) => `${k} ${v}`).join(", ")}`);
		lines.push("");
	}
	for (const note of result.notes) lines.push(`- ${note}`);
	lines.push("");
	lines.push("---");
	lines.push("⚠️ 回测 lite 仅供研究参考, 不构成投资建议。");
	return lines.join("\n");
}
//#endregion
//#region src/datasources/boards.ts
/**
* Eastmoney board (板块) resolution for the CLI's `--board` scope: find the
* board id by exact name across 行业 (t:2) and 概念 (t:3) board lists, then
* return its member codes. Free public endpoint (push2delay clist), the same
* data the free sources carry — no industry classification needed.
* @module a-share-screener/datasources/boards
*/
const BOARD_LIST_FS = {
	industry: "m:90+t:2",
	concept: "m:90+t:3"
};
const MAX_PAGES = 20;
async function listBoards(fs, limiter, signal) {
	const out = [];
	let page = 1;
	for (;;) {
		if (signal.aborted) throw new Error("aborted");
		const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(fs)}&fields=f12,f14`;
		const diff = (await fetchJson({
			url,
			limiter,
			signal,
			retries: 1
		})).data?.diff;
		const entries = Array.isArray(diff) ? diff : Object.values(diff ?? {});
		if (entries.length === 0) break;
		out.push(...entries);
		if (entries.length < 100 || page >= MAX_PAGES) break;
		page++;
	}
	return out;
}
async function listMembers(boardId, limiter, signal) {
	const codes = [];
	let page = 1;
	for (;;) {
		if (signal.aborted) throw new Error("aborted");
		const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(`b:${boardId}`)}&fields=f12,f14`;
		const diff = (await fetchJson({
			url,
			limiter,
			signal,
			retries: 1
		})).data?.diff;
		const entries = Array.isArray(diff) ? diff : Object.values(diff ?? {});
		if (entries.length === 0) break;
		for (const entry of entries) {
			const code = String(entry.f12 ?? "");
			if (/^\d{6}$/.test(code)) codes.push(code);
		}
		if (entries.length < 100 || page >= MAX_PAGES) break;
		page++;
	}
	return codes;
}
/** Exact-name board lookup across industry and concept lists. */
async function findBoard(name, limiter, signal) {
	const wanted = name.trim();
	const hits = [];
	for (const [kind, fs] of Object.entries(BOARD_LIST_FS)) {
		const boards = await listBoards(fs, limiter, signal);
		for (const board of boards) if ((board.f14 ?? "").trim() === wanted) hits.push({
			id: board.f12 ?? "",
			name: board.f14 ?? "",
			kind
		});
	}
	return hits.length > 0 ? hits : null;
}
/** Member 6-digit codes of one board (union across matched boards by caller). */
async function boardMemberCodes(boardId, limiter, signal) {
	return listMembers(boardId, limiter, signal);
}
/** Fuzzy suggestions when an exact board name has no match (for error hints). */
async function suggestBoards(keyword, limiter, signal) {
	const out = /* @__PURE__ */ new Set();
	for (const fs of Object.values(BOARD_LIST_FS)) {
		const boards = await listBoards(fs, limiter, signal);
		for (const board of boards) {
			const name = board.f14 ?? "";
			if (name.includes(keyword.trim())) {
				out.add(name);
				if (out.size >= 10) return [...out];
			}
		}
	}
	return [...out];
}
//#endregion
//#region src/report.ts
/** Split evaluated entries into tiers; near-misses sorted by drawdown depth. */
function tierResults(entries) {
	const hits = [];
	const nearMisses = [];
	let others = 0;
	for (const entry of entries) if (entry.diagnosis.matched) hits.push(entry);
	else if (entry.diagnosis.failedGates.length === 1) nearMisses.push(entry);
	else others++;
	hits.sort((a, b) => a.stock.code.localeCompare(b.stock.code));
	nearMisses.sort((a, b) => {
		const da = Number(a.diagnosis.metrics.drawdownFromHigh ?? 0);
		return Number(b.diagnosis.metrics.drawdownFromHigh ?? 0) - da;
	});
	return {
		hits,
		nearMisses,
		others
	};
}
/** Human-readable names for the atomic-filter gates. */
const GATE_LABELS = {
	deep_drawdown: "距高点回撤",
	low_percentile: "历史分位",
	bars_since_low: "距低点时长",
	flat_base: "平台走平+均线收敛",
	platform_breakout: "平台放量突破",
	ma_stabilization: "均线企稳",
	volatility_regime: "波动率区间",
	volume_limit_up: "放量涨停",
	cooldown_pullback: "涨停后回落缩量",
	volume_dry_up: "地量",
	industry_clearance: "行业出清",
	industry_position: "行业位置",
	market_cap_band: "市值区间",
	amount_liquidity: "成交额下限",
	turnover_band: "换手率区间"
};
function gateLabel(gate) {
	return GATE_LABELS[gate] ?? gate;
}
function fmt(v, digits = 2) {
	if (typeof v === "number") return v.toFixed(digits);
	return String(v ?? "-");
}
function pct(v) {
	return v === null || v === void 0 ? "-" : `${(Number(v) * 100).toFixed(1)}%`;
}
function drawdownPct(v) {
	return v === null || v === void 0 ? "-" : `-${(Number(v) * 100).toFixed(1)}%`;
}
/**
* Compact gate cells (short label + value formatter) in canonical render
* order. `gateLine` renders only the gates a strategy's diagnosis actually
* contains, so composed strategies with fewer filters show no phantom ✗.
*/
const GATE_CELLS = {
	deep_drawdown: {
		label: "距高点",
		value: (m) => drawdownPct(m.drawdownFromHigh)
	},
	low_percentile: {
		label: "分位",
		value: (m) => pct(m.percentileInWindow)
	},
	bars_since_low: {
		label: "距低点",
		value: (m) => m.barsSinceLow == null ? "-" : `${fmt(m.barsSinceLow, 0)}日/${pct(m.pctAboveLow)}`
	},
	flat_base: {
		label: "平台净变动",
		value: (m) => pct(m.flatNetChange)
	},
	platform_breakout: {
		label: "突破",
		value: (m) => m.breakoutDate === null || m.breakoutDate === void 0 ? "-" : `${m.breakoutDate}(${fmt(m.breakoutSurge, 1)}x/${fmt(m.barsSinceBreakout, 0)}日)`
	},
	ma_stabilization: {
		label: "MA斜率",
		value: (m) => m.maSlope == null ? "-" : `${pct(m.maSlope)}·离MA${pct(m.closeVsMaPct)}`
	},
	volatility_regime: {
		label: "年化波动",
		value: (m) => pct(m.annualVol)
	},
	volume_limit_up: {
		label: "放量涨停",
		value: (m) => m.limitUpDate === null || m.limitUpDate === void 0 ? "-" : `${m.limitUpDate}(${fmt(m.limitUpVolumeSurge, 1)}x)`
	},
	volume_dry_up: {
		label: "地量",
		value: (m) => m.dryUpVolumeRatio == null ? "-" : `${pct(m.dryUpVolumeRatio)}`
	},
	industry_position: {
		label: "行业位置",
		value: (m) => m.industryMedPos == null ? "-" : `${String(m.industry ?? "?")}·中位分位${pct(m.industryMedPos)}/${fmt(m.industryMembers, 0)}家`
	},
	industry_clearance: {
		label: "行业出清",
		value: (m) => m.industryMedDrawdown == null ? "-" : `${String(m.industry ?? "?")}·中位回撤${pct(m.industryMedDrawdown)}/深跌${pct(m.industryDeepShare)}/${fmt(m.industryMembers, 0)}家`
	},
	market_cap_band: {
		label: "市值",
		value: (m) => m.marketCapYi == null ? "-" : `${fmt(m.marketCapYi, 0)}亿`
	},
	amount_liquidity: {
		label: "日成交额中位",
		value: (m) => m.medianAmountYi == null ? "-" : `${fmt(m.medianAmountYi, 2)}亿`
	},
	turnover_band: {
		label: "中位换手",
		value: (m) => m.medianTurnoverPct == null ? "-" : `${fmt(m.medianTurnoverPct, 2)}%`
	},
	cooldown_pullback: {
		label: "回落缩量",
		value: (m) => {
			const ref = m.cooldownRefDate === null || m.cooldownRefDate === void 0 ? null : String(m.cooldownRefDate);
			const suffix = ref !== null && ref !== String(m.limitUpDate ?? "") ? `@${ref}` : "";
			return `${pct(m.cooldownVolumeRatio)}${suffix}`;
		}
	}
};
/** Compact per-stock gate summary, e.g. "距高点-52.3%✓ 分位29.9%✗ …". */
function gateLine(entry) {
	const m = entry.diagnosis.metrics;
	const gates = entry.diagnosis.gates;
	const parts = [];
	const push = (gate) => {
		const cell = GATE_CELLS[gate];
		const label = cell?.label ?? gateLabel(gate);
		const value = cell === void 0 ? "" : cell.value(m);
		parts.push(`${label}${value}${gates[gate] === true ? "✓" : "✗"}`);
	};
	const present = Object.keys(gates);
	for (const gate of Object.keys(GATE_CELLS)) if (present.includes(gate)) push(gate);
	for (const gate of present) if (!(gate in GATE_CELLS)) push(gate);
	return parts.join(" ");
}
/** Render the human-readable markdown report. */
function renderMarkdown(ctx) {
	const lines = [];
	lines.push(`# 选股扫描报告 — ${ctx.strategy}`);
	lines.push("");
	lines.push(`- 生成: ${ctx.generatedAt} · 数据源: ${ctx.source} · 范围: ${ctx.scope}`);
	lines.push(`- 数据截至: ${ctx.lastBarDate ?? "未知"} · 评估 ${ctx.evaluated} 只`);
	lines.push(`- 严格命中 ${ctx.tiered.hits.length} / 近邻候选 ${ctx.tiered.nearMisses.length} / 其他(差≥2道闸) ${ctx.tiered.others}`);
	const paramText = Object.entries(ctx.params).map(([k, v]) => `${k}=${String(v)}`).join(", ");
	lines.push(`- 参数: ${paramText}`);
	lines.push("");
	lines.push(`## 一、严格命中 (${ctx.tiered.hits.length}只)`);
	lines.push("");
	if (ctx.tiered.hits.length === 0) lines.push("无。");
	else for (const entry of ctx.tiered.hits) {
		const m = entry.diagnosis.metrics;
		lines.push(`- **${entry.stock.code} ${entry.stock.name}** (${entry.stock.board}) 收盘${fmt(m.close)} ` + gateLine(entry));
	}
	lines.push("");
	lines.push(`## 二、近邻候选 (${ctx.tiered.nearMisses.length}只, 只差一道闸, 供人工甄别)`);
	lines.push("");
	if (ctx.tiered.nearMisses.length === 0) lines.push("无。");
	else for (const entry of ctx.tiered.nearMisses) {
		const m = entry.diagnosis.metrics;
		const fail = entry.diagnosis.failedGates.map((g) => gateLabel(g)).join("、");
		lines.push(`- **${entry.stock.code} ${entry.stock.name}** (${entry.stock.board}) 收盘${fmt(m.close)} ` + gateLine(entry) + ` → 差在: ${fail}`);
	}
	lines.push("");
	const skipped = Object.entries(ctx.skipped);
	if (skipped.length > 0) {
		lines.push(`## 三、剔除 (${skipped.map(([k, v]) => `${k} ${v}`).join(", ")})`);
		lines.push("");
	}
	lines.push("---");
	lines.push("⚠️ 技术形态扫描结果, 仅供研究参考, 不构成投资建议。");
	return lines.join("\n");
}
/** Machine-readable payload (hits + near-misses + summary). */
function renderJson(ctx) {
	const entryView = (entry) => ({
		code: entry.stock.code,
		fullCode: entry.stock.fullCode,
		name: entry.stock.name,
		board: entry.stock.board,
		gates: entry.diagnosis.gates,
		failedGates: entry.diagnosis.failedGates,
		metrics: entry.diagnosis.metrics
	});
	return {
		strategy: ctx.strategy,
		source: ctx.source,
		scope: ctx.scope,
		generatedAt: ctx.generatedAt,
		lastBarDate: ctx.lastBarDate,
		evaluated: ctx.evaluated,
		skipped: ctx.skipped,
		params: ctx.params,
		summary: {
			hits: ctx.tiered.hits.length,
			nearMisses: ctx.tiered.nearMisses.length,
			others: ctx.tiered.others
		},
		hits: ctx.tiered.hits.map(entryView),
		nearMisses: ctx.tiered.nearMisses.map(entryView)
	};
}
//#endregion
//#region src/cli.ts
/**
* Standalone CLI — run screening without the dsh harness.
*
*   pnpm sync         增量同步本地行情缓存 (每周一次; 全市场默认)
*   pnpm scan         按策略扫描, 生成分层报告 (严格命中 + 近邻候选)
*   pnpm backtest     回测 lite: 历史时点评估策略, 命中池 vs 同日基准的前瞻收益对比
*   pnpm strategies   列出可用策略与参数
*   pnpm filters      列出可用原子过滤器与参数
*   pnpm sources      列出可用数据源
*
* 手动触发、本地缓存、免费数据源 (新浪主 / 东财回退 / 腾讯备胎), 无需 token。
* @module a-share-screener/cli
*/
const SOURCE_NOTES = {
	sina: "新浪 前复权日线 (推荐: 免费、单请求1023根、最新价≈市价)",
	eastmoney: "东方财富 前复权日线 (免费回退源)",
	tencent: "腾讯 后复权日线 (备胎; 报告价会虚高)"
};
const DEFAULT_REQUESTS_PER_MINUTE = 200;
const DEFAULT_HISTORY_BARS = 800;
function host() {
	return { log(level, message) {
		const line = `[a-share-screener] ${message}`;
		if (level === "warn") console.warn(line);
		else console.log(line);
	} };
}
/** Parse a non-negative numeric CLI option; fail loudly on garbage input. */
function numOption(values, key, fallback) {
	const raw = values[key];
	if (raw === void 0) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) {
		console.error(`参数错误: --${key} 应为非负数字, 遇到: ${String(raw)}`);
		process.exit(2);
	}
	return n;
}
function configFrom(values) {
	return {
		cacheDir: values["cache-dir"] ?? null,
		requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE,
		historyBars: Number(values["history-bars"] ?? DEFAULT_HISTORY_BARS),
		excludeST: true,
		excludeBSE: true,
		minListDays: numOption(values, "min-list-days", 365),
		maxListDays: numOption(values, "max-list-days", 0),
		scanTimeoutMs: 72e5
	};
}
function parseCodes(raw) {
	if (raw === void 0 || raw.trim() === "") return void 0;
	return raw.split(",").map((code) => code.trim()).filter((code) => /^\d{6}$/.test(code));
}
/** Resolve the scan scope to a code list + a human label. */
async function resolveScope(values, limiter, signal) {
	const codes = parseCodes(values.codes);
	if (codes !== void 0 && codes.length > 0) return {
		codes,
		label: `自选 ${codes.length} 只`,
		slug: `codes-${codes.length}`
	};
	const board = values.board?.trim();
	if (board !== void 0 && board !== "") {
		const hits = await findBoard(board, limiter, signal);
		if (hits === null) {
			const suggestions = await suggestBoards(board, limiter, signal);
			const hint = suggestions.length > 0 ? ` 相近板块: ${suggestions.slice(0, 8).join("、")}` : "";
			throw new Error(`找不到板块「${board}」, 检查名称(如 核能核电 / 农林牧渔)。${hint}`);
		}
		const members = /* @__PURE__ */ new Set();
		for (const hit of hits) for (const code of await boardMemberCodes(hit.id, limiter, signal)) members.add(code);
		const label = `${board} (${hits.map((h) => `${h.kind}:${h.name}`).join(" + ")}, ${members.size}只)`;
		return {
			codes: [...members],
			label,
			slug: board
		};
	}
	return {
		codes: void 0,
		label: "全市场",
		slug: "full-market"
	};
}
function parseParams(raw) {
	if (raw === void 0 || raw.trim() === "") return void 0;
	const out = {};
	for (const pair of raw.split(",")) {
		const eq = pair.indexOf("=");
		if (eq === -1) throw new Error(`参数格式应为 k=v,k2=v2, 遇到: ${pair}`);
		const key = pair.slice(0, eq).trim();
		const value = Number(pair.slice(eq + 1).trim());
		if (key === "" || !Number.isFinite(value)) throw new Error(`参数格式错误: ${pair}`);
		out[key] = value;
	}
	return out;
}
function parseArgsSafe(args, options) {
	try {
		const { values, positionals } = parseArgs({
			args,
			options,
			allowPositionals: true,
			strict: true
		});
		return {
			values,
			positionals
		};
	} catch (err) {
		console.error(`参数错误: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(2);
	}
}
function commonOptions() {
	return {
		"cache-dir": {
			type: "string",
			short: "c"
		},
		source: {
			type: "string",
			default: "sina"
		},
		refresh: { type: "boolean" },
		concurrency: {
			type: "string",
			default: "12"
		},
		"history-bars": { type: "string" },
		"min-list-days": { type: "string" },
		"max-list-days": { type: "string" },
		codes: { type: "string" },
		board: {
			type: "string",
			short: "b"
		}
	};
}
function printHelp() {
	console.log(`A股选股扫描 CLI (免费数据源, 无需 token)

用法:
  pnpm sync [选项]                 增量同步本地行情缓存 (每周一次)
  pnpm scan [选项]                 按策略扫描并生成分层报告
  pnpm backtest [选项]             回测 lite: 历史时点评估策略, 前瞻收益 vs 同日基准
  pnpm strategies                  列出可用策略与参数
  pnpm filters                     列出可用原子过滤器与参数
  pnpm sources                     列出可用数据源
  pnpm cli help                    显示本帮助

选项:
  --source <sina|eastmoney|tencent>  数据源 (默认 sina)
  --codes 600519,000858              只扫指定代码
  --board <板块名>                   只扫东财板块成分 (如 核能核电 / 农林牧渔)
  --strategy <id>                    扫描策略 (默认 low_flat_limit_up)
  --params k=v,k2=v2                 覆盖策略参数
  --top <n>                          近邻候选最多列 n 只 (默认 30; 回测明细默认 200)
  --out <dir>                        报告输出目录 (默认 reports/)
  --cache-dir <dir>                  缓存目录 (默认 ~/.dsh/a-share-screener)
  --refresh                          强制刷新股票清单与K线
  --concurrency <n>                  并发请求数 (默认 12)
  --history-bars <n>                 K线回看窗口 (默认 800)
  --min-list-days <n>                剔除上市不足 n 天 (默认 365)
  --max-list-days <n>                剔除上市超过 n 天 (默认 0 = 不限; 如 1460 ≈ 4年)

回测选项 (backtest):
  --as-of <YYYYMMDD>                 锚点时点 (默认今天), 向前每月一步
  --months <n>                       时点数 (默认 12)
  --horizons <a,b,c>                 前瞻窗口交易日数 (默认 5,20,60)
  回测前先 pnpm sync; K线窗口会自动加宽保证最老时点下方历史完整 (首次触发回填);
  需要行业聚合或市值快照的策略会被拒绝 (避免未来数据泄漏)`);
}
async function cmdSync(values) {
	const config = configFrom(values);
	const source = values.source;
	if (!(source in SOURCE_NOTES)) {
		console.error(`未知数据源 '${source}'. 可用: ${Object.keys(SOURCE_NOTES).join(", ")}`);
		process.exit(2);
	}
	const limiter = new RateLimiter(config.requestsPerMinute);
	const dataSource = createDataSource(source, limiter);
	const signal = new AbortController().signal;
	const { codes, label } = await resolveScope(values, limiter, signal);
	const result = await syncBars(host(), config, dataSource, {
		refresh: values.refresh === true,
		codes,
		concurrency: Number(values.concurrency ?? 12),
		signal
	});
	console.log(`同步完成: ${label} · 数据源 ${dataSource.id} · 处理 ${result.scanned} 只 / 本次拉取 ${result.stocksFetched} 只`);
	const skipped = Object.entries(result.skipped);
	if (skipped.length > 0) console.log(`剔除: ${skipped.map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
/** Resolve the strategy (built-in id or ad-hoc --predicate) shared by scan and backtest. */
function resolveStrategyForRun(values) {
	let registry = new StrategyRegistry();
	registerAll(registry);
	const predicateRaw = values.predicate;
	const strategyId = predicateRaw !== void 0 ? "custom" : values.strategy ?? "low_flat_limit_up";
	if (predicateRaw !== void 0) {
		let predicateJson;
		try {
			predicateJson = JSON.parse(predicateRaw);
		} catch (err) {
			console.error(`--predicate 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(2);
		}
		const predicate = toPredicate(predicateJson, createFilterRegistry());
		const custom = composeStrategy({
			id: "custom",
			description: `Ad-hoc composition: ${predicateRaw}`,
			predicate,
			filters: createFilterRegistry(),
			extraParamDocs: { minBars: {
				type: "number",
				default: 240,
				min: 60,
				max: 3e3,
				integer: true,
				description: "Minimum bar count to evaluate a stock at all."
			} },
			canEvaluate: (input, params) => input.bars.length >= Math.max(60, params.minBars)
		});
		registry = new StrategyRegistry();
		registry.register(custom);
	}
	return {
		registry,
		strategyId
	};
}
async function cmdScan(values) {
	const config = configFrom(values);
	const { registry, strategyId } = resolveStrategyForRun(values);
	const strategy = registry.get(strategyId);
	if (strategy === void 0) {
		console.error(`未知策略 '${strategyId}'. 可用: ${registry.ids().join(", ")}`);
		process.exit(2);
	}
	const params = registry.resolveParams(strategyId, parseParams(values.params));
	const limiter = new RateLimiter(config.requestsPerMinute);
	const source = values.source;
	if (!(source in SOURCE_NOTES)) {
		console.error(`未知数据源 '${source}'. 可用: ${Object.keys(SOURCE_NOTES).join(", ")}`);
		process.exit(2);
	}
	const dataSource = createDataSource(source, limiter);
	assertCapabilities(strategy, dataSource);
	const { codes, label, slug } = await resolveScope(values, limiter, new AbortController().signal);
	const signal = new AbortController().signal;
	const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, signal, values.refresh === true, (m) => console.warn(m));
	const universe = filterByCodes(filtered, codes, skipped);
	console.log(`范围 ${label} · 评估前剔除: ${Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join(", ") || "无"}`);
	const startDate = historyStartDate(config.historyBars);
	const fetched = /* @__PURE__ */ new Set();
	const entries = [];
	let industryByStock;
	if (strategy.requires?.industry) {
		const stats = await aggregateIndustries({ log: (_level, message) => console.log(message) }, config, dataSource, filtered, startDate, today, signal, fetched);
		industryByStock = /* @__PURE__ */ new Map();
		for (const stock of filtered) {
			const stat = stock.industry === void 0 ? void 0 : stats.get(stock.industry);
			if (stat !== void 0) industryByStock.set(stock.code, stat);
		}
		console.log(`行业聚合完成: ${stats.size} 个板块`);
	}
	let unevaluated = 0;
	let lastBarDate = null;
	const concurrency = Math.max(1, Math.floor(Number(values.concurrency ?? 12)));
	const queue = [...universe];
	const work = async () => {
		for (;;) {
			const stock = queue.shift();
			if (stock === void 0) return;
			if (signal.aborted) throw abortError();
			try {
				const fileData = await acquireBarsFile(config, dataSource, stock, startDate, today, signal, fetched);
				const tail = fileData.bars[fileData.bars.length - 1]?.[0];
				if (tail !== void 0 && (lastBarDate === null || tail > lastBarDate)) lastBarDate = tail;
				const series = barsToSeries(fileData.bars.map(fromBarTuple));
				if (strategy.diagnose === void 0) {
					const hit = strategy.screen({
						stock,
						bars: series,
						industryStats: industryByStock?.get(stock.code)
					}, params);
					if (hit) entries.push({
						stock,
						diagnosis: {
							matched: true,
							gates: {},
							failedGates: [],
							metrics: hit.evidence
						}
					});
					continue;
				}
				const diag = strategy.diagnose({
					stock,
					bars: series,
					industryStats: industryByStock?.get(stock.code)
				}, params);
				if (diag === null) {
					unevaluated++;
					continue;
				}
				entries.push({
					stock,
					diagnosis: diag
				});
			} catch (err) {
				if (signal.aborted) throw abortError();
				skipped["kline-fetch-failed"] = (skipped["kline-fetch-failed"] ?? 0) + 1;
				console.warn(`K线获取失败 ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => work()));
	const failures = skipped["kline-fetch-failed"] ?? 0;
	if (failures > Math.max(10, Math.floor(universe.length * .1))) throw new Error(`K线获取失败 ${failures}/${universe.length} — 疑似数据源故障, 可换 --source 重试`);
	const tiered = tierResults(entries);
	const top = Math.max(1, Math.floor(Number(values.top ?? 30)));
	if (tiered.nearMisses.length > top) tiered.nearMisses.length = top;
	const ctx = {
		strategy: strategyId,
		strategyDescription: strategy.description,
		params,
		source: dataSource.id,
		scope: label,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		lastBarDate,
		evaluated: entries.length,
		skipped,
		tiered
	};
	const outDir = values.out ?? "reports";
	await mkdir(outDir, { recursive: true });
	const base = `${ymd(/* @__PURE__ */ new Date())}-${strategyId}-${slug}`;
	await writeFile(join(outDir, `${base}.md`), renderMarkdown(ctx), "utf8");
	await writeFile(join(outDir, `${base}.json`), JSON.stringify(renderJson(ctx), null, 2), "utf8");
	console.log(`扫描完成: ${label} · 数据源 ${dataSource.id} · 评估 ${entries.length} (未评估 ${unevaluated}) / 严格命中 ${tiered.hits.length} / 近邻候选 ${tiered.nearMisses.length} / 其他 ${tiered.others}`);
	console.log(`报告: ${join(outDir, `${base}.md`)} (+ .json)`);
}
async function cmdStrategies() {
	const registry = new StrategyRegistry();
	registerAll(registry);
	for (const strategy of registry.list()) {
		console.log(`\n# ${strategy.id}`);
		console.log(strategy.description);
		console.log(JSON.stringify(strategy.paramDocs, null, 2));
	}
}
async function cmdFilters() {
	const filters = createFilterRegistry();
	for (const filter of filters.list()) {
		console.log(`\n# ${filter.id}`);
		console.log(filter.description);
		console.log(JSON.stringify(filter.paramDocs, null, 2));
	}
}
async function cmdSources() {
	for (const [id, note] of Object.entries(SOURCE_NOTES)) console.log(`- ${id}: ${note}`);
}
async function cmdBacktest(values) {
	const config = configFrom(values);
	const { registry, strategyId } = resolveStrategyForRun(values);
	const strategy = registry.get(strategyId);
	if (strategy === void 0) {
		console.error(`未知策略 '${strategyId}'. 可用: ${registry.ids().join(", ")}`);
		process.exit(2);
	}
	const params = registry.resolveParams(strategyId, parseParams(values.params));
	const asOfDates = monthlySteps(values["as-of"] ?? ymd(/* @__PURE__ */ new Date()), Number(values.months ?? 12));
	const horizons = parseHorizons(values.horizons);
	const widenedBars = historyBarsForBacktest(config.historyBars, asOfDates[0], ymd(/* @__PURE__ */ new Date()));
	if (widenedBars > config.historyBars) {
		config.historyBars = widenedBars;
		console.log(`回测窗口加宽: K线回看 ${config.historyBars} 根 (最老时点 ${asOfDates[0]} 之下仍需完整历史; 首次运行会回填缓存)`);
	}
	const limiter = new RateLimiter(config.requestsPerMinute);
	const source = values.source;
	if (!(source in SOURCE_NOTES)) {
		console.error(`未知数据源 '${source}'. 可用: ${Object.keys(SOURCE_NOTES).join(", ")}`);
		process.exit(2);
	}
	const dataSource = createDataSource(source, limiter);
	assertCapabilities(strategy, dataSource);
	assertBacktestable(strategy);
	const { codes, label, slug } = await resolveScope(values, limiter, new AbortController().signal);
	const signal = new AbortController().signal;
	const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, signal, values.refresh === true, (m) => console.warn(m));
	const universe = filterByCodes(filtered, codes, skipped);
	console.log(`范围 ${label} · 时点 ${asOfDates.length} 个 (${asOfDates[0]} → ${asOfDates[asOfDates.length - 1]}) · 前瞻窗口 ${horizons.join("/")} 交易日`);
	const startDate = historyStartDate(config.historyBars);
	const fetched = /* @__PURE__ */ new Set();
	const acquireBars = async (stock) => {
		try {
			const fileData = await acquireBarsFile(config, dataSource, stock, startDate, today, signal, fetched);
			return barsToSeries(fileData.bars.map(fromBarTuple));
		} catch (err) {
			if (signal.aborted) throw abortError();
			console.warn(`K线获取失败 ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	};
	const result = await runBacktest({
		strategy,
		params,
		stocks: universe,
		asOfDates,
		horizons,
		acquireBars,
		log: (message) => console.log(`[a-share-screener] ${message}`),
		source: dataSource.id,
		scope: label
	});
	const failures = result.skipped["kline-fetch-failed"] ?? 0;
	if (failures > Math.max(10, Math.floor(universe.length * .1))) throw new Error(`K线获取失败 ${failures}/${universe.length} — 疑似数据源故障, 可换 --source 重试`);
	const outDir = values.out ?? "reports";
	await mkdir(outDir, { recursive: true });
	const base = `${ymd(/* @__PURE__ */ new Date())}-backtest-${strategyId}-${slug}`;
	const top = Math.max(1, Math.floor(Number(values.top ?? 200)));
	await writeFile(join(outDir, `${base}.md`), renderBacktestMarkdown(result, top), "utf8");
	await writeFile(join(outDir, `${base}.json`), JSON.stringify(result, null, 2), "utf8");
	console.log(`回测完成: ${label} · 数据源 ${dataSource.id} · 股票 ${result.stocksEvaluated} 只 · 命中观测 ${result.asOfResults.reduce((s, r) => s + r.hits.length, 0)}`);
	for (const stat of result.pooled) {
		const excess = stat.excessMedian === null ? "-" : `${stat.excessMedian >= 0 ? "+" : ""}${(stat.excessMedian * 100).toFixed(1)}%`;
		const beat = stat.beatShare === null ? "-" : `${(stat.beatShare * 100).toFixed(0)}%`;
		console.log(`  ${stat.horizon}日: 命中中位 ${stat.hitMedian === null ? "-" : (stat.hitMedian * 100).toFixed(1) + "%"} · 基准 ${stat.baselineMedian === null ? "-" : (stat.baselineMedian * 100).toFixed(1) + "%"} · 超额 ${excess} · 跑赢基准 ${beat}`);
	}
	console.log(`报告: ${join(outDir, `${base}.md`)} (+ .json)`);
}
async function main() {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case "sync": {
			const { values } = parseArgsSafe(args, commonOptions());
			await cmdSync(values);
			break;
		}
		case "scan": {
			const { values } = parseArgsSafe(args, {
				...commonOptions(),
				strategy: { type: "string" },
				predicate: { type: "string" },
				params: { type: "string" },
				top: { type: "string" },
				out: { type: "string" }
			});
			await cmdScan(values);
			break;
		}
		case "backtest": {
			const { values } = parseArgsSafe(args, {
				...commonOptions(),
				strategy: { type: "string" },
				predicate: { type: "string" },
				params: { type: "string" },
				top: { type: "string" },
				out: { type: "string" },
				"as-of": { type: "string" },
				months: { type: "string" },
				horizons: { type: "string" }
			});
			await cmdBacktest(values);
			break;
		}
		case "strategies":
			await cmdStrategies();
			break;
		case "filters":
			await cmdFilters();
			break;
		case "sources":
			await cmdSources();
			break;
		case "help":
		case void 0:
			printHelp();
			break;
		default:
			console.error(`未知命令 '${command}'. 可用: sync, scan, backtest, strategies, filters, sources, help`);
			process.exit(2);
	}
}
main().catch((err) => {
	console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
//#endregion
export {};
