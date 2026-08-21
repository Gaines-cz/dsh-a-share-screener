/**
 * Central strategy registration: the one place a new strategy plugs in. Both
 * the dsh plugin entry and the standalone CLI register through this helper, so
 * adding a strategy means adding one file + one line here.
 * @module a-share-screener/strategies
 */
import { lowFlatLimitUpStrategy } from './low-flat-limitup.js'
import type { StrategyRegistry } from './registry.js'

/** Register every shipped strategy. Safe to call once per registry instance. */
export function registerAll(registry: StrategyRegistry): void {
  registry.register(lowFlatLimitUpStrategy)
}
