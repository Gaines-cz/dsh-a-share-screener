import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
//#region src/http.ts
/**
* Rate-limited JSON fetching with signal-aware retries.
* @module a-share-screener/http
*/
/**
* Serial rate limiter: enforces a minimum interval between request starts.
* Requests queue in call order; an aborted acquire rejects immediately.
*/
var RateLimiter = class {
	requestsPerMinute;
	nextAt = 0;
	queue = Promise.resolve();
	constructor(requestsPerMinute) {
		this.requestsPerMinute = requestsPerMinute;
		if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) throw new Error(`requestsPerMinute must be a positive number, got ${requestsPerMinute}`);
	}
	/** Wait for this request's slot. Rejects when `signal` aborts while waiting. */
	acquire(signal) {
		const run = this.queue.then(() => this.wait(signal));
		this.queue = run.catch(() => void 0);
		return run;
	}
	async wait(signal) {
		const interval = 6e4 / Math.max(1, this.requestsPerMinute);
		const now = Date.now();
		this.nextAt = Math.max(this.nextAt, now);
		const delay = this.nextAt - now;
		this.nextAt += interval;
		if (delay > 0) await sleep(delay, signal);
	}
};
/** Sleep that rejects with an AbortError when `signal` fires first. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(abortError());
		const timer = setTimeout(done, ms);
		function done() {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}
		function onAbort() {
			clearTimeout(timer);
			reject(abortError());
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
/** Standard abort error. */
function abortError() {
	const err = /* @__PURE__ */ new Error("aborted");
	err.name = "AbortError";
	return err;
}
/**
* Fetch and parse JSON with rate limiting, timeout, and retry. HTTP 4xx other
* than 429 fail immediately; transient failures back off exponentially with
* jitter. Throws on abort with an AbortError.
*/
async function fetchJson(options) {
	const { url, init, limiter, signal } = options;
	const timeoutMs = options.timeoutMs ?? 2e4;
	const retries = options.retries ?? 3;
	let lastError;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (signal.aborted) throw abortError();
		await limiter.acquire(signal);
		const signals = [signal, AbortSignal.timeout(timeoutMs)];
		if (init?.signal) signals.push(init.signal);
		let permanent = false;
		try {
			const res = await fetch(url, {
				...init,
				signal: AbortSignal.any(signals)
			});
			if (res.ok) return await res.json();
			lastError = /* @__PURE__ */ new Error(`HTTP ${res.status} for ${url}`);
			permanent = !(res.status === 429 || res.status >= 500);
		} catch (err) {
			if (signal.aborted) throw abortError();
			lastError = err;
			permanent = false;
		}
		if (permanent || attempt >= retries) break;
		await sleep(Math.min(8e3, 500 * 2 ** attempt) + Math.random() * 250, signal);
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
//#endregion
//#region src/types.ts
/**
* Daily-return threshold for a close-at-limit-up day, by board. Exchange price
* rounding keeps achieved limit-up percentages within roughly ±0.2 points of
* the nominal 10/20/30%, so these thresholds catch every true limit-up close.
*/
const LIMIT_UP_THRESHOLD = {
	main: .098,
	chinext: .198,
	star: .198,
	bse: .298
};
/**
* Landing threshold for a close-at-limit-up day. Main-board risk-warning names
* trade under the ±5% band (limit-up ≈ +5%, ~+4.8% after exchange rounding), so
* they get their own threshold; every other board/name uses {@link LIMIT_UP_THRESHOLD}.
*/
function limitUpThreshold(board, name) {
	if (board === "main" && name.includes("ST")) return .048;
	return LIMIT_UP_THRESHOLD[board];
}
/** Serialize a bar to its cache tuple. */
function toBarTuple(bar) {
	return [
		bar.date,
		bar.open,
		bar.high,
		bar.low,
		bar.close,
		bar.volume,
		bar.preClose
	];
}
/** Parse a cache tuple back into a bar. */
function fromBarTuple(t) {
	return {
		date: t[0],
		open: t[1],
		high: t[2],
		low: t[3],
		close: t[4],
		volume: t[5],
		preClose: t[6]
	};
}
/**
* Convert source bars into the strategy series. The daily return prefers the
* published `preClose` (correct across ex-rights days); otherwise it falls
* back to chaining consecutive closes within the series.
*/
function barsToSeries(bars) {
	const out = [];
	for (let i = 0; i < bars.length; i++) {
		const bar = bars[i];
		let ret = null;
		if (bar.preClose !== null && bar.preClose > 0) ret = bar.close / bar.preClose - 1;
		else if (i > 0) {
			const prev = bars[i - 1];
			if (prev.close > 0) ret = bar.close / prev.close - 1;
		}
		out.push({
			date: bar.date,
			close: bar.close,
			volume: bar.volume,
			ret
		});
	}
	return out;
}
/** Classify a 6-digit A-share symbol into its board. Undefined for unknown patterns. */
function boardFromCode(code) {
	if (code.startsWith("68")) return "star";
	if (code.startsWith("6")) return "main";
	if (code.startsWith("00")) return "main";
	if (code.startsWith("30")) return "chinext";
	if (/^(4|8|92)/.test(code)) return "bse";
}
/** Exchange suffix (SH/SZ/BJ) for a 6-digit symbol. */
function exchangeSuffix(code) {
	if (code.startsWith("6")) return "SH";
	if (/^(4|8|92)/.test(code)) return "BJ";
	return "SZ";
}
/** Local YYYYMMDD of a Date. */
function ymd(date) {
	return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}
/** YYYYMMDD minus `days` calendar days. */
function dateMinusDays(ymdStr, days) {
	const year = Number(ymdStr.slice(0, 4));
	const month = Number(ymdStr.slice(4, 6));
	const day = Number(ymdStr.slice(6, 8));
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() - days);
	return ymd(date);
}
//#endregion
//#region src/datasources/eastmoney.ts
/**
* Eastmoney public-endpoint adapter (free, no token): the plugin's single data
* source. Uses the widely-used public quote endpoints — push2 clist for the
* stock list, push2his kline for daily bars. These endpoints are undocumented,
* so field drift is possible; failures surface loudly.
*
* Klines are fetched with `fqt=2` (back-adjusted): prices never go negative and
* consecutive-close ratios are true daily returns. Because back-adjustment
* anchors can drift over time, the incremental {@link refreshBars} re-verifies
* the cached overlap before appending.
* @module a-share-screener/datasources/eastmoney
*/
const KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
/**
* Realtime quote hosts occasionally reject datacenter/local-network clients at
* the TLS layer while the delayed-quote host keeps serving the same clist API
* (delayed snapshots are irrelevant for listing metadata), so list requests
* fail over between hosts. The first working host is remembered for the
* process lifetime.
*/
const LIST_HOSTS = ["push2.eastmoney.com", "push2delay.eastmoney.com"];
let workingListHost;
async function fetchListPage(page, pageSize, limiter, signal) {
	const hosts = workingListHost ? [workingListHost, ...LIST_HOSTS.filter((h) => h !== workingListHost)] : [...LIST_HOSTS];
	let lastError;
	for (const host of hosts) try {
		const json = await fetchJson({
			url: `https://${host}/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(FS_ALL)}&fields=f12,f13,f14,f26`,
			limiter,
			signal,
			retries: 1
		});
		workingListHost = host;
		return json;
	} catch (err) {
		if (signal.aborted) throw err;
		if (host === workingListHost) workingListHost = void 0;
		lastError = err;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
/** All A-share boards (BSE included; universe filtering happens later). */
const FS_ALL = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
/** Defensive page cap: the endpoint pages ~56 pages today; never loop unbounded. */
const MAX_LIST_PAGES = 300;
function normalizeDate(value) {
	return String(value ?? "").replace(/\D/g, "").slice(0, 8);
}
/** Merge two bar lists, deduplicating by date (incoming wins), ascending. */
function mergeBars(existing, incoming) {
	const byDate = /* @__PURE__ */ new Map();
	for (const bar of existing) byDate.set(bar.date, bar);
	for (const bar of incoming) byDate.set(bar.date, bar);
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
/**
* Build the Eastmoney data source, binding it to the shared rate limiter so
* callers never pass request-budget plumbing around.
*/
function createEastmoneyDataSource(limiter) {
	async function listStocks(signal) {
		const out = /* @__PURE__ */ new Map();
		const pageSize = 100;
		let page = 1;
		for (;;) {
			if (signal.aborted) throw new Error("aborted");
			const json = await fetchListPage(page, pageSize, limiter, signal);
			const diff = json.data?.diff;
			const entries = Array.isArray(diff) ? diff : Object.values(diff ?? {});
			if (entries.length === 0) break;
			for (const entry of entries) {
				const code = String(entry.f12 ?? "");
				const board = boardFromCode(code);
				if (!board || !/^\d{6}$/.test(code)) continue;
				out.set(code, {
					code,
					fullCode: `${code}.${exchangeSuffix(code)}`,
					name: String(entry.f14 ?? ""),
					board,
					listDate: normalizeDate(entry.f26)
				});
			}
			const total = json.data?.total;
			if (entries.length < pageSize) break;
			if (total !== void 0 && total > 0 && out.size >= total) break;
			if (page >= MAX_LIST_PAGES) break;
			page++;
		}
		return [...out.values()];
	}
	/**
	* Back-adjusted daily bars for one stock from `startDate` (YYYYMMDD) onward,
	* ascending. `preClose` is not published — the series pipeline chains
	* consecutive closes instead.
	*/
	async function dailyBars(fullCode, startDate, signal) {
		const [code, suffix] = fullCode.split(".");
		const secid = `${suffix === "SH" ? 1 : 0}.${code}`;
		const json = await fetchJson({
			url: `${KLINE_URL}?secid=${secid}&klt=101&fqt=2&beg=${startDate}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`,
			limiter,
			signal
		});
		const bars = [];
		for (const line of json.data?.klines ?? []) {
			const parts = line.split(",");
			if (parts.length < 6) continue;
			const date = parts[0].replace(/\D/g, "");
			const open = Number(parts[1]);
			const close = Number(parts[2]);
			const high = Number(parts[3]);
			const low = Number(parts[4]);
			const volume = Number(parts[5]);
			if (date.length !== 8 || ![
				open,
				close,
				high,
				low
			].every((v) => Number.isFinite(v) && v > 0)) continue;
			if (!Number.isFinite(volume)) continue;
			bars.push({
				date,
				open,
				high,
				low,
				close,
				volume,
				preClose: null
			});
		}
		return bars.sort((a, b) => a.date.localeCompare(b.date));
	}
	/**
	* Incremental refresh for a stale cache: fetch from 10 days before the cached
	* tail, verify the overlapping bars still match (back-adjustment drift
	* check), then append. Returns null when the file needs no change.
	*/
	async function refreshBars(fullCode, startDate, cached, signal) {
		const last = cached[cached.length - 1];
		if (!last) return null;
		const fresh = await dailyBars(fullCode, dateMinusDays(last.date, 10), signal);
		if (fresh.length === 0) return null;
		const cachedByDate = new Map(cached.map((bar) => [bar.date, bar]));
		let overlap = 0;
		for (const bar of fresh) {
			const prev = cachedByDate.get(bar.date);
			if (!prev) continue;
			overlap++;
			if (prev.close > 0 && Math.abs(bar.close / prev.close - 1) > .001) return dailyBars(fullCode, startDate, signal);
		}
		if (overlap === 0 && fresh[0] !== void 0 && fresh[0].date <= last.date) return dailyBars(fullCode, startDate, signal);
		return mergeBars(cached, fresh);
	}
	return {
		id: "eastmoney",
		capabilities: { industry: false },
		listStocks,
		dailyBars,
		refreshBars
	};
}
//#endregion
//#region src/datasources/index.ts
const FACTORIES = { eastmoney: createEastmoneyDataSource };
/** Build the data source for `id`, bound to the process-lifetime rate budget. */
function createDataSource(id, limiter) {
	return FACTORIES[id](limiter);
}
//#endregion
//#region src/strategies/low-flat-limitup.ts
/**
* Strategy `low_flat_limit_up`: historical low + flat base + volume-heavy
* limit-up within roughly six months followed by a pullback on shrinking
* volume.
*
* All price-level conditions run on a chained return index (not raw closes),
* so ex-rights events such as splits and dividends cannot fake a crash or a
* bottom. Each condition's threshold is a validated, overridable parameter.
* @module a-share-screener/strategies/low-flat-limitup
*/
function round(value, digits) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
/** Mean volume of bars[start, end). Returns 0 on an empty range. */
function meanVolume(bars, start, end) {
	let sum = 0;
	let count = 0;
	for (let i = Math.max(0, start); i < end && i < bars.length; i++) {
		sum += bars[i].volume;
		count++;
	}
	return count === 0 ? 0 : sum / count;
}
/** Simple moving average of the return index over the last `n` values ending at `endExclusive`. */
function smaAtIndex(idx, endExclusive, n) {
	if (endExclusive < n) return null;
	let sum = 0;
	for (let i = endExclusive - n; i < endExclusive; i++) sum += idx[i];
	return sum / n;
}
const lowFlatLimitUpStrategy = {
	id: "low_flat_limit_up",
	description: "Historical low + flat base + faded volume-heavy limit-up: the stock sits deep below its window high (default >= 65% drawdown) and at the bottom of its recent price distribution (default <= 15th percentile of the last ~3 years), the last month is a flat, MA-converged base, and within the last ~6 months there was a volume-heavy limit-up day (default >= 2x the prior 5-day average volume) that pulled back below its closing price while volume cooled off (recent average <= 40% of the limit-up day). Read the evidence fields as quantified facts, not trading signals.",
	paramDocs: {
		minDrawdownFromHigh: {
			type: "number",
			default: .65,
			min: .1,
			max: .99,
			description: "Minimum drawdown of the latest price from the window high (fraction)."
		},
		percentileWindowBars: {
			type: "number",
			default: 730,
			min: 120,
			max: 3e3,
			integer: true,
			description: "Bar count for the historical-low percentile window (~3 years)."
		},
		maxPercentile: {
			type: "number",
			default: .15,
			min: .01,
			max: 1,
			description: "Latest price must rank at or below this percentile of the window."
		},
		flatWindowBars: {
			type: "number",
			default: 30,
			min: 10,
			max: 250,
			integer: true,
			description: "Bar count for the flat-base window."
		},
		maxFlatRangeChange: {
			type: "number",
			default: .08,
			min: .005,
			max: .5,
			description: "Max absolute net change of the return index over the flat window."
		},
		maxFlatMaSpread: {
			type: "number",
			default: .03,
			min: .002,
			max: .3,
			description: "Max relative spread between MA5/MA10/MA20/MA60 of the return index at the latest bar."
		},
		limitUpWindowBars: {
			type: "number",
			default: 120,
			min: 20,
			max: 500,
			integer: true,
			description: "Bars back to search for the volume-heavy limit-up day (~6 months)."
		},
		minVolumeSurge: {
			type: "number",
			default: 2,
			min: 1.1,
			max: 20,
			description: "Limit-up day volume must be at least this multiple of the prior 5-bar average volume."
		},
		maxCooldownVolumeRatio: {
			type: "number",
			default: .4,
			min: .05,
			max: 1.5,
			description: "Recent average volume must be at most this fraction of the limit-up day volume."
		},
		cooldownBars: {
			type: "number",
			default: 5,
			min: 3,
			max: 30,
			integer: true,
			description: "Bar count for the recent (cooldown) volume average."
		},
		minBars: {
			type: "number",
			default: 240,
			min: 60,
			max: 3e3,
			integer: true,
			description: "Minimum bar count to evaluate a stock at all."
		}
	},
	screen(input, params) {
		const bars = input.bars;
		const minBars = params.minBars;
		if (bars.length < Math.max(60, minBars)) return null;
		const idx = new Array(bars.length);
		idx[0] = 1;
		for (let i = 1; i < bars.length; i++) {
			const ret = bars[i].ret;
			idx[i] = idx[i - 1] * (1 + (ret === null ? 0 : ret));
		}
		const last = bars.length - 1;
		const current = idx[last];
		let high = -Infinity;
		for (const value of idx) if (value > high) high = value;
		const drawdown = 1 - current / high;
		if (drawdown < params.minDrawdownFromHigh) return null;
		const pw = Math.min(params.percentileWindowBars, bars.length);
		let below = 0;
		for (let i = bars.length - pw; i < bars.length; i++) if (idx[i] <= current) below++;
		const percentile = below / pw;
		if (percentile > params.maxPercentile) return null;
		const fw = params.flatWindowBars;
		if (last < fw) return null;
		const netChange = Math.abs(current / idx[last - fw] - 1);
		if (netChange > params.maxFlatRangeChange) return null;
		const maLengths = [
			5,
			10,
			20,
			60
		];
		const mas = [];
		for (const n of maLengths) {
			const ma = smaAtIndex(idx, bars.length, n);
			if (ma === null) return null;
			mas.push(ma);
		}
		const maSpread = (Math.max(...mas) - Math.min(...mas)) / Math.min(...mas);
		if (maSpread > params.maxFlatMaSpread) return null;
		const threshold = limitUpThreshold(input.stock.board, input.stock.name);
		const cooldownBars = params.cooldownBars;
		const minGap = cooldownBars + 1;
		const firstCandidate = Math.max(5, last - params.limitUpWindowBars);
		for (let d = last - minGap; d >= firstCandidate; d--) {
			const ret = bars[d].ret;
			if (ret === null || ret < threshold) continue;
			const prevAvg = meanVolume(bars, d - 5, d);
			if (prevAvg <= 0 || bars[d].volume < params.minVolumeSurge * prevAvg) continue;
			let pulledBack = false;
			for (let e = d + 1; e <= last; e++) if (idx[e] < idx[d]) {
				pulledBack = true;
				break;
			}
			if (!pulledBack) continue;
			const cooldownAvg = meanVolume(bars, last - cooldownBars + 1, last + 1);
			if (cooldownAvg > params.maxCooldownVolumeRatio * bars[d].volume) continue;
			return {
				code: input.stock.code,
				fullCode: input.stock.fullCode,
				name: input.stock.name,
				board: input.stock.board,
				strategy: lowFlatLimitUpStrategy.id,
				evidence: {
					close: bars[last].close,
					drawdownFromHigh: round(drawdown, 4),
					percentileInWindow: round(percentile, 4),
					flatNetChange: round(netChange, 4),
					flatMaSpread: round(maSpread, 4),
					limitUpDate: bars[d].date,
					limitUpPct: round(ret, 4),
					limitUpVolumeSurge: round(bars[d].volume / prevAvg, 2),
					cooldownVolumeRatio: round(cooldownAvg / bars[d].volume, 4),
					daysSinceLimitUp: last - d,
					barsAnalyzed: bars.length
				}
			};
		}
		return null;
	}
};
//#endregion
//#region src/strategies/registry.ts
/** Registry with loud failure on duplicate ids, unknown strategies, and bad params. */
var StrategyRegistry = class {
	strategies = /* @__PURE__ */ new Map();
	register(strategy) {
		if (this.strategies.has(strategy.id)) throw new Error(`duplicate strategy id: ${strategy.id}`);
		this.strategies.set(strategy.id, strategy);
	}
	get(id) {
		return this.strategies.get(id);
	}
	ids() {
		return [...this.strategies.keys()];
	}
	list() {
		return [...this.strategies.values()];
	}
	/**
	* Merge defaults with caller overrides, validating types and ranges.
	* Throws with an actionable message listing valid keys on any bad input.
	*/
	resolveParams(id, raw) {
		const strategy = this.get(id);
		if (!strategy) throw new Error(`unknown strategy '${id}'. Available: ${this.ids().join(", ")}`);
		const out = {};
		for (const [key, doc] of Object.entries(strategy.paramDocs)) out[key] = doc.default;
		if (raw === void 0 || raw === null) return out;
		if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`params for strategy '${id}' must be an object`);
		for (const [key, value] of Object.entries(raw)) {
			const doc = strategy.paramDocs[key];
			if (!doc) throw new Error(`unknown param '${key}' for strategy '${id}'. Valid params: ${Object.keys(strategy.paramDocs).join(", ")}`);
			if (doc.type === "number") {
				if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`param '${key}' for strategy '${id}' must be a number`);
				if (doc.integer && !Number.isInteger(value)) throw new Error(`param '${key}' for strategy '${id}' must be an integer`);
				if (doc.min !== void 0 && value < doc.min) throw new Error(`param '${key}' for strategy '${id}' must be >= ${doc.min}`);
				if (doc.max !== void 0 && value > doc.max) throw new Error(`param '${key}' for strategy '${id}' must be <= ${doc.max}`);
				out[key] = value;
			} else if (doc.type === "boolean") {
				if (typeof value !== "boolean") throw new Error(`param '${key}' for strategy '${id}' must be a boolean`);
				out[key] = value;
			} else {
				if (typeof value !== "string") throw new Error(`param '${key}' for strategy '${id}' must be a string`);
				out[key] = value;
			}
		}
		return out;
	}
};
//#endregion
//#region src/cache.ts
/**
* Disk cache: atomic JSON persistence under a resolved cache directory.
* @module a-share-screener/cache
*/
/** The dsh home directory (profile root). */
function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** Default cache directory for this plugin. */
function defaultCacheDir() {
	return join(dshHome(), "a-share-screener");
}
/**
* Read and parse a JSON file. Missing or corrupt files resolve to undefined —
* the cache self-heals by refetching.
*/
async function readJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return;
	}
}
/** Write JSON atomically (tmp file + rename), creating parent directories. */
async function writeJson(file, value) {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	await writeFileSafe(tmp, JSON.stringify(value));
	await rename(tmp, file);
}
async function writeFileSafe(file, text) {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(file, text, "utf8");
}
//#endregion
//#region src/screener.ts
/**
* Scan orchestration: universe filtering, incremental bar-cache maintenance
* through the active {@link DataSource}, and per-stock strategy evaluation
* with bounded memory and cooperative cancellation.
* @module a-share-screener/screener
*/
const DISCLAIMER = "Technical screening of historical price/volume patterns. NOT investment advice; past patterns do not predict future returns. Verify fundamentals and do your own research before any decision.";
function todayYmd() {
	return ymd(/* @__PURE__ */ new Date());
}
/** Calendar start date that safely covers `historyBars` trading days. A-shares
* trade ~243 days/year (365/243 ≈ 1.5), so 1.5x plus a 45-day buffer is
* required to never come up short when the requested window is wide. */
function historyStartDate(historyBars) {
	return dateMinusDays(todayYmd(), Math.ceil(historyBars * 1.5) + 45);
}
/**
* The latest day on which the market could have printed bars: today when it is
* a weekday, otherwise the preceding Friday. Weekend scans must not trigger a
* pointless whole-market refresh against Friday data.
*/
function expectedLastTradingDay() {
	const now = /* @__PURE__ */ new Date();
	const day = now.getDay();
	if (day === 0) return dateMinusDays(ymd(now), 2);
	if (day === 6) return dateMinusDays(ymd(now), 1);
	return ymd(now);
}
/**
* Whether cached bars are worth refreshing. The tail must be older than the
* expected last trading day AND the file must not already have been (re)fetched
* today — the second clause turns repeated same-day scans into cache hits while
* still fetching today's post-close bar on the first scan of the day.
*/
function isStale(fileData) {
	if ((fileData.bars[fileData.bars.length - 1]?.[0] ?? "") >= expectedLastTradingDay()) return false;
	if ((fileData.fetchedAt ?? "") >= todayYmd()) return false;
	return true;
}
function isSt(name) {
	return name.includes("ST") || name.includes("退");
}
/** Run one full screening pass. Throws loud, actionable errors on bad input. */
async function runScreen(host, config, dataSource, registry, args) {
	const startedAt = Date.now();
	const strategy = registry.get(args.strategyId);
	if (!strategy) throw new Error(`unknown strategy '${args.strategyId}'. Available: ${registry.ids().join(", ")}`);
	const params = registry.resolveParams(args.strategyId, args.params);
	const cacheDir = config.cacheDir ?? defaultCacheDir();
	const signal = args.signal;
	const skipped = {};
	const skip = (reason) => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};
	const stocksFile = join(cacheDir, "stocks.json");
	const today = todayYmd();
	let stocksCache = await readJson(stocksFile);
	if (args.refresh || !stocksCache || (stocksCache.fetchedAt ?? "") < today) {
		stocksCache = {
			fetchedAt: today,
			stocks: await dataSource.listStocks(signal)
		};
		await writeJson(stocksFile, stocksCache);
	}
	const stocks = stocksCache.stocks;
	host.log("info", `universe: ${stocks.length} listed stocks from ${dataSource.id}`);
	const minListDate = dateMinusDays(today, config.minListDays);
	let universe = [];
	for (const stock of stocks) {
		if (config.excludeST && isSt(stock.name)) {
			skip("st-or-delisting");
			continue;
		}
		if (stock.board === "bse") {
			if (config.excludeBSE) {
				skip("bse");
				continue;
			}
		}
		if (stock.listDate === "" || stock.listDate >= minListDate) {
			skip("recent-or-unknown-listing");
			continue;
		}
		universe.push(stock);
	}
	host.log("info", `universe after filters: ${universe.length} (skipped ${JSON.stringify(skipped)})`);
	const startDate = historyStartDate(config.historyBars);
	const fetchedThisRun = /* @__PURE__ */ new Set();
	const acquireBars = async (stock) => {
		const file = join(cacheDir, dataSource.id, "bars", `${stock.fullCode}.json`);
		const fileData = await readJson(file);
		const backfill = fileData?.startDate !== void 0 && fileData.startDate > startDate;
		if (!fileData || backfill) {
			const bars = await dataSource.dailyBars(stock.fullCode, startDate, signal);
			const result = {
				code: stock.fullCode,
				fetchedAt: today,
				startDate,
				bars: bars.map(toBarTuple)
			};
			await writeJson(file, result);
			fetchedThisRun.add(stock.fullCode);
			return result;
		}
		if (fileData.bars.length === 0) {
			if (isStale(fileData)) {
				const bars = await dataSource.dailyBars(stock.fullCode, startDate, signal);
				const result = {
					code: stock.fullCode,
					fetchedAt: today,
					startDate,
					bars: bars.map(toBarTuple)
				};
				await writeJson(file, result);
				fetchedThisRun.add(stock.fullCode);
				return result;
			}
			return fileData;
		}
		if (isStale(fileData)) {
			if (dataSource.refreshBars) {
				const refreshed = await dataSource.refreshBars(stock.fullCode, startDate, fileData.bars.map(fromBarTuple), signal);
				if (refreshed !== null) {
					const result = {
						code: stock.fullCode,
						fetchedAt: today,
						startDate,
						bars: refreshed.map(toBarTuple)
					};
					await writeJson(file, result);
					fetchedThisRun.add(stock.fullCode);
					return result;
				}
			} else {
				const bars = await dataSource.dailyBars(stock.fullCode, startDate, signal);
				const result = {
					code: stock.fullCode,
					fetchedAt: today,
					startDate,
					bars: bars.map(toBarTuple)
				};
				await writeJson(file, result);
				fetchedThisRun.add(stock.fullCode);
				return result;
			}
		}
		return fileData;
	};
	const candidates = [];
	let scanned = 0;
	for (const stock of universe) {
		if (signal.aborted) throw abortError();
		let fileData;
		try {
			fileData = await acquireBars(stock);
		} catch (err) {
			if (signal.aborted) throw abortError();
			skip("kline-fetch-failed");
			host.log("warn", `kline fetch failed for ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		scanned++;
		if (scanned % 200 === 0) host.log("info", `scan progress: ${scanned}/${universe.length}, matched ${candidates.length}`);
		const series = barsToSeries(fileData.bars.map(fromBarTuple));
		const hit = strategy.screen({
			stock,
			bars: series
		}, params);
		if (hit) candidates.push(hit);
	}
	const klineFailures = skipped["kline-fetch-failed"] ?? 0;
	if (klineFailures > Math.max(10, Math.floor(universe.length * .1))) throw new Error(`aborting scan: kline fetch failed for ${klineFailures}/${universe.length} stocks — likely a systemic data-source outage. Fix connectivity, then retry.`);
	candidates.sort((a, b) => a.code.localeCompare(b.code));
	return {
		strategy: strategy.id,
		dataSource: dataSource.id,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		scanned,
		matched: candidates.length,
		candidates: candidates.map((hit) => ({ ...hit })),
		skipped,
		stocksFetched: fetchedThisRun.size,
		durationMs: Date.now() - startedAt,
		notes: [],
		disclaimer: DISCLAIMER
	};
}
//#endregion
//#region src/tool.ts
/**
* Model-facing tools: `a_share_screen` (full market scan) and
* `a_share_list_strategies` (strategy discovery).
* @module a-share-screener/tool
*/
/** Human/model-readable text report from a canonical scan result. */
function renderReport(value) {
	const lines = [];
	lines.push(`A-share screening — strategy ${value.strategy} (${value.dataSource})`);
	lines.push(`Scanned ${value.scanned} stocks, matched ${value.matched} in ${(value.durationMs / 1e3).toFixed(0)}s (bar files fetched this run: ${value.stocksFetched}).`);
	if (value.candidates.length > 0) {
		lines.push("");
		lines.push("code     name             board    limit-up   surge   cooldown  days  close");
		for (const hit of value.candidates) {
			const evidence = hit.evidence;
			lines.push(`${hit.code}  ${hit.name.padEnd(12).slice(0, 12)}  ${hit.board.padEnd(7)}  ${String(evidence.limitUpDate ?? "-")}  ${String(evidence.limitUpVolumeSurge ?? "-").padStart(4)}x  ${String(evidence.cooldownVolumeRatio ?? "-").padStart(7)}  ${String(evidence.daysSinceLimitUp ?? "-").padStart(4)}  ${evidence.close ?? "-"}`);
		}
		lines.push("");
		lines.push("Each candidate carries full evidence fields (drawdown, percentile, flat metrics) in its result entry.");
	} else lines.push("No stock matched this strategy with the given parameters.");
	if (Object.entries(value.skipped).length > 0) lines.push(`Skipped by universe filters: ${JSON.stringify(value.skipped)}`);
	for (const note of value.notes) lines.push(`Note: ${note}`);
	lines.push(`DISCLAIMER: ${value.disclaimer}`);
	return lines.join("\n");
}
const outputSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		strategy: {
			type: "string",
			required: true
		},
		dataSource: {
			type: "string",
			required: true
		},
		generatedAt: {
			type: "string",
			required: true
		},
		scanned: {
			type: "number",
			required: true
		},
		matched: {
			type: "number",
			required: true
		},
		candidates: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: true,
				properties: {
					code: {
						type: "string",
						required: true
					},
					fullCode: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					},
					board: {
						type: "string",
						required: true
					},
					strategy: {
						type: "string",
						required: true
					},
					evidence: {
						type: "object",
						additionalProperties: true,
						required: true
					}
				}
			}
		},
		skipped: {
			type: "object",
			additionalProperties: true,
			required: true
		},
		stocksFetched: {
			type: "number",
			required: true
		},
		durationMs: {
			type: "number",
			required: true
		},
		notes: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		disclaimer: {
			type: "string",
			required: true
		}
	}
};
/** The full-market screening tool. */
function createScreenTool(deps) {
	const strategyIds = deps.registry.ids();
	return defineTool({
		name: "a_share_screen",
		description: "Screen all A-share stocks with a registered technical strategy and return matched candidates with quantified evidence (drawdown, percentile, flatness, limit-up date, volume ratios). Check a_share_list_strategies first for available strategy ids and their parameters. The scan reads a local disk cache: the first full scan downloads history bar-by-bar and can take many minutes; later scans are fast. Results are technical screening of historical patterns, NOT investment advice.",
		parameters: {
			strategy: {
				type: "string",
				required: true,
				enum: strategyIds,
				description: `Screening strategy id. Available: ${strategyIds.join(", ")}.`
			},
			params: {
				type: "object",
				additionalProperties: true,
				description: "Optional overrides for the strategy parameter defaults (see a_share_list_strategies). Unknown keys or out-of-range values are rejected with the valid set listed."
			},
			refresh: {
				type: "boolean",
				description: "Force-refresh the cached stock list and recent bars (default false)."
			}
		},
		output: {
			schema: outputSchema,
			render: (_args, value) => [{
				type: "text",
				text: renderReport(value)
			}]
		},
		timeoutMs: deps.config.scanTimeoutMs,
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			return runScreen(deps.host, deps.config, deps.dataSource, deps.registry, {
				strategyId: args.strategy,
				params: args.params === void 0 ? void 0 : args.params,
				refresh: args.refresh ?? false,
				signal: exec.signal
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `A-share screening: ${args.strategy}`,
			kind: "search"
		}),
		presentResult: (args) => ({
			card: "generic",
			title: `A-share screening done: ${args.strategy}`
		})
	});
}
/** Strategy discovery tool: ids, descriptions, and parameter tables with defaults. */
function createListStrategiesTool(deps) {
	return defineTool({
		name: "a_share_list_strategies",
		description: "List the available A-share screening strategies with their descriptions, parameters, defaults, and valid ranges. Call this before a_share_screen to pick a strategy id and tune parameters.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { strategies: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: true,
						properties: {
							id: {
								type: "string",
								required: true
							},
							description: {
								type: "string",
								required: true
							},
							params: {
								type: "object",
								additionalProperties: true,
								required: true
							}
						}
					}
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value.strategies, null, 2)
			}]
		},
		async execute() {
			return { strategies: deps.registry.list().map((strategy) => ({
				id: strategy.id,
				description: strategy.description,
				params: strategy.paramDocs
			})) };
		},
		presentCall: () => ({
			card: "generic",
			title: "List A-share screening strategies"
		})
	});
}
//#endregion
//#region src/index.ts
const name = "a-share-screener";
const inject = ["tools"];
const Config = Schema.object({
	cacheDir: Schema.string(),
	requestsPerMinute: Schema.number().min(30).max(1e3).default(200),
	historyBars: Schema.number().min(250).max(3e3).default(800),
	excludeST: Schema.boolean().default(true),
	excludeBSE: Schema.boolean().default(true),
	minListDays: Schema.number().min(0).max(5e3).default(365),
	scanTimeoutMs: Schema.number().min(6e4).max(72e5).default(18e5)
});
/** Log through the harness logger, falling back to the console. */
function log(ctx, level, message) {
	const logger = ctx.logger;
	if (typeof logger === "function") logger("a-share-screener")[level](message);
	else console[level === "warn" ? "warn" : "log"](`[a-share-screener] ${message}`);
}
function apply(ctx, config) {
	const registry = new StrategyRegistry();
	registry.register(lowFlatLimitUpStrategy);
	const deps = {
		host: { log: (level, message) => log(ctx, level, message) },
		config,
		dataSource: createDataSource("eastmoney", new RateLimiter(config.requestsPerMinute)),
		registry
	};
	ctx.tools.register(createListStrategiesTool(deps));
	ctx.tools.register(createScreenTool(deps));
}
//#endregion
export { Config, apply, inject, name };
