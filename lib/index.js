import { a as registerAll, b as RateLimiter, g as createDataSource, h as createFilterRegistry, n as createListStrategiesTool, r as createScreenTool, s as StrategyRegistry, t as createListFiltersTool } from "./tool-DvbkOihj.js";
import Schema from "@deepseek-ai/schemastery";
//#region src/index.ts
const name = "a-share-screener";
const inject = ["tools"];
const Config = Schema.object({
	cacheDir: Schema.string(),
	dataSource: Schema.union([
		"sina",
		"eastmoney",
		"tencent"
	]).default("sina"),
	requestsPerMinute: Schema.number().min(30).max(1e3).default(200),
	historyBars: Schema.number().min(250).max(3e3).default(800),
	excludeST: Schema.boolean().default(true),
	excludeBSE: Schema.boolean().default(true),
	minListDays: Schema.number().min(0).max(5e3).default(365),
	maxListDays: Schema.number().min(0).max(1e4).default(0),
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
	registerAll(registry);
	const filters = createFilterRegistry();
	const deps = {
		host: { log: (level, message) => log(ctx, level, message) },
		config,
		dataSource: createDataSource(config.dataSource, new RateLimiter(config.requestsPerMinute)),
		registry,
		filters
	};
	ctx.tools.register(createListStrategiesTool(deps));
	ctx.tools.register(createListFiltersTool(deps));
	ctx.tools.register(createScreenTool(deps));
}
//#endregion
export { Config, apply, inject, name };
