import { S as fetchJson, _ as barsToSeries, a as registerAll, b as RateLimiter, c as acquireBarsFile, d as filterByCodes, f as historyStartDate, g as createDataSource, h as createFilterRegistry, i as toPredicate, l as aggregateIndustries, m as syncBars, o as composeStrategy, p as prepareUniverse, s as StrategyRegistry, u as assertCapabilities, v as fromBarTuple, x as abortError, y as ymd } from "./tool-7TPU1vEy.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
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
  --top <n>                          近邻候选最多列 n 只 (默认 30)
  --out <dir>                        报告输出目录 (默认 reports/)
  --cache-dir <dir>                  缓存目录 (默认 ~/.dsh/a-share-screener)
  --refresh                          强制刷新股票清单与K线
  --concurrency <n>                  并发请求数 (默认 12)
  --history-bars <n>                 K线回看窗口 (默认 800)
  --min-list-days <n>                剔除上市不足 n 天 (默认 365)
  --max-list-days <n>                剔除上市超过 n 天 (默认 0 = 不限; 如 1460 ≈ 4年)`);
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
async function cmdScan(values) {
	const config = configFrom(values);
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
			console.error(`未知命令 '${command}'. 可用: sync, scan, strategies, filters, sources, help`);
			process.exit(2);
	}
}
main().catch((err) => {
	console.error(`错误: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
//#endregion
export {};
