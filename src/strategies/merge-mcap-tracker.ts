import type { McapTrackerStrategy, McapTrackerStrategyOverride } from './types'

export function mergeMcapTrackerStrategy(
  base: McapTrackerStrategy,
  override?: McapTrackerStrategyOverride | null,
  isActiveOverride?: boolean | null,
): McapTrackerStrategy {
  const o = override ?? {}
  return {
    ...base,
    is_active: isActiveOverride ?? base.is_active,
    config: {
      entryTemplate: o.entryTemplate ?? base.config.entryTemplate,
      query: {
        ...base.config.query,
        ...(o.query ?? {}),
      },
      execution: {
        ...base.config.execution,
        ...(o.execution ?? {}),
      },
    },
  }
}
