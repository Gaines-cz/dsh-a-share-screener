import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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
		capabilities: { industry: false },
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
		capabilities: { industry: false },
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
		stocksCache = {
			fetchedAt: today,
			stocks: await dataSource.listStocks(signal)
		};
		await writeJson(stocksFile, stocksCache);
	} catch (err) {
		if (signal.aborted) throw err;
		if (stocksCache === void 0) throw err;
		warn(`stock list fetch failed (${err instanceof Error ? err.message : String(err)}); using cached list from ${stocksCache.fetchedAt ?? "unknown date"}`);
	}
	const skipped = {};
	const skip = (reason) => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};
	const minListDate = dateMinusDays(today, config.minListDays);
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
/** Run one full screening pass. Throws loud, actionable errors on bad input. */
async function runScreen(host, config, dataSource, registry, args) {
	const startedAt = Date.now();
	const strategy = registry.get(args.strategyId);
	if (!strategy) throw new Error(`unknown strategy '${args.strategyId}'. Available: ${registry.ids().join(", ")}`);
	const params = registry.resolveParams(args.strategyId, args.params);
	const { stocks: filtered, skipped, today } = await prepareUniverse(config, dataSource, args.signal, args.refresh ?? false, (m) => host.log("warn", m));
	const universe = filterByCodes(filtered, args.codes, skipped);
	host.log("info", `universe after filters: ${universe.length} (skipped ${JSON.stringify(skipped)})`);
	const startDate = historyStartDate(config.historyBars);
	const fetchedThisRun = /* @__PURE__ */ new Set();
	const candidates = [];
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
			bars: series
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
		notes: [],
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
/**
* Evaluate every gate and collect the quantified metrics behind them, so both
* `screen` (strict match) and `diagnose` (tiered report) share one
* implementation. Returns null when the stock cannot be evaluated at all (too
* few bars / flat window unavailable).
*/
function evaluateLowFlatLimitUp(input, params) {
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
	const gateDrawdown = drawdown >= params.minDrawdownFromHigh;
	const pw = Math.min(params.percentileWindowBars, bars.length);
	let below = 0;
	for (let i = bars.length - pw; i < bars.length; i++) if (idx[i] <= current) below++;
	const percentile = below / pw;
	const gatePercentile = percentile <= params.maxPercentile;
	const fw = params.flatWindowBars;
	if (last < fw) return null;
	const netChange = Math.abs(current / idx[last - fw] - 1);
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
	const gateFlat = netChange <= params.maxFlatRangeChange && maSpread <= params.maxFlatMaSpread;
	const threshold = limitUpThreshold(input.stock.board, input.stock.name);
	const cooldownBars = params.cooldownBars;
	const minGap = cooldownBars + 1;
	const firstCandidate = Math.max(5, last - params.limitUpWindowBars);
	let limitUp = null;
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
		limitUp = {
			date: bars[d].date,
			pct: ret,
			surge: bars[d].volume / prevAvg,
			cooldownRatio: cooldownAvg / bars[d].volume,
			daysSince: last - d
		};
		break;
	}
	const gates = {
		drawdown: gateDrawdown,
		percentile: gatePercentile,
		flat: gateFlat,
		limitUp: limitUp !== null
	};
	const failedGates = Object.entries(gates).filter(([, pass]) => !pass).map(([name]) => name);
	const metrics = {
		close: bars[last].close,
		drawdownFromHigh: round(drawdown, 4),
		percentileInWindow: round(percentile, 4),
		flatNetChange: round(netChange, 4),
		flatMaSpread: round(maSpread, 4),
		limitUpDate: limitUp?.date ?? null,
		limitUpPct: limitUp === null ? null : round(limitUp.pct, 4),
		limitUpVolumeSurge: limitUp === null ? null : round(limitUp.surge, 2),
		cooldownVolumeRatio: limitUp === null ? null : round(limitUp.cooldownRatio, 4),
		daysSinceLimitUp: limitUp?.daysSince ?? null,
		barsAnalyzed: bars.length
	};
	return {
		ok: failedGates.length === 0,
		gates,
		failedGates,
		metrics
	};
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
		const ev = evaluateLowFlatLimitUp(input, params);
		if (ev === null || !ev.ok) return null;
		return {
			code: input.stock.code,
			fullCode: input.stock.fullCode,
			name: input.stock.name,
			board: input.stock.board,
			strategy: lowFlatLimitUpStrategy.id,
			evidence: ev.metrics
		};
	},
	diagnose(input, params) {
		const ev = evaluateLowFlatLimitUp(input, params);
		if (ev === null) return null;
		return {
			matched: ev.ok,
			gates: ev.gates,
			failedGates: ev.failedGates,
			metrics: ev.metrics
		};
	}
};
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
}
//#endregion
export { historyStartDate as a, syncBars as c, fromBarTuple as d, ymd as f, filterByCodes as i, createDataSource as l, fetchJson as m, StrategyRegistry as n, prepareUniverse as o, RateLimiter as p, acquireBarsFile as r, runScreen as s, registerAll as t, barsToSeries as u };
