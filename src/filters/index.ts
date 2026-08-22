/**
 * Central filter registration: the one place atomic filters plug in. Strategies
 * compose from these via {@link composeStrategy}; the `a_share_list_filters`
 * tool and `filters` CLI list them for discovery.
 * @module a-share-screener/filters
 */
import { FilterRegistry } from '../engine/types.js'
import { cooldownPullbackFilter } from './cooldown-pullback.js'
import { deepDrawdownFilter } from './deep-drawdown.js'
import { flatBaseFilter } from './flat-base.js'
import { lowPercentileFilter } from './low-percentile.js'
import { volumeLimitUpFilter } from './volume-limitup.js'

/** Register every shipped atomic filter. Safe to call once per registry instance. */
export function registerAllFilters(registry: FilterRegistry): void {
  registry.register(deepDrawdownFilter)
  registry.register(lowPercentileFilter)
  registry.register(flatBaseFilter)
  registry.register(volumeLimitUpFilter)
  registry.register(cooldownPullbackFilter)
}

/** Build a registry pre-loaded with every shipped filter. */
export function createFilterRegistry(): FilterRegistry {
  const registry = new FilterRegistry()
  registerAllFilters(registry)
  return registry
}
