import { l as createDataSource, n as StrategyRegistry, p as RateLimiter, s as runScreen, t as registerAll } from "./strategies-BsJN1qIM.js";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
	const deps = {
		host: { log: (level, message) => log(ctx, level, message) },
		config,
		dataSource: createDataSource(config.dataSource, new RateLimiter(config.requestsPerMinute)),
		registry
	};
	ctx.tools.register(createListStrategiesTool(deps));
	ctx.tools.register(createScreenTool(deps));
}
//#endregion
export { Config, apply, inject, name };
