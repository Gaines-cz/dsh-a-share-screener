import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
	return (await fetchWithRetry(options)).json();
}
/**
* Fetch raw text with rate limiting, timeout, and retry — for endpoints that
* answer with non-JSON payloads (e.g. Sina's JSONP kline responses).
*/
async function fetchText(options) {
	return (await fetchWithRetry(options)).text();
}
/** Shared rate-limited, retrying fetch; callers decode the body themselves. */
async function fetchWithRetry(options) {
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
			if (res.ok) return res;
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
		bar.preClose,
		bar.amount ?? null
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
		preClose: t[6],
		amount: t[7] ?? null
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
			amount: bar.amount ?? null,
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
const KLINE_URL$1 = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
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
			url: `https://${host}/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(FS_ALL)}&fields=f12,f13,f14,f26,f100,f20,f21`,
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
/** Normalize an industry-board name; empty/placeholder values become undefined. */
function normalizeIndustry(value) {
	const name = String(value ?? "").trim();
	return name === "" || name === "-" ? void 0 : name;
}
/** Normalize a market-cap field; non-finite/non-positive values become undefined. */
function normalizeCap(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/** Merge two bar lists, deduplicating by date (incoming wins), ascending. */
function mergeBars(existing, incoming) {
	const byDate = /* @__PURE__ */ new Map();
	for (const bar of existing) byDate.set(bar.date, bar);
	for (const bar of incoming) byDate.set(bar.date, bar);
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
/**
* Fetch the full A-share stock list from the Eastmoney clist endpoint (all
* boards, BSE included; universe filtering happens later). Also serves the
* sina/tencent adapters, which have no listing-date-bearing list endpoint of
* their own.
*/
async function fetchEastmoneyStockList(limiter, signal) {
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
				listDate: normalizeDate(entry.f26),
				industry: normalizeIndustry(entry.f100),
				totalMarketCapYuan: normalizeCap(entry.f20),
				floatMarketCapYuan: normalizeCap(entry.f21)
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
* Build the Eastmoney data source, binding it to the shared rate limiter so
* callers never pass request-budget plumbing around.
*/
function createEastmoneyDataSource(limiter) {
	async function listStocks(signal) {
		return fetchEastmoneyStockList(limiter, signal);
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
			url: `${KLINE_URL$1}?secid=${secid}&klt=101&fqt=2&beg=${startDate}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`,
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
			const amount = Number(parts[6]);
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
				amount: Number.isFinite(amount) ? amount : null,
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
		capabilities: {
			industry: true,
			marketCap: true,
			amount: true
		},
		listStocks,
		dailyBars,
		refreshBars
	};
}
//#endregion
//#region src/datasources/sina.ts
/**
* Sina Finance public-endpoint adapter (free, no token): 前复权 daily klines
* via the CN_MarketDataService JSONP endpoint. One request returns the latest
* N bars (max 1023, roughly four trading years), so a stock's whole window is
* a single call. Prices are 前复权 (latest close ≈ market price).
*
* Volume unit: Sina reports shares (股); the adapter converts to lots (手,
* volume / 100) to match the domain convention and the tencent source. Verified
* against real responses on 600519 (2026-08-19..21): sina volume/100 equals
* tencent's 手-denominated volume exactly.
*
* Sina publishes no listing-date-bearing full-market list endpoint, so the
* stock list is served by the Eastmoney clist endpoint via
* {@link fetchEastmoneyStockList} — same metadata the eastmoney adapter uses.
* @module a-share-screener/datasources/sina
*/
const KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData";
/** Largest bar count Sina returns per request. */
const MAX_BARS = 1023;
function sinaSymbol(fullCode) {
	const [code, suffix] = fullCode.split(".");
	return `${suffix === "SH" ? "sh" : suffix === "BJ" ? "bj" : "sz"}${code}`;
}
/**
* Strip the JSONP wrapper (`/*<script>...*\/\nvar _=([...])`) and parse the
* payload array. Throws when the shape is unexpected (blocked/redirect page).
*/
function parseJsonp(text) {
	const start = text.indexOf("var _=(");
	if (start === -1) throw new Error(`unexpected sina response (no JSONP payload): ${text.slice(0, 80)}`);
	const open = start + 7;
	const close = text.lastIndexOf(")");
	if (close <= open) throw new Error(`unexpected sina response (unbalanced payload): ${text.slice(0, 80)}`);
	const parsed = JSON.parse(text.slice(open, close));
	if (!Array.isArray(parsed)) throw new Error(`unexpected sina response (payload not an array): ${text.slice(0, 80)}`);
	return parsed;
}
/**
* Build the Sina data source, bound to the shared rate limiter. Bars are
* 前复权 daily; volume is converted from shares to lots (手) to match the
* domain convention.
*/
function createSinaDataSource(limiter) {
	async function listStocks(signal) {
		return fetchEastmoneyStockList(limiter, signal);
	}
	async function dailyBars(fullCode, startDate, signal) {
		const text = await fetchText({
			url: `${KLINE_URL}?symbol=${sinaSymbol(fullCode)}&scale=240&ma=no&datalen=${MAX_BARS}`,
			limiter,
			signal
		});
		const bars = [];
		for (const row of parseJsonp(text)) {
			const date = String(row.day ?? "").replace(/\D/g, "");
			const open = Number(row.open);
			const close = Number(row.close);
			const high = Number(row.high);
			const low = Number(row.low);
			const volume = Number(row.volume);
			if (date.length !== 8 || ![
				open,
				close,
				high,
				low
			].every((v) => Number.isFinite(v) && v > 0)) continue;
			if (!Number.isFinite(volume) || volume < 0) continue;
			bars.push({
				date,
				open,
				high,
				low,
				close,
				volume: volume / 100,
				preClose: null
			});
		}
		return bars.filter((bar) => bar.date >= startDate).sort((a, b) => a.date.localeCompare(b.date));
	}
	return {
		id: "sina",
		capabilities: {
			industry: true,
			marketCap: true,
			amount: false
		},
		listStocks,
		dailyBars
	};
}
//#endregion
//#region src/datasources/tencent.ts
/**
* Tencent quote-center adapter (free fallback, no token): 后复权 (hfq) daily
* klines via the fqkline endpoint, at most 640 rows per request so long
* windows page backward. Back-adjusted anchors differ from Sina/Eastmoney, so
* series must never mix sources — the screener keeps per-source cache
* directories for exactly this reason.
*
* The `web.ifzq.gtimg.cn` host sometimes answers with a JS verification page
* (rate limiting / anti-bot), so the adapter fails over between hosts and
* re-probes on failure. Like Sina, Tencent has no listing-date-bearing list
* endpoint, so the stock list comes from the Eastmoney clist endpoint.
* @module a-share-screener/datasources/tencent
*/
const KLINE_HOSTS = ["ifzq.gtimg.cn", "proxy.finance.qq.com/ifzqgtimg"];
const KLINE_PATH = "/appstock/app/fqkline/get";
const PAGE_ROWS = 640;
const MAX_PAGES = 8;
let workingHost;
function tencentSymbol(fullCode) {
	const [code, suffix] = fullCode.split(".");
	return `${suffix === "SH" ? "sh" : suffix === "BJ" ? "bj" : "sz"}${code}`;
}
function parseRows(rows) {
	const bars = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length < 6) continue;
		const date = String(row[0]).replace(/\D/g, "");
		const open = Number(row[1]);
		const close = Number(row[2]);
		const high = Number(row[3]);
		const low = Number(row[4]);
		const volume = Number(row[5]);
		if (date.length !== 8 || ![
			open,
			close,
			high,
			low
		].every((v) => Number.isFinite(v) && v > 0)) continue;
		if (!Number.isFinite(volume) || volume < 0) continue;
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
	return bars;
}
/** One kline request through the failing-over host list. */
async function fetchKlinePage(symbol, end, pageRows, limiter, signal) {
	const hosts = workingHost ? [workingHost, ...KLINE_HOSTS.filter((h) => h !== workingHost)] : [...KLINE_HOSTS];
	let lastError;
	for (const host of hosts) try {
		const json = await fetchJson({
			url: `https://${host}${KLINE_PATH}?param=${encodeURIComponent(`${symbol},day,1900-01-01,${end},${pageRows},hfq`)}`,
			limiter,
			signal,
			retries: 1
		});
		workingHost = host;
		const payload = json.data?.[symbol];
		const rows = payload?.hfqday ?? payload?.day;
		if (!Array.isArray(rows)) throw new Error(`tencent returned no kline rows for ${symbol}`);
		return rows;
	} catch (err) {
		if (signal.aborted) throw err;
		if (host === workingHost) workingHost = void 0;
		lastError = err;
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
/**
* Build the Tencent data source, bound to the shared rate limiter. Bars are
* 后复权 daily; use as a fallback only (reported closes are not market prices).
*/
function createTencentDataSource(limiter) {
	async function listStocks(signal) {
		return fetchEastmoneyStockList(limiter, signal);
	}
	async function dailyBars(fullCode, startDate, signal) {
		const symbol = tencentSymbol(fullCode);
		const byDate = /* @__PURE__ */ new Map();
		let end = "2099-12-31";
		for (let page = 0; page < MAX_PAGES; page++) {
			const pageBars = parseRows(await fetchKlinePage(symbol, end, PAGE_ROWS, limiter, signal));
			for (const bar of pageBars) byDate.set(bar.date, bar);
			const earliest = pageBars[0]?.date;
			if (pageBars.length < PAGE_ROWS || earliest === void 0 || earliest <= startDate) break;
			const year = Number(earliest.slice(0, 4));
			const month = Number(earliest.slice(4, 6));
			const day = Number(earliest.slice(6, 8));
			const prev = new Date(Date.UTC(year, month - 1, day - 1));
			end = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
		}
		return [...byDate.values()].filter((bar) => bar.date >= startDate).sort((a, b) => a.date.localeCompare(b.date));
	}
	return {
		id: "tencent",
		capabilities: {
			industry: true,
			marketCap: true,
			amount: false
		},
		listStocks,
		dailyBars
	};
}
//#endregion
//#region src/datasources/index.ts
const FACTORIES = {
	/** Sina Finance 前复权日线: 免费、单请求 1023 根、最新价≈市价 (推荐主源)。 */
	sina: createSinaDataSource,
	/** 东方财富: 免费、前复权、含全市场股票清单 (免费回退源)。 */
	eastmoney: createEastmoneyDataSource,
	/** 腾讯: 免费、后复权 (报告价会虚高), 仅作备胎。 */
	tencent: createTencentDataSource
};
/** Build the data source for `id`, bound to the process-lifetime rate budget. */
function createDataSource(id, limiter) {
	return FACTORIES[id](limiter);
}
//#endregion
//#region src/engine/types.ts
/** Registry with loud failure on duplicate or unknown filter ids. */
var FilterRegistry = class {
	filters = /* @__PURE__ */ new Map();
	register(filter) {
		if (this.filters.has(filter.id)) throw new Error(`duplicate filter id: ${filter.id}`);
		this.filters.set(filter.id, filter);
	}
	get(id) {
		return this.filters.get(id);
	}
	/** Get a filter or throw with the list of available ids. */
	require(id) {
		const filter = this.filters.get(id);
		if (!filter) throw new Error(`unknown filter '${id}'. Available: ${this.ids().join(", ")}`);
		return filter;
	}
	ids() {
		return [...this.filters.keys()];
	}
	list() {
		return [...this.filters.values()];
	}
};
//#endregion
//#region src/engine/math.ts
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
/** Maximum of a numeric array (unlike Math.max(...spread), safe for long series). */
function maxOf(values) {
	let max = -Infinity;
	for (const value of values) if (value > max) max = value;
	return max;
}
/**
* Median of a numeric array (average of the two middle values for an even
* length, matching the established filter semantics). Copies before sorting,
* so callers never observe a mutated input. Returns NaN for an empty input —
* callers gate on empty before calling.
*/
function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
//#endregion
//#region src/filters/amount-liquidity.ts
/**
* Atomic filter `amount_liquidity`: the MEDIAN traded value of the last
* `liquidityWindowBars` bars is at least `minMedianAmountYi` 亿元 — a
* liquidity floor that excludes names too thin to trade, without the
* single-big-day bias a mean would introduce. Requires per-bar amount data
* (Eastmoney klines carry it; Sina/Tencent do not).
* @module a-share-screener/filters/amount-liquidity
*/
const amountLiquidityFilter = {
	id: "amount_liquidity",
	description: "Median daily traded value over the last `liquidityWindowBars` bars >= `minMedianAmountYi` 亿元. Requires an amount-capable source (eastmoney); sina/tencent publish no per-bar traded value.",
	requires: { amount: true },
	paramDocs: {
		liquidityWindowBars: {
			type: "number",
			default: 20,
			min: 5,
			max: 250,
			integer: true,
			description: "Bar window for the median traded value."
		},
		minMedianAmountYi: {
			type: "number",
			default: .3,
			min: 0,
			max: 1e3,
			description: "Minimum median daily traded value in 亿元 (0 = always passes when data exists)."
		}
	},
	apply(ctx, params) {
		const window = params.liquidityWindowBars;
		const start = Math.max(0, ctx.bars.length - window);
		const amounts = [];
		for (let i = start; i < ctx.bars.length; i++) {
			const amount = ctx.bars[i].amount;
			if (amount !== null && amount !== void 0 && Number.isFinite(amount) && amount >= 0) amounts.push(amount);
		}
		if (amounts.length === 0) return {
			passed: false,
			evidence: { medianAmountYi: null }
		};
		const medianYi = median(amounts) / 1e8;
		return {
			passed: medianYi >= params.minMedianAmountYi,
			evidence: { medianAmountYi: round(medianYi, 3) }
		};
	}
};
//#endregion
//#region src/filters/bars-since-low.ts
/**
* Atomic filter `bars_since_low`: the window minimum of the chained return
* index lies at least `minBarsSinceLow` bars back (a base that has been
* grinding, not a fresh knife), while the latest price is still near that low
* (at most `maxPctAboveLow` above it).
* @module a-share-screener/filters/bars-since-low
*/
const barsSinceLowFilter = {
	id: "bars_since_low",
	description: "The minimum of the return index over the last `lowLookbackBars` bars lies at least `minBarsSinceLow` bars before the latest bar, and the latest price is at most `maxPctAboveLow` above that low.",
	paramDocs: {
		lowLookbackBars: {
			type: "number",
			default: 500,
			min: 60,
			max: 3e3,
			integer: true,
			description: "Window in which to locate the minimum of the return index."
		},
		minBarsSinceLow: {
			type: "number",
			default: 40,
			min: 1,
			max: 1e3,
			integer: true,
			description: "Latest bar must be at least this many bars after the window low."
		},
		maxPctAboveLow: {
			type: "number",
			default: .5,
			min: .01,
			max: 5,
			description: "Latest price may sit at most this fraction above the window low."
		}
	},
	apply(ctx, params) {
		const lw = Math.min(params.lowLookbackBars, ctx.bars.length);
		let lowIdx = ctx.bars.length - lw;
		for (let i = lowIdx; i < ctx.bars.length; i++) if (ctx.idx[i] < ctx.idx[lowIdx]) lowIdx = i;
		const barsSinceLow = ctx.last - lowIdx;
		const pctAboveLow = ctx.current / ctx.idx[lowIdx] - 1;
		return {
			passed: barsSinceLow >= params.minBarsSinceLow && pctAboveLow <= params.maxPctAboveLow,
			evidence: {
				barsSinceLow,
				pctAboveLow: round(pctAboveLow, 4)
			}
		};
	}
};
//#endregion
//#region src/filters/limitup-search.ts
/** Parameter table shared by the two filters that locate the limit-up reference day. */
const limitUpSearchParamDocs = {
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
	minBarsAfterLimitUp: {
		type: "number",
		default: 6,
		min: 1,
		max: 30,
		integer: true,
		description: "The limit-up day must be at least this many bars before the latest bar (room to pull back and cool). cooldown_pullback enforces at least cooldownBars + 1 so its cooldown window never overlaps the limit-up day."
	}
};
/**
* Iterate candidate volume-heavy limit-up days newest-to-oldest, applying the
* shared window / minimum-gap / surge bounds. `minAfter` defaults to
* `minBarsAfterLimitUp`; callers whose cooldown window must never overlap the
* limit-up day pass `max(minBarsAfterLimitUp, cooldownBars + 1)`.
*/
function* iterVolumeHeavyLimitUp(ctx, params, minAfter) {
	const windowBars = params.limitUpWindowBars;
	const minSurge = params.minVolumeSurge;
	const after = minAfter ?? params.minBarsAfterLimitUp;
	const firstCandidate = Math.max(5, ctx.last - windowBars);
	const latestAllowed = ctx.last - after;
	for (let i = ctx.limitUpDays.length - 1; i >= 0; i--) {
		const day = ctx.limitUpDays[i];
		if (day.index < firstCandidate) break;
		if (day.index > latestAllowed) continue;
		if (day.surge < minSurge) continue;
		yield {
			index: day.index,
			date: day.date,
			pct: day.ret,
			surge: day.surge
		};
	}
}
/** Most recent volume-heavy limit-up day inside the window, or null. */
function findVolumeHeavyLimitUp(ctx, params) {
	return iterVolumeHeavyLimitUp(ctx, params).next().value ?? null;
}
//#endregion
//#region src/filters/cooldown-pullback.ts
/**
* Atomic filter `cooldown_pullback`: after the volume-heavy limit-up day the
* price pulled back below that day's close and the recent average volume cooled
* to at most `maxCooldownVolumeRatio` of the limit-up day's volume.
* @module a-share-screener/filters/cooldown-pullback
*/
const cooldownPullbackFilter = {
	id: "cooldown_pullback",
	description: "After the volume-heavy limit-up day, the price pulled back below that close and the recent `cooldownBars` average volume is at most `maxCooldownVolumeRatio` of the limit-up day volume. Evidence (cooldownRefDate / cooldownVolumeRatio / daysSinceLimitUp) cites the most recent day that also satisfies this pattern — which may be an OLDER day than the one volume_limit_up cites.",
	paramDocs: {
		...limitUpSearchParamDocs,
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
		}
	},
	apply(ctx, params) {
		const cooldownBars = params.cooldownBars;
		const minAfter = Math.max(params.minBarsAfterLimitUp, cooldownBars + 1);
		const maxRatio = params.maxCooldownVolumeRatio;
		const cooldownAvg = meanVolume(ctx.bars, ctx.last - cooldownBars + 1, ctx.last + 1);
		for (const day of iterVolumeHeavyLimitUp(ctx, params, minAfter)) {
			let pulledBack = false;
			for (let e = day.index + 1; e <= ctx.last; e++) if (ctx.idx[e] < ctx.idx[day.index]) {
				pulledBack = true;
				break;
			}
			if (!pulledBack) continue;
			const limitUpVolume = ctx.bars[day.index].volume;
			if (cooldownAvg > maxRatio * limitUpVolume) continue;
			const cooldownRatio = cooldownAvg / limitUpVolume;
			return {
				passed: true,
				evidence: {
					cooldownRefDate: day.date,
					cooldownVolumeRatio: round(cooldownRatio, 4),
					daysSinceLimitUp: ctx.last - day.index
				}
			};
		}
		return {
			passed: false,
			evidence: {
				cooldownRefDate: null,
				cooldownVolumeRatio: null,
				daysSinceLimitUp: null
			}
		};
	}
};
//#endregion
//#region src/filters/deep-drawdown.ts
/**
* Atomic filter `deep_drawdown`: the latest price sits deep below the window
* high (measured on the chained return index, so ex-rights gaps never fake a
* crash). Passes when the drawdown meets the minimum threshold.
* @module a-share-screener/filters/deep-drawdown
*/
const deepDrawdownFilter = {
	id: "deep_drawdown",
	description: "The stock trades at least `minDrawdownFromHigh` below its window high on the chained return index.",
	paramDocs: { minDrawdownFromHigh: {
		type: "number",
		default: .65,
		min: .1,
		max: .99,
		description: "Minimum drawdown of the latest price from the window high (fraction)."
	} },
	apply(ctx, params) {
		const high = maxOf(ctx.idx);
		const drawdown = 1 - ctx.current / high;
		return {
			passed: drawdown >= params.minDrawdownFromHigh,
			evidence: { drawdownFromHigh: round(drawdown, 4) }
		};
	}
};
//#endregion
//#region src/filters/flat-base.ts
/**
* Atomic filter `flat_base`: the recent window is a flat base — tiny net change
* on the chained return index and converged moving averages (MA5/10/20/60).
* @module a-share-screener/filters/flat-base
*/
const MA_LENGTHS = [
	5,
	10,
	20,
	60
];
const flatBaseFilter = {
	id: "flat_base",
	description: "The latest `flatWindowBars` window is flat: net change within `maxFlatRangeChange` and MA5/10/20/60 spread within `maxFlatMaSpread`.",
	paramDocs: {
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
		}
	},
	apply(ctx, params) {
		const fw = params.flatWindowBars;
		if (ctx.last < fw) return {
			passed: false,
			evidence: {
				flatNetChange: null,
				flatMaSpread: null
			}
		};
		const netChange = Math.abs(ctx.current / ctx.idx[ctx.last - fw] - 1);
		const mas = [];
		for (const n of MA_LENGTHS) {
			const ma = smaAtIndex(ctx.idx, ctx.bars.length, n);
			if (ma === null) return {
				passed: false,
				evidence: {
					flatNetChange: round(netChange, 4),
					flatMaSpread: null
				}
			};
			mas.push(ma);
		}
		const maSpread = (Math.max(...mas) - Math.min(...mas)) / Math.min(...mas);
		return {
			passed: netChange <= params.maxFlatRangeChange && maSpread <= params.maxFlatMaSpread,
			evidence: {
				flatNetChange: round(netChange, 4),
				flatMaSpread: round(maSpread, 4)
			}
		};
	}
};
//#endregion
//#region src/filters/industry-shared.ts
/** Parameter table shared by every industry-stats filter. */
const industrySharedParamDocs = { minIndustryMembers: {
	type: "number",
	default: 8,
	min: 3,
	max: 100,
	integer: true,
	description: "Industries with fewer aggregated members do not pass (statistically meaningless)."
} };
/**
* Evidence for a stock whose industry stats are unavailable: no classification
* on the stock, or the screener ran no aggregation pass (capability-gated
* strategies never reach that state).
*/
function noIndustryEvidence(ctx, keys) {
	const evidence = { industry: ctx.stock.industry ?? null };
	for (const key of keys) evidence[key] = null;
	return evidence;
}
//#endregion
//#region src/filters/industry-clearance.ts
/**
* Atomic filter `industry_clearance`: the stock's industry board is itself in
* deep clearance — the median member sits at least `minIndustryMedDrawdown`
* below its window high, and at least `minIndustryDeepShare` of members are
* >= 60% below theirs. Industry statistics are aggregated by the screener's
* pre-pass over the whole universe; this filter only reads them.
* @module a-share-screener/filters/industry-clearance
*/
const industryClearanceFilter = {
	id: "industry_clearance",
	description: "The industry board is in deep clearance: median member drawdown-from-high >= `minIndustryMedDrawdown` and the share of members >= 60% below their window high is >= `minIndustryDeepShare`, over >= `minIndustryMembers` members. Requires industry data (all shipped sources provide it via the shared stock list).",
	requires: { industry: true },
	paramDocs: {
		...industrySharedParamDocs,
		minIndustryMedDrawdown: {
			type: "number",
			default: .4,
			min: .1,
			max: .9,
			description: "Median drawdown-from-high of the industry must be at least this."
		},
		minIndustryDeepShare: {
			type: "number",
			default: .25,
			min: .05,
			max: 1,
			description: "Share of the industry's members at least 60% below their window high."
		}
	},
	apply(ctx, params) {
		const stats = ctx.industry;
		if (stats === void 0) return {
			passed: false,
			evidence: noIndustryEvidence(ctx, [
				"industryMedDrawdown",
				"industryDeepShare",
				"industryMembers"
			])
		};
		return {
			passed: stats.medDrawdown >= params.minIndustryMedDrawdown && stats.deepShare >= params.minIndustryDeepShare && stats.members >= params.minIndustryMembers,
			evidence: {
				industry: stats.industry,
				industryMedDrawdown: round(stats.medDrawdown, 4),
				industryDeepShare: round(stats.deepShare, 4),
				industryMembers: stats.members
			}
		};
	}
};
//#endregion
//#region src/filters/industry-position.ts
/**
* Atomic filter `industry_position`: the industry board trades at a LOW
* position in its own range — the median member sits at or below
* `maxIndustryMedPos` of its ~3-year price distribution. Complements
* `industry_clearance`: that gate asks how DEEP the fall was (median
* drawdown-from-high), this one asks WHERE the board sits in its range
* (median window percentile). A board can be deeply fallen yet still sit in
* the upper half of its range during a dead-cat bounce, and vice versa.
* @module a-share-screener/filters/industry-position
*/
const industryPositionFilter = {
	id: "industry_position",
	description: "The industry board trades at a low position: the median member ranks at or below `maxIndustryMedPos` of its own ~3-year price distribution (median of 730-bar window percentiles), over >= `minIndustryMembers` members. Complements industry_clearance (depth of the fall) with the position in range. Requires industry data.",
	requires: { industry: true },
	paramDocs: {
		...industrySharedParamDocs,
		maxIndustryMedPos: {
			type: "number",
			default: .35,
			min: .05,
			max: 1,
			description: "Median member must rank at or below this window percentile."
		}
	},
	apply(ctx, params) {
		const stats = ctx.industry;
		if (stats === void 0) return {
			passed: false,
			evidence: noIndustryEvidence(ctx, ["industryMedPos", "industryMembers"])
		};
		return {
			passed: stats.medPos <= params.maxIndustryMedPos && stats.members >= params.minIndustryMembers,
			evidence: {
				industry: stats.industry,
				industryMedPos: round(stats.medPos, 4),
				industryMembers: stats.members
			}
		};
	}
};
//#endregion
//#region src/filters/low-percentile.ts
/**
* Atomic filter `low_percentile`: the latest price ranks at or below a given
* percentile of the recent window on the chained return index.
* @module a-share-screener/filters/low-percentile
*/
const lowPercentileFilter = {
	id: "low_percentile",
	description: "The latest price ranks at or below `maxPercentile` of the recent `percentileWindowBars` window.",
	paramDocs: {
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
		}
	},
	apply(ctx, params) {
		const pw = Math.min(params.percentileWindowBars, ctx.bars.length);
		let below = 0;
		for (let i = ctx.bars.length - pw; i < ctx.bars.length; i++) if (ctx.idx[i] <= ctx.current) below++;
		const percentile = below / pw;
		return {
			passed: percentile <= params.maxPercentile,
			evidence: { percentileInWindow: round(percentile, 4) }
		};
	}
};
//#endregion
//#region src/filters/ma-stabilization.ts
/**
* Atomic filter `ma_stabilization`: the moving average of the chained return
* index has stopped falling (slope over `maSlopeBars` ≥ `minMaSlope`), and
* optionally the latest price sits at or above the MA — the cheapest
* right-side confirmation that a low flat base has stopped declining.
* @module a-share-screener/filters/ma-stabilization
*/
const maStabilizationFilter = {
	id: "ma_stabilization",
	description: "The `maStabWindow`-bar MA of the return index changed at least `minMaSlope` over the last `maSlopeBars` bars (0 = stopped falling), and when `requireCloseAboveMa` is set the latest price sits at or above the MA.",
	paramDocs: {
		maStabWindow: {
			type: "number",
			default: 20,
			min: 5,
			max: 120,
			integer: true,
			description: "MA window on the chained return index."
		},
		maSlopeBars: {
			type: "number",
			default: 5,
			min: 2,
			max: 30,
			integer: true,
			description: "Bars over which the MA slope is measured."
		},
		minMaSlope: {
			type: "number",
			default: 0,
			min: -.05,
			max: .2,
			description: "Min relative MA change over maSlopeBars (0 = stopped falling)."
		},
		requireCloseAboveMa: {
			type: "boolean",
			default: true,
			description: "Latest price must sit at or above the MA."
		}
	},
	apply(ctx, params) {
		const window = params.maStabWindow;
		const slopeBars = params.maSlopeBars;
		if (ctx.bars.length < window + slopeBars) return {
			passed: false,
			evidence: {
				maSlope: null,
				closeVsMaPct: null
			}
		};
		const ma = smaAtIndex(ctx.idx, ctx.bars.length, window);
		const maPrev = smaAtIndex(ctx.idx, ctx.bars.length - slopeBars, window);
		if (ma === null || maPrev === null || ma <= 0 || maPrev <= 0) return {
			passed: false,
			evidence: {
				maSlope: null,
				closeVsMaPct: null
			}
		};
		const slope = ma / maPrev - 1;
		const closeVsMa = ctx.current / ma - 1;
		return {
			passed: slope >= params.minMaSlope && (!params.requireCloseAboveMa || ctx.current >= ma),
			evidence: {
				maSlope: round(slope, 4),
				closeVsMaPct: round(closeVsMa, 4)
			}
		};
	}
};
//#endregion
//#region src/filters/market-cap-band.ts
/**
* Atomic filter `market_cap_band`: the stock's total market capitalization
* (list-time snapshot in CNY) lies in [minCapYi, maxCapYi] 亿元; 0 means no
* bound on that side. Pairs naturally with the listing-age universe filters
* for new-stock screens.
* @module a-share-screener/filters/market-cap-band
*/
const marketCapBandFilter = {
	id: "market_cap_band",
	description: "Total market cap (list-time snapshot) inside [minCapYi, maxCapYi] 亿元 (0 = no bound on that side). Requires a source whose stock list carries market caps (all shipped sources do).",
	requires: { marketCap: true },
	paramDocs: {
		minCapYi: {
			type: "number",
			default: 20,
			min: 0,
			max: 1e5,
			description: "Minimum total market cap in 亿元 (0 = no lower bound)."
		},
		maxCapYi: {
			type: "number",
			default: 0,
			min: 0,
			max: 1e6,
			description: "Maximum total market cap in 亿元 (0 = no upper bound)."
		}
	},
	apply(ctx, params) {
		const capYuan = ctx.stock.totalMarketCapYuan;
		if (capYuan === void 0 || !Number.isFinite(capYuan) || capYuan <= 0) return {
			passed: false,
			evidence: { marketCapYi: null }
		};
		const capYi = capYuan / 1e8;
		const min = params.minCapYi;
		const max = params.maxCapYi;
		return {
			passed: capYi >= min && (max <= 0 || capYi <= max),
			evidence: { marketCapYi: round(capYi, 1) }
		};
	}
};
//#endregion
//#region src/filters/platform-breakout.ts
/**
* Atomic filter `platform_breakout`: a flat base of `baseWindowBars` bars is
* followed by a volume-heavy breakout day whose close clears the base high,
* and the index has stayed out of the base ever since. The mirror image of
* `cooldown_pullback`: that one confirms a pullback, this one confirms a
* launch. The flat-base test is self-contained (measured immediately before
* the breakout day), so a strategy using this filter must NOT also require
* `flat_base` on the latest window — a breakout makes the latest window
* non-flat by construction.
* @module a-share-screener/filters/platform-breakout
*/
const platformBreakoutFilter = {
	id: "platform_breakout",
	description: "Within the last `breakoutWindowBars` bars there is a day that closes at least `minBreakoutMargin` above the high of the `baseWindowBars`-bar flat base immediately before it, on >= `minBreakoutSurge`x the prior 5-bar average volume, and the index never re-entered the base afterwards (giveback <= `maxBaseGiveback`). Evidence cites the MOST RECENT qualifying breakout day.",
	paramDocs: {
		breakoutWindowBars: {
			type: "number",
			default: 10,
			min: 1,
			max: 60,
			integer: true,
			description: "Bars back from the latest bar to search for the breakout day."
		},
		baseWindowBars: {
			type: "number",
			default: 30,
			min: 10,
			max: 250,
			integer: true,
			description: "Flat-base window immediately BEFORE the breakout day."
		},
		maxBaseRangeChange: {
			type: "number",
			default: .08,
			min: .005,
			max: .5,
			description: "Max abs net change of the return index over the base window (base flatness)."
		},
		minBreakoutMargin: {
			type: "number",
			default: .02,
			min: 0,
			max: .3,
			description: "Breakout close must clear the base high by at least this fraction."
		},
		minBreakoutSurge: {
			type: "number",
			default: 2,
			min: 1.1,
			max: 20,
			description: "Breakout-day volume must be at least this multiple of the prior 5-bar average."
		},
		minBarsAfterBreakout: {
			type: "number",
			default: 2,
			min: 1,
			max: 30,
			integer: true,
			description: "Breakout day must be at least this many bars before the latest bar (>= 2 gives the breakout one confirming close)."
		},
		maxBaseGiveback: {
			type: "number",
			default: 0,
			min: 0,
			max: .1,
			description: "Max fraction the index may dip below the base high after the breakout (0 = never re-enter the base)."
		}
	},
	apply(ctx, params) {
		const baseWindow = params.baseWindowBars;
		const earliest = Math.max(5, ctx.last - params.breakoutWindowBars);
		const latestAllowed = ctx.last - params.minBarsAfterBreakout;
		const maxGiveback = params.maxBaseGiveback;
		for (let b = latestAllowed; b >= earliest; b--) {
			const baseStart = b - baseWindow;
			if (baseStart < 0) break;
			const baseEnd = ctx.idx[b - 1];
			if (baseEnd <= 0 || ctx.idx[baseStart] <= 0) continue;
			if (Math.abs(baseEnd / ctx.idx[baseStart] - 1) > params.maxBaseRangeChange) continue;
			let baseMax = -Infinity;
			for (let i = baseStart; i < b; i++) if (ctx.idx[i] > baseMax) baseMax = ctx.idx[i];
			if (ctx.idx[b] < baseMax * (1 + params.minBreakoutMargin)) continue;
			const prevAvg = meanVolume(ctx.bars, b - 5, b);
			const surge = prevAvg <= 0 ? 0 : ctx.bars[b].volume / prevAvg;
			if (surge < params.minBreakoutSurge) continue;
			let held = true;
			for (let e = b; e <= ctx.last; e++) if (ctx.idx[e] < baseMax * (1 - maxGiveback)) {
				held = false;
				break;
			}
			if (!held) continue;
			return {
				passed: true,
				evidence: {
					breakoutDate: ctx.bars[b].date,
					breakoutSurge: round(surge, 2),
					barsSinceBreakout: ctx.last - b,
					baseToClosePct: round(ctx.current / baseMax - 1, 4)
				}
			};
		}
		return {
			passed: false,
			evidence: {
				breakoutDate: null,
				breakoutSurge: null,
				barsSinceBreakout: null,
				baseToClosePct: null
			}
		};
	}
};
//#endregion
//#region src/filters/turnover-band.ts
/**
* Atomic filter `turnover_band`: the median daily turnover rate over the last
* `turnoverWindowBars` bars sits inside [minTurnoverPct, maxTurnoverPct]
* (percent of free-float shares traded). Turnover is derived from volume
* (lots), close, and the list-time free-float market cap — so unlike
* `amount_liquidity` it needs no per-bar traded value and runs on every
* shipped source. A low floor keeps out illiquid names; an upper bound keeps
* out blown-off turnover spikes.
* @module a-share-screener/filters/turnover-band
*/
/** Shares per lot (手). */
const SHARES_PER_LOT = 100;
const turnoverBandFilter = {
	id: "turnover_band",
	description: "Median daily turnover rate (shares traded / free-float shares, from volume × 100 / (floatMarketCap / close)) over the last `turnoverWindowBars` bars inside [minTurnoverPct, maxTurnoverPct] percent (0 = no bound on that side). Requires a source whose list carries the free-float market cap (all shipped sources do).",
	requires: { marketCap: true },
	paramDocs: {
		turnoverWindowBars: {
			type: "number",
			default: 20,
			min: 5,
			max: 250,
			integer: true,
			description: "Bar window for the median turnover rate."
		},
		minTurnoverPct: {
			type: "number",
			default: .5,
			min: 0,
			max: 100,
			description: "Minimum median daily turnover in percent."
		},
		maxTurnoverPct: {
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			description: "Maximum median daily turnover in percent (0 = no upper bound)."
		}
	},
	apply(ctx, params) {
		const floatCapYuan = ctx.stock.floatMarketCapYuan;
		const currentClose = ctx.bars[ctx.last].close;
		if (floatCapYuan === void 0 || !Number.isFinite(floatCapYuan) || floatCapYuan <= 0 || currentClose <= 0) return {
			passed: false,
			evidence: { medianTurnoverPct: null }
		};
		const floatShares = floatCapYuan / currentClose;
		if (!Number.isFinite(floatShares) || floatShares <= 0) return {
			passed: false,
			evidence: { medianTurnoverPct: null }
		};
		const window = params.turnoverWindowBars;
		const start = Math.max(0, ctx.bars.length - window);
		const turnovers = [];
		for (let i = start; i < ctx.bars.length; i++) {
			const bar = ctx.bars[i];
			if (bar.close <= 0) continue;
			turnovers.push(bar.volume * SHARES_PER_LOT / floatShares);
		}
		if (turnovers.length === 0) return {
			passed: false,
			evidence: { medianTurnoverPct: null }
		};
		const medianPct = median(turnovers) * 100;
		const min = params.minTurnoverPct;
		const max = params.maxTurnoverPct;
		return {
			passed: medianPct >= min && (max <= 0 || medianPct <= max),
			evidence: { medianTurnoverPct: round(medianPct, 3) }
		};
	}
};
//#endregion
//#region src/filters/volatility-regime.ts
/**
* Atomic filter `volatility_regime`: the annualized realized volatility of
* daily returns over `volWindow` bars sits inside [minAnnualVol, maxAnnualVol].
* A two-sided elasticity gate: the lower bound drops dead stocks (no
* elasticity left), the upper bound drops blown-off mania tails.
* @module a-share-screener/filters/volatility-regime
*/
/** Trading days per year used for annualizing daily volatility. */
const TRADING_DAYS = 252;
const volatilityRegimeFilter = {
	id: "volatility_regime",
	description: "Annualized realized volatility (sample stdev of daily returns over the last `volWindow` bars × √252) must lie in [minAnnualVol, maxAnnualVol]. Null ret bars (first bar of a series) are skipped.",
	paramDocs: {
		volWindow: {
			type: "number",
			default: 60,
			min: 20,
			max: 250,
			integer: true,
			description: "Bar window for realized volatility."
		},
		minAnnualVol: {
			type: "number",
			default: .15,
			min: .01,
			max: 3,
			description: "Minimum annualized realized volatility (drops dead stocks)."
		},
		maxAnnualVol: {
			type: "number",
			default: .8,
			min: .05,
			max: 5,
			description: "Maximum annualized realized volatility (drops blown-off mania tails)."
		}
	},
	apply(ctx, params) {
		const window = params.volWindow;
		const start = Math.max(0, ctx.bars.length - window);
		let sum = 0;
		let count = 0;
		for (let i = start; i < ctx.bars.length; i++) {
			const ret = ctx.bars[i].ret;
			if (ret === null) continue;
			sum += ret;
			count++;
		}
		if (count < 2) return {
			passed: false,
			evidence: { annualVol: null }
		};
		const mean = sum / count;
		let sq = 0;
		for (let i = start; i < ctx.bars.length; i++) {
			const ret = ctx.bars[i].ret;
			if (ret === null) continue;
			sq += (ret - mean) ** 2;
		}
		const annualVol = Math.sqrt(sq / (count - 1)) * Math.sqrt(TRADING_DAYS);
		return {
			passed: annualVol >= params.minAnnualVol && annualVol <= params.maxAnnualVol,
			evidence: { annualVol: round(annualVol, 4) }
		};
	}
};
//#endregion
//#region src/filters/volume-dry-up.ts
/**
* Atomic filter `volume_dry_up`: an absolute volume drought — the average
* volume of the last `dryUpBars` bars is at most `maxDryUpRatio` of the
* average over the preceding `referenceWindowBars` bars (the dry window is
* excluded from its own baseline, so a long drought cannot quietly drag the
* reference down). Complements `cooldown_pullback`: that gate is relative to
* one limit-up day, this one is relative to the stock's own normal turnover —
* "地量见地价" as a left-side companion.
* @module a-share-screener/filters/volume-dry-up
*/
const volumeDryUpFilter = {
	id: "volume_dry_up",
	description: "Absolute volume drought: the recent `dryUpBars` average volume is at most `maxDryUpRatio` of the average over the preceding `referenceWindowBars` bars (dry window excluded from its own baseline).",
	paramDocs: {
		dryUpBars: {
			type: "number",
			default: 5,
			min: 3,
			max: 30,
			integer: true,
			description: "Bar count for the recent (dry) volume average."
		},
		referenceWindowBars: {
			type: "number",
			default: 120,
			min: 20,
			max: 500,
			integer: true,
			description: "Bar count of the normal-turnover baseline ending right before the dry window."
		},
		maxDryUpRatio: {
			type: "number",
			default: .5,
			min: .05,
			max: 2,
			description: "Recent average volume must be at most this fraction of the baseline average."
		}
	},
	apply(ctx, params) {
		const dryBars = params.dryUpBars;
		const refWindow = params.referenceWindowBars;
		const dryStart = ctx.last - dryBars + 1;
		const refAvg = meanVolume(ctx.bars, dryStart - refWindow, dryStart);
		if (refAvg <= 0) return {
			passed: false,
			evidence: { dryUpVolumeRatio: null }
		};
		const ratio = meanVolume(ctx.bars, dryStart, ctx.last + 1) / refAvg;
		return {
			passed: ratio <= params.maxDryUpRatio,
			evidence: { dryUpVolumeRatio: round(ratio, 4) }
		};
	}
};
//#endregion
//#region src/filters/volume-limitup.ts
/**
* Atomic filter `volume_limit_up`: a volume-heavy limit-up day exists inside
* the lookback window. Volume surge is relative to the prior 5-bar average;
* the day must be recent enough to leave room for a pullback and cooldown.
* @module a-share-screener/filters/volume-limitup
*/
const volumeLimitUpFilter = {
	id: "volume_limit_up",
	description: "Within the last `limitUpWindowBars` bars there is a close-at-limit-up day whose volume is at least `minVolumeSurge` times the prior 5-bar average. Evidence (limitUpDate / limitUpPct / limitUpVolumeSurge) always cites the MOST RECENT such day; cooldown_pullback may cite a different, older day.",
	paramDocs: { ...limitUpSearchParamDocs },
	apply(ctx, params) {
		const found = findVolumeHeavyLimitUp(ctx, params);
		return {
			passed: found !== null,
			evidence: {
				limitUpDate: found?.date ?? null,
				limitUpPct: found === null ? null : round(found.pct, 4),
				limitUpVolumeSurge: found === null ? null : round(found.surge, 2)
			}
		};
	}
};
//#endregion
//#region src/filters/index.ts
/**
* Central filter registration: the one place atomic filters plug in. Strategies
* compose from these via {@link composeStrategy}; the `a_share_list_filters`
* tool and `filters` CLI list them for discovery.
* @module a-share-screener/filters
*/
/** Register every shipped atomic filter. Safe to call once per registry instance. */
function registerAllFilters(registry) {
	registry.register(deepDrawdownFilter);
	registry.register(lowPercentileFilter);
	registry.register(barsSinceLowFilter);
	registry.register(flatBaseFilter);
	registry.register(platformBreakoutFilter);
	registry.register(maStabilizationFilter);
	registry.register(volatilityRegimeFilter);
	registry.register(volumeLimitUpFilter);
	registry.register(cooldownPullbackFilter);
	registry.register(volumeDryUpFilter);
	registry.register(industryClearanceFilter);
	registry.register(industryPositionFilter);
	registry.register(marketCapBandFilter);
	registry.register(amountLiquidityFilter);
	registry.register(turnoverBandFilter);
}
/** Build a registry pre-loaded with every shipped filter. */
function createFilterRegistry() {
	const registry = new FilterRegistry();
	registerAllFilters(registry);
	return registry;
}
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
*
* The heavy steps (universe preparation, per-stock bar acquisition) are
* exported so the standalone CLI (`sync`/`scan`) can drive the same local
* cache without going through the dsh tool layer.
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
function cacheDirOf(config) {
	return config.cacheDir ?? defaultCacheDir();
}
/**
* Stock list + universe filters (ST/BSE/recent-listing), refreshing the cached
* list at most once per day. Shared by scanning and syncing.
*
* The list fetch is failure-tolerant: when the source's list endpoint is down
* but a cached `stocks.json` exists (even stale), the run proceeds on the
* cached universe with a warning instead of aborting — the list is only
* metadata, and bar fetching is what actually needs the live source.
*/
async function prepareUniverse(config, dataSource, signal, refresh, warn = () => void 0) {
	const stocksFile = join(cacheDirOf(config), "stocks.json");
	const today = todayYmd();
	let stocksCache = await readJson(stocksFile);
	if (refresh || !stocksCache || (stocksCache.fetchedAt ?? "") < today) try {
		const stocks = await dataSource.listStocks(signal);
		await writeJson(stocksFile, {
			fetchedAt: today,
			stocks
		});
		stocksCache = {
			fetchedAt: today,
			stocks
		};
	} catch (err) {
		if (signal.aborted) throw err;
		if (stocksCache === void 0) throw err;
		warn(`stock list fetch/persist failed (${err instanceof Error ? err.message : String(err)}); using cached list from ${stocksCache.fetchedAt ?? "unknown date"}`);
	}
	const skipped = {};
	const skip = (reason) => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};
	const minListDate = dateMinusDays(today, config.minListDays);
	const maxListDays = config.maxListDays ?? 0;
	const maxListDate = maxListDays > 0 ? dateMinusDays(today, maxListDays) : "";
	const universe = [];
	for (const stock of stocksCache.stocks) {
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
		if (maxListDate !== "" && stock.listDate < maxListDate) {
			skip("too-old-listing");
			continue;
		}
		universe.push(stock);
	}
	return {
		stocks: universe,
		skipped,
		today
	};
}
/** Apply a code whitelist on top of the universe filters. */
function filterByCodes(stocks, codes, skipped) {
	if (codes === void 0 || codes.length === 0) return stocks;
	const wanted = new Set(codes);
	const kept = stocks.filter((stock) => wanted.has(stock.code));
	skipped["code-filtered"] = (skipped["code-filtered"] ?? 0) + (stocks.length - kept.length);
	return kept;
}
/**
* Bring one stock's bar cache up to date: full fetch when missing/backfill
* needed, incremental refresh through the source when stale, cache hit
* otherwise. Marks fetched codes in `fetchedThisRun`.
*/
async function acquireBarsFile(config, dataSource, stock, startDate, today, signal, fetchedThisRun) {
	const file = join(cacheDirOf(config), dataSource.id, "bars", `${stock.fullCode}.json`);
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
}
/** Abort a run when kline fetching fails systemically. */
function assertHealthy(skipped, universeSize) {
	const failures = skipped["kline-fetch-failed"] ?? 0;
	if (failures > Math.max(10, Math.floor(universeSize * .1))) throw new Error(`aborting scan: kline fetch failed for ${failures}/${universeSize} stocks — likely a systemic data-source outage. Fix connectivity, then retry.`);
}
/** Refuse silently-degraded runs: every declared data requirement must be served. */
function assertCapabilities(strategy, dataSource) {
	const req = strategy.requires;
	if (!req) return;
	const caps = dataSource.capabilities;
	const missing = [];
	if (req.industry && !caps.industry) missing.push("industry classification");
	if (req.marketCap && !caps.marketCap) missing.push("market cap");
	if (req.amount && !caps.amount) missing.push("per-bar traded value (amount)");
	if (missing.length > 0) throw new Error(`strategy '${strategy.id}' requires ${missing.join(", ")} which data source '${dataSource.id}' does not provide — the scan would silently degrade. Pick a source with those capabilities instead of approximating.`);
}
/** Percentile window for the industry-cycle pre-pass (bars, clamped to available data). */
const INDUSTRY_POS_WINDOW = 730;
/** "Deep" drawdown threshold for the industry deep-share statistic. */
const INDUSTRY_DEEP_THRESHOLD = .6;
/**
* One stock's parameter-independent cycle summary for industry aggregation:
* full-window drawdown-from-high and 730-bar window percentile, both on the
* chained return index. The percentile is a single O(window) backward count
* (identical to `low_percentile` semantics), not a rolling-window shift.
*/
function cycleSummary(series) {
	const idx = new Array(series.length);
	idx[0] = 1;
	let max = 1;
	for (let i = 1; i < series.length; i++) {
		const ret = series[i].ret;
		idx[i] = idx[i - 1] * Math.max(1e-9, 1 + (ret === null ? 0 : ret));
		if (idx[i] > max) max = idx[i];
	}
	const current = idx[idx.length - 1];
	const dd = max > 0 ? 1 - current / max : 0;
	const window = Math.min(INDUSTRY_POS_WINDOW, series.length);
	let below = 0;
	for (let i = series.length - window; i < series.length; i++) if (idx[i] <= current) below++;
	return {
		dd,
		pos: window > 0 ? below / window : 1
	};
}
/**
* Industry-cycle aggregation pre-pass: walk the whole (pre-whitelist) universe,
* summarize each member's cycle position, and aggregate per industry board.
* Industry stats are market-level facts, so the code whitelist does NOT shrink
* the aggregation set — it only restricts candidates. Two consequences:
* - stats are computed over the UNIVERSE-FILTERED members (ST / BSE / listings
*   younger than minListDays are excluded), so they describe the screener's
*   investable universe, not the raw exchange listing
* - a code-restricted industry scan still fetches bars for the whole market,
*   because the per-board medians must be market-wide
*/
async function aggregateIndustries(host, config, dataSource, stocks, startDate, today, signal, fetchedThisRun) {
	const drawdowns = /* @__PURE__ */ new Map();
	const positions = /* @__PURE__ */ new Map();
	let withoutIndustry = 0;
	let scanned = 0;
	let fetchFailed = 0;
	for (const stock of stocks) {
		if (signal.aborted) throw abortError();
		let bars;
		try {
			bars = await acquireBarsFile(config, dataSource, stock, startDate, today, signal, fetchedThisRun);
		} catch (err) {
			if (signal.aborted) throw abortError();
			fetchFailed++;
			continue;
		}
		scanned++;
		if (scanned % 500 === 0) host.log("info", `industry pre-pass: ${scanned}/${stocks.length}`);
		if (stock.industry === void 0) {
			withoutIndustry++;
			continue;
		}
		const summary = cycleSummary(barsToSeries(bars.bars.map(fromBarTuple)));
		let dds = drawdowns.get(stock.industry);
		if (!dds) drawdowns.set(stock.industry, dds = []);
		dds.push(summary.dd);
		let poss = positions.get(stock.industry);
		if (!poss) positions.set(stock.industry, poss = []);
		poss.push(summary.pos);
	}
	const stats = /* @__PURE__ */ new Map();
	for (const [industry, dds] of drawdowns) {
		const poss = positions.get(industry) ?? [];
		const deep = dds.filter((dd) => dd >= INDUSTRY_DEEP_THRESHOLD).length;
		stats.set(industry, {
			industry,
			members: dds.length,
			medDrawdown: median(dds),
			medPos: median(poss),
			deepShare: dds.length > 0 ? deep / dds.length : 0
		});
	}
	host.log("info", `industry aggregation: ${stats.size} industries over ${scanned} members (${withoutIndustry} without classification${fetchFailed > 0 ? `, ${fetchFailed} fetch failures` : ""})`);
	if (fetchFailed > Math.max(10, Math.floor(stocks.length * .1))) host.log("warn", `industry pre-pass: kline fetch failed for ${fetchFailed}/${stocks.length} members — likely a systemic data-source outage; industry medians may be skewed`);
	return stats;
}
/** Run one full screening pass. Throws loud, actionable errors on bad input. */
async function runScreen(host, config, dataSource, registry, args) {
	const startedAt = Date.now();
	const strategy = registry.get(args.strategyId);
	if (!strategy) throw new Error(`unknown strategy '${args.strategyId}'. Available: ${registry.ids().join(", ")}`);
	assertCapabilities(strategy, dataSource);
	const params = registry.resolveParams(args.strategyId, args.params);
	const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, args.signal, args.refresh ?? false, (m) => host.log("warn", m));
	const universe = filterByCodes(filtered, args.codes, skipped);
	host.log("info", `universe after filters: ${universe.length} (skipped ${JSON.stringify(skipped)})`);
	const startDate = historyStartDate(config.historyBars);
	const fetchedThisRun = /* @__PURE__ */ new Set();
	const candidates = [];
	const notes = [];
	let industryByStock;
	if (strategy.requires?.industry) {
		industryByStock = /* @__PURE__ */ new Map();
		const stats = await aggregateIndustries(host, config, dataSource, filtered, startDate, today, args.signal, fetchedThisRun);
		for (const stock of filtered) {
			const stat = stock.industry === void 0 ? void 0 : stats.get(stock.industry);
			if (stat !== void 0) industryByStock.set(stock.code, stat);
		}
		notes.push(`industry cycle aggregated over ${stats.size} boards (median drawdown / deep share / members per candidate evidence)`);
	}
	let scanned = 0;
	for (const stock of universe) {
		if (args.signal.aborted) throw abortError();
		let fileData;
		try {
			fileData = await acquireBarsFile(config, dataSource, stock, startDate, today, args.signal, fetchedThisRun);
		} catch (err) {
			if (args.signal.aborted) throw abortError();
			skipped["kline-fetch-failed"] = (skipped["kline-fetch-failed"] ?? 0) + 1;
			host.log("warn", `kline fetch failed for ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		scanned++;
		if (scanned % 200 === 0) host.log("info", `scan progress: ${scanned}/${universe.length}, matched ${candidates.length}`);
		const series = barsToSeries(fileData.bars.map(fromBarTuple));
		const hit = strategy.screen({
			stock,
			bars: series,
			industryStats: industryByStock?.get(stock.code)
		}, params);
		if (hit) candidates.push(hit);
	}
	assertHealthy(skipped, universe.length);
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
		notes,
		disclaimer: DISCLAIMER
	};
}
/**
* Warm the local bar cache without evaluating any strategy — the CLI `sync`
* command. Fetches/refreshes bars for the (optionally code-restricted)
* universe, honoring the per-source incremental refresh paths. When
* `concurrency > 1`, fetches run in a bounded worker pool (safe: each stock
* writes its own cache file atomically).
*/
async function syncBars(host, config, dataSource, args) {
	const startedAt = Date.now();
	const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, args.signal, args.refresh ?? false, (m) => host.log("warn", m));
	const universe = filterByCodes(filtered, args.codes, skipped);
	host.log("info", `sync: ${universe.length} stocks to refresh via ${dataSource.id}`);
	const startDate = historyStartDate(config.historyBars);
	const fetchedThisRun = /* @__PURE__ */ new Set();
	let scanned = 0;
	const concurrency = Math.max(1, Math.floor(args.concurrency ?? 1));
	const work = async () => {
		for (;;) {
			const stock = queue.shift();
			if (stock === void 0) return;
			if (args.signal.aborted) throw abortError();
			try {
				await acquireBarsFile(config, dataSource, stock, startDate, today, args.signal, fetchedThisRun);
			} catch (err) {
				if (args.signal.aborted) throw abortError();
				skipped["kline-fetch-failed"] = (skipped["kline-fetch-failed"] ?? 0) + 1;
				host.log("warn", `kline fetch failed for ${stock.fullCode}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			scanned++;
			if (scanned % 500 === 0) host.log("info", `sync progress: ${scanned}/${universe.length}, fetched ${fetchedThisRun.size}`);
		}
	};
	const queue = [...universe];
	await Promise.all(Array.from({ length: concurrency }, () => work()));
	assertHealthy(skipped, universe.length);
	host.log("info", `sync done: scanned ${scanned}, fetched ${fetchedThisRun.size} in ${((Date.now() - startedAt) / 1e3).toFixed(0)}s`);
	return {
		scanned,
		stocksFetched: fetchedThisRun.size,
		skipped,
		startDate
	};
}
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
//#region src/engine/derive.ts
/**
* Derivation of the per-stock context shared by every filter in one pass: the
* chained return index and the pre-computed limit-up days. Pure and
* parameter-independent, so it runs once per stock regardless of predicate.
* @module a-share-screener/engine/derive
*/
function derive(stock, bars) {
	if (bars.length === 0) throw new Error("derive: cannot derive context from an empty bar series");
	const idx = new Array(bars.length);
	idx[0] = 1;
	for (let i = 1; i < bars.length; i++) {
		const ret = bars[i].ret;
		idx[i] = idx[i - 1] * Math.max(1e-9, 1 + (ret === null ? 0 : ret));
	}
	const threshold = limitUpThreshold(stock.board, stock.name);
	const limitUpDays = [];
	for (let i = 0; i < bars.length; i++) {
		const ret = bars[i].ret;
		if (ret === null || ret < threshold) continue;
		const prevAvg = meanVolume(bars, i - 5, i);
		limitUpDays.push({
			index: i,
			date: bars[i].date,
			ret,
			surge: prevAvg <= 0 ? 0 : bars[i].volume / prevAvg
		});
	}
	const last = bars.length - 1;
	return {
		stock,
		bars,
		idx,
		limitUpDays,
		last,
		current: idx[last]
	};
}
//#endregion
//#region src/engine/evaluate.ts
function evaluate(predicate, ctx, filters, params, shortCircuit = false) {
	switch (predicate.kind) {
		case "filter": {
			const filter = filters.require(predicate.filter);
			const result = filter.apply(ctx, params);
			return {
				passed: result.passed,
				gates: { [filter.id]: result.passed },
				failed: result.passed ? [] : [filter.id],
				evidence: result.evidence
			};
		}
		case "not": {
			const child = evaluate(predicate.child, ctx, filters, params, shortCircuit);
			return {
				passed: !child.passed,
				gates: child.gates,
				failed: [],
				evidence: child.evidence
			};
		}
		case "and": {
			const gates = {};
			const evidence = {};
			const failed = [];
			let passed = true;
			for (const child of predicate.children) {
				const result = evaluate(child, ctx, filters, params, shortCircuit);
				Object.assign(gates, result.gates);
				Object.assign(evidence, result.evidence);
				if (!result.passed) {
					passed = false;
					failed.push(...result.failed);
					if (shortCircuit) break;
				}
			}
			return {
				passed,
				gates,
				evidence,
				failed
			};
		}
		case "or": {
			const gates = {};
			const evidence = {};
			const failed = [];
			let passed = false;
			for (const child of predicate.children) {
				const result = evaluate(child, ctx, filters, params, shortCircuit);
				Object.assign(gates, result.gates);
				Object.assign(evidence, result.evidence);
				if (result.passed) {
					passed = true;
					if (shortCircuit) break;
				} else failed.push(...result.failed);
			}
			return {
				passed,
				gates,
				evidence,
				failed: passed ? [] : failed
			};
		}
	}
}
//#endregion
//#region src/engine/compose.ts
/** Collect the leaf filter ids referenced by a predicate. */
function leafFilterIds(predicate, out) {
	switch (predicate.kind) {
		case "filter":
			out.add(predicate.filter);
			break;
		case "and":
		case "or":
			for (const child of predicate.children) leafFilterIds(child, out);
			break;
		case "not": leafFilterIds(predicate.child, out);
	}
}
/** Order-independent serialization of a param doc (key insertion order may differ). */
function stableParamDoc(doc) {
	return JSON.stringify(doc, Object.keys(doc).sort());
}
function sameDoc(a, b) {
	return stableParamDoc(a) === stableParamDoc(b);
}
/**
* Merge every referenced filter's parameter table plus strategy-level extras.
* Identical declarations (e.g. two filters sharing the same search window) are
* deduplicated; conflicting declarations on the same key fail loudly.
*/
function mergedParamDocs(predicate, filters, extra = {}) {
	const ids = /* @__PURE__ */ new Set();
	leafFilterIds(predicate, ids);
	const out = {};
	const merge = (key, doc) => {
		const existing = out[key];
		if (existing === void 0) {
			out[key] = doc;
			return;
		}
		if (!sameDoc(existing, doc)) throw new Error(`param collision '${key}': two filters declare it with different signatures`);
	};
	for (const id of ids) for (const [key, doc] of Object.entries(filters.require(id).paramDocs)) merge(key, doc);
	for (const [key, doc] of Object.entries(extra)) merge(key, doc);
	return out;
}
/** Union of the data requirements declared by every leaf filter in the tree. */
function mergedRequirements(predicate, filters) {
	const ids = /* @__PURE__ */ new Set();
	leafFilterIds(predicate, ids);
	let industry = false;
	let marketCap = false;
	let amount = false;
	for (const id of ids) {
		const filterReq = filters.require(id).requires;
		if (!filterReq) continue;
		industry = industry || filterReq.industry === true;
		marketCap = marketCap || filterReq.marketCap === true;
		amount = amount || filterReq.amount === true;
	}
	if (!industry && !marketCap && !amount) return void 0;
	const req = {};
	if (industry) req.industry = true;
	if (marketCap) req.marketCap = true;
	if (amount) req.amount = true;
	return req;
}
/** Drop null-valued evidence entries so hit evidence stays strictly typed. */
function sanitizeEvidence(evidence) {
	const out = {};
	for (const [key, value] of Object.entries(evidence)) if (value !== null) out[key] = value;
	return out;
}
/** Compose a predicate over atomic filters into a fully-featured Strategy. */
function composeStrategy(opts) {
	const paramDocs = mergedParamDocs(opts.predicate, opts.filters, opts.extraParamDocs);
	const canEvaluate = opts.canEvaluate ?? (() => true);
	const requires = mergedRequirements(opts.predicate, opts.filters);
	return {
		id: opts.id,
		description: opts.description,
		paramDocs,
		requires,
		screen(input, params) {
			if (!canEvaluate(input, params)) return null;
			const ctx = derive(input.stock, input.bars);
			ctx.industry = input.industryStats;
			const result = evaluate(opts.predicate, ctx, opts.filters, params, true);
			if (!result.passed) return null;
			const evidence = sanitizeEvidence(result.evidence);
			evidence.close = ctx.bars[ctx.last].close;
			evidence.barsAnalyzed = ctx.bars.length;
			return {
				code: input.stock.code,
				fullCode: input.stock.fullCode,
				name: input.stock.name,
				board: input.stock.board,
				strategy: opts.id,
				evidence
			};
		},
		diagnose(input, params) {
			if (!canEvaluate(input, params)) return null;
			const ctx = derive(input.stock, input.bars);
			ctx.industry = input.industryStats;
			const result = evaluate(opts.predicate, ctx, opts.filters, params, false);
			const metrics = {
				...result.evidence,
				close: ctx.bars[ctx.last].close,
				barsAnalyzed: ctx.bars.length
			};
			return {
				matched: result.passed,
				gates: result.gates,
				failedGates: result.failed,
				metrics
			};
		}
	};
}
//#endregion
//#region src/strategies/flat-base-low.ts
/**
* Strategy `flat_base_low`: bottom + flat base — the stock sits at the bottom
* of its recent price distribution while the last month consolidates flat with
* converged moving averages. No limit-up shape is required.
*
* The strategy is *composed* from two atomic filters (see `src/filters/`) via
* {@link composeStrategy}: flat_base AND low_percentile. Pair it with the
* `minListDays` / `maxListDays` universe filters to screen, e.g., stocks
* listed 1–4 years.
* @module a-share-screener/strategies/flat-base-low
*/
/** Compose the flat-base and low-percentile atomic filters into the bottom-flat strategy. */
const flatBaseLowStrategy = composeStrategy({
	id: "flat_base_low",
	description: "Bottom + flat base: the stock trades at or below a low percentile of its recent price distribution (default <= 15th percentile of the last ~3 years, clamped to available bars) while the latest month is a flat, MA-converged base (default net change <= 8%, MA5/10/20/60 spread <= 3%). No limit-up pattern is required. Combine with the universe filters minListDays / maxListDays to constrain listing age. Read the evidence fields as quantified facts, not trading signals.",
	predicate: {
		kind: "and",
		children: [{
			kind: "filter",
			filter: "low_percentile"
		}, {
			kind: "filter",
			filter: "flat_base"
		}]
	},
	filters: createFilterRegistry(),
	extraParamDocs: { minBars: {
		type: "number",
		default: 240,
		min: 60,
		max: 3e3,
		integer: true,
		description: "Minimum bar count to evaluate a stock at all (~1 trading year)."
	} },
	canEvaluate(input, params) {
		const flatWindow = params.flatWindowBars;
		return input.bars.length >= Math.max(60, params.minBars, flatWindow + 1);
	}
});
//#endregion
//#region src/strategies/low-flat-breakout.ts
/**
* Strategy `low_flat_breakout`: deep below the window high + flat base +
* volume breakout — the right-side twin of `low_flat_limit_up`. Where the
* limit-up strategy waits for a faded surge (left side, cool), this one waits
* for the base to LAUNCH: a volume-heavy close above the base high, the index
* holding out of the base since, and the MA stopped falling (right side,
* warming).
*
* Composed from four atomic filters via {@link composeStrategy}: deep_drawdown
* AND platform_breakout AND ma_stabilization AND bars_since_low. The
* bars_since_low gate keeps the breakout NEAR THE BOTTOM (window low >= 40
* bars back, price at most 50% above it): without it a stock that already
* rebounded far off its low still clears a 65%-drawdown gate. Two deliberate omissions:
* - `low_percentile` — a close above the base high sits ABOVE the entire
*   bottom-side distribution by construction, so the latest-price percentile
*   is structurally ~100% after any breakout off the bottom; the position gate
*   is `deep_drawdown` instead.
* - `flat_base` — the breakout filter measures the base immediately before
*   the breakout day, and a breakout makes the LATEST window non-flat by
*   construction.
* @module a-share-screener/strategies/low-flat-breakout
*/
/** Compose the drawdown position gate with the breakout + MA-stabilization confirmation. */
const lowFlatBreakoutStrategy = composeStrategy({
	id: "low_flat_breakout",
	description: "Deep low + near-bottom volume breakout (right-side twin of low_flat_limit_up): the stock sits deep below its window high (default >= 65% drawdown, on the chained return index) while staying near its window low (default low >= 40 bars back, price at most 50% above it), and within the last ~2 weeks a volume-heavy day (default >= 2x the prior 5-day average) closed at least 2% above the high of the preceding one-month flat base with the price holding out of the base since (default >= 2 confirming closes), while the MA20 stopped falling and the price sits at or above it. Unlike low_flat_limit_up there is no latest-price percentile gate: a breakout close above the base high sits at the top of the bottom-side distribution by construction. Read the evidence fields as quantified facts, not trading signals.",
	predicate: {
		kind: "and",
		children: [
			{
				kind: "filter",
				filter: "deep_drawdown"
			},
			{
				kind: "filter",
				filter: "bars_since_low"
			},
			{
				kind: "filter",
				filter: "platform_breakout"
			},
			{
				kind: "filter",
				filter: "ma_stabilization"
			}
		]
	},
	filters: createFilterRegistry(),
	extraParamDocs: { minBars: {
		type: "number",
		default: 240,
		min: 60,
		max: 3e3,
		integer: true,
		description: "Minimum bar count to evaluate a stock at all (~1 trading year)."
	} },
	canEvaluate(input, params) {
		const breakoutNeed = params.baseWindowBars + params.breakoutWindowBars + 6;
		const maNeed = params.maStabWindow + params.maSlopeBars;
		return input.bars.length >= Math.max(60, params.minBars, breakoutNeed, maNeed);
	}
});
//#endregion
//#region src/strategies/low-flat-limitup.ts
/**
* Strategy `low_flat_limit_up`: historical low + flat base + volume-heavy
* limit-up within roughly six months followed by a pullback on shrinking
* volume.
*
* The strategy is *composed* from five independent atomic filters (see
* `src/filters/`) via {@link composeStrategy}: deep_drawdown AND low_percentile
* AND flat_base AND volume_limit_up AND cooldown_pullback. Each filter is
* reusable on its own and combinable with others into new strategies without
* touching any screening code.
*
* All price-level conditions run on a chained return index (not raw closes),
* so ex-rights events such as splits and dividends cannot fake a crash or a
* bottom. Each condition's threshold is a validated, overridable parameter.
* @module a-share-screener/strategies/low-flat-limitup
*/
/** Compose the five shipped atomic filters into the historical-low + flat-base + limit-up strategy. */
const lowFlatLimitUpStrategy = composeStrategy({
	id: "low_flat_limit_up",
	description: "Historical low + flat base + faded volume-heavy limit-up: the stock sits deep below its window high (default >= 65% drawdown) and at the bottom of its recent price distribution (default <= 15th percentile of the last ~3 years), the last month is a flat, MA-converged base, and within the last ~6 months there was a volume-heavy limit-up day (default >= 2x the prior 5-day average volume) that pulled back below its closing price while volume cooled off (recent average <= 40% of the limit-up day). Read the evidence fields as quantified facts, not trading signals.",
	predicate: {
		kind: "and",
		children: [
			{
				kind: "filter",
				filter: "deep_drawdown"
			},
			{
				kind: "filter",
				filter: "low_percentile"
			},
			{
				kind: "filter",
				filter: "flat_base"
			},
			{
				kind: "filter",
				filter: "volume_limit_up"
			},
			{
				kind: "filter",
				filter: "cooldown_pullback"
			}
		]
	},
	filters: createFilterRegistry(),
	extraParamDocs: { minBars: {
		type: "number",
		default: 240,
		min: 60,
		max: 3e3,
		integer: true,
		description: "Minimum bar count to evaluate a stock at all."
	} },
	canEvaluate(input, params) {
		const flatWindow = params.flatWindowBars;
		return input.bars.length >= Math.max(60, params.minBars, flatWindow + 1);
	}
});
//#endregion
//#region src/strategies/index.ts
/**
* Central strategy registration: the one place a new strategy plugs in. Both
* the dsh plugin entry and the standalone CLI register through this helper, so
* adding a strategy means adding one file + one line here.
* @module a-share-screener/strategies
*/
/** Register every shipped strategy. Safe to call once per registry instance. */
function registerAll(registry) {
	registry.register(lowFlatLimitUpStrategy);
	registry.register(flatBaseLowStrategy);
	registry.register(lowFlatBreakoutStrategy);
}
//#endregion
//#region src/tool.ts
/**
* Model-facing tools: `a_share_screen` (full market scan),
* `a_share_list_strategies` (strategy discovery), and `a_share_list_filters`
* (atomic-filter discovery).
* @module a-share-screener/tool
*/
/** Ad-hoc strategy id for predicate-driven scans (rendered, not user-facing). */
const CUSTOM_ID = "custom";
/** Max nesting of { all | any | not } groups in a caller-supplied predicate. */
const MAX_PREDICATE_DEPTH = 3;
/** Max total leaf filters in a caller-supplied predicate. */
const MAX_PREDICATE_LEAVES = 12;
/** Validate and convert the JSON predicate DSL into an engine Predicate. Throws loudly. */
function toPredicate(raw, filters, depth = 0, counters = { leaves: 0 }) {
	if (typeof raw === "string") {
		filters.require(raw);
		counters.leaves++;
		if (counters.leaves > MAX_PREDICATE_LEAVES) throw new Error(`predicate uses more than ${MAX_PREDICATE_LEAVES} leaf filters`);
		return {
			kind: "filter",
			filter: raw
		};
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("predicate node must be a filter id (string) or a group object { all | any | not }");
	if (depth >= MAX_PREDICATE_DEPTH) throw new Error(`predicate groups nest deeper than ${MAX_PREDICATE_DEPTH} levels`);
	const group = raw;
	const provided = [
		"all",
		"any",
		"not"
	].filter((key) => group[key] !== void 0);
	if (provided.length === 0) throw new Error("predicate group must contain exactly one of 'all', 'any', 'not'");
	if (provided.length > 1) throw new Error(`predicate group must contain only ONE of 'all'/'any'/'not', got ${provided.join("+")}`);
	const key = provided[0];
	if (key === "not") return {
		kind: "not",
		child: toPredicate(group.not, filters, depth + 1, counters)
	};
	const kind = key === "all" ? "and" : "or";
	const list = group[key];
	if (!Array.isArray(list) || list.length === 0) throw new Error(`predicate '${key}' must be a non-empty array of nodes`);
	return {
		kind,
		children: list.map((child) => toPredicate(child, filters, depth + 1, counters))
	};
}
/** One-line summary of a DSL predicate for display, e.g. "a AND b OR c". */
function summarizePredicate(raw) {
	if (typeof raw === "string") return raw;
	if (raw === null || typeof raw !== "object") return "?";
	const group = raw;
	if (group.not !== void 0) return `NOT(${summarizePredicate(group.not)})`;
	if (group.all !== void 0) return group.all.map(summarizePredicate).join(" AND ");
	if (group.any !== void 0) return group.any.map(summarizePredicate).join(" OR ");
	return "?";
}
/**
* Build the throwaway registry holding the ad-hoc custom strategy for a
* predicate scan. Parameters resolve against the merged filter param docs
* exactly like a shipped strategy, so `params` overrides work unchanged.
* `summary` is the human-readable rendering of the RAW DSL (the engine
* Predicate has no all/any/not shape to summarize).
*/
function customRegistry(deps, predicate, summary) {
	const strategy = composeStrategy({
		id: CUSTOM_ID,
		description: `Ad-hoc composition: ${summary}`,
		predicate,
		filters: deps.filters,
		extraParamDocs: { minBars: {
			type: "number",
			default: 240,
			min: 60,
			max: 3e3,
			integer: true,
			description: "Minimum bar count to evaluate a stock at all (~1 trading year)."
		} },
		canEvaluate: (input, params) => input.bars.length >= Math.max(60, params.minBars)
	});
	const registry = new StrategyRegistry();
	registry.register(strategy);
	return registry;
}
/** Human/model-readable text report from a canonical scan result. */
function renderReport(value) {
	const lines = [];
	lines.push(`A-share screening — strategy ${value.strategy} (${value.dataSource})`);
	lines.push(`Scanned ${value.scanned} stocks, matched ${value.matched} in ${(value.durationMs / 1e3).toFixed(0)}s (bar files fetched this run: ${value.stocksFetched}).`);
	if (value.candidates.length > 0) {
		if (value.strategy === "low_flat_limit_up") {
			lines.push("");
			lines.push("code     name             board    limit-up   surge   cooldown  cool-ref    days  close");
			for (const hit of value.candidates) {
				const evidence = hit.evidence;
				lines.push(`${hit.code}  ${hit.name.padEnd(12).slice(0, 12)}  ${hit.board.padEnd(7)}  ${String(evidence.limitUpDate ?? "-")}  ${String(evidence.limitUpVolumeSurge ?? "-").padStart(4)}x  ${String(evidence.cooldownVolumeRatio ?? "-").padStart(7)}  ${String(evidence.cooldownRefDate ?? "-")}  ${String(evidence.daysSinceLimitUp ?? "-").padStart(4)}  ${evidence.close ?? "-"}`);
			}
			lines.push("");
			lines.push("limit-up/surge cite the most recent volume-heavy limit-up day; cooldown/cool-ref/days cite the day that also satisfies the pullback+cooldown pattern — the two may differ when only an older day qualifies. Each candidate carries full evidence fields (drawdown, percentile, flat metrics) in its result entry.");
		} else {
			const evidenceKeys = [];
			for (const hit of value.candidates) for (const key of Object.keys(hit.evidence)) if (key !== "close" && !evidenceKeys.includes(key)) evidenceKeys.push(key);
			const header = [
				"code",
				"name",
				"board",
				...evidenceKeys,
				"close"
			];
			lines.push("");
			lines.push(header.map((h, i) => i === 0 ? h.padEnd(9) : h.padEnd(h.length + 2)).join(""));
			for (const hit of value.candidates) {
				const evidence = hit.evidence;
				const cells = [
					hit.code,
					hit.name.slice(0, 12),
					hit.board,
					...evidenceKeys.map((key) => String(evidence[key] ?? "-")),
					String(evidence.close ?? "-")
				];
				lines.push(cells.map((c, i) => i === 0 ? c.padEnd(9) : c.padEnd(String(header[i]).length + 2)).join(""));
			}
			lines.push("");
			lines.push("Each candidate carries the full evidence fields of its atomic filters in its result entry.");
		}
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
		description: "Screen all A-share stocks with a registered technical strategy and return matched candidates with quantified evidence (drawdown, percentile, flatness, limit-up date, volume ratios). Check a_share_list_strategies first for available strategy ids and their parameters; check a_share_list_filters for the composable atomic filters. Alternatively pass 'predicate' (JSON: { \"all\": [...] } / { \"any\": [...] } / { \"not\": ... } over filter ids, max depth 3) to compose an ad-hoc screen without a registered strategy — 'params' then tunes that composition. The scan reads a local disk cache: the first full scan downloads history bar-by-bar and can take many minutes; later scans are fast. Results are technical screening of historical patterns, NOT investment advice.",
		parameters: {
			strategy: {
				type: "string",
				enum: strategyIds,
				description: `Screening strategy id. Available: ${strategyIds.join(", ")}. Mutually exclusive with 'predicate'.`
			},
			predicate: {
				type: "object",
				additionalProperties: true,
				description: "Ad-hoc predicate over atomic filter ids instead of a registered strategy: e.g. {\"all\": [\"deep_drawdown\", {\"any\": [\"platform_breakout\", \"volume_limit_up\"]}]}. Groups are { all } (AND), { any } (OR), { not } (NOT); leaves are filter ids from a_share_list_filters. Max depth 3, max 12 leaves. Mutually exclusive with \"strategy\"."
			},
			params: {
				type: "object",
				additionalProperties: true,
				description: "Optional overrides for the strategy (or predicate composition) parameter defaults — see a_share_list_strategies / a_share_list_filters. Unknown keys or out-of-range values are rejected with the valid set listed."
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
			const hasStrategy = typeof args.strategy === "string" && args.strategy !== "";
			const hasPredicate = args.predicate !== void 0;
			if (hasStrategy && hasPredicate) throw new Error("'strategy' and 'predicate' are mutually exclusive — pass exactly one.");
			if (!hasStrategy && !hasPredicate) throw new Error(`pass either 'strategy' (one of ${strategyIds.join(", ")}) or 'predicate'.`);
			let registry = deps.registry;
			let strategyId = args.strategy;
			let title;
			if (hasPredicate) {
				registry = customRegistry(deps, toPredicate(args.predicate, deps.filters), summarizePredicate(args.predicate));
				strategyId = CUSTOM_ID;
				title = `custom(${summarizePredicate(args.predicate)})`;
			}
			const result = await runScreen(deps.host, deps.config, deps.dataSource, registry, {
				strategyId,
				params: args.params === void 0 ? void 0 : args.params,
				refresh: args.refresh ?? false,
				signal: exec.signal
			});
			return title === void 0 ? result : {
				...result,
				notes: [...result.notes, `predicate: ${title}`]
			};
		},
		presentCall: (args) => ({
			card: "generic",
			title: `A-share screening: ${args.strategy ?? "custom predicate"}`,
			kind: "search"
		}),
		presentResult: (args) => ({
			card: "generic",
			title: `A-share screening done: ${args.strategy ?? "custom predicate"}`
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
/** Atomic-filter discovery tool: the composable conditions strategies are built from. */
function createListFiltersTool(deps) {
	return defineTool({
		name: "a_share_list_filters",
		description: "List the available atomic A-share screening filters (composable conditions such as deep drawdown, low percentile, flat base, volume limit-up, and cooldown pullback) with their descriptions, parameters, defaults, and valid ranges. Strategies are built by combining these filters.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { filters: {
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
				text: JSON.stringify(value.filters, null, 2)
			}]
		},
		async execute() {
			return { filters: deps.filters.list().map((filter) => ({
				id: filter.id,
				description: filter.description,
				params: filter.paramDocs,
				...filter.requires?.industry ? { requiresIndustry: true } : {},
				...filter.requires?.marketCap ? { requiresMarketCap: true } : {},
				...filter.requires?.amount ? { requiresAmount: true } : {}
			})) };
		},
		presentCall: () => ({
			card: "generic",
			title: "List A-share screening filters"
		})
	});
}
//#endregion
export { fetchJson as S, barsToSeries as _, registerAll as a, RateLimiter as b, acquireBarsFile as c, filterByCodes as d, historyStartDate as f, createDataSource as g, createFilterRegistry as h, toPredicate as i, aggregateIndustries as l, syncBars as m, createListStrategiesTool as n, composeStrategy as o, prepareUniverse as p, createScreenTool as r, StrategyRegistry as s, createListFiltersTool as t, assertCapabilities as u, fromBarTuple as v, abortError as x, ymd as y };
