import type { McapTrackerStrategy, McapTrackerStrategyOverride } from './types'
import { mergeNotifyConfig } from './strategy-notify'

export function mergeMcapTrackerStrategy(
  base: McapTrackerStrategy,
  override?: McapTrackerStrategyOverride | null,
  isActiveOverride?: boolean | null,
): McapTrackerStrategy {
  const o = override ?? {}
  const config: McapTrackerStrategy['config'] = {
    entryTemplate: o.entryTemplate ?? base.config.entryTemplate,
    query: {
      ...base.config.query,
      ...(o.query ?? {}),
    },
    execution: {
      ...base.config.execution,
      ...(o.execution ?? {}),
    },
    exit: {
      ...base.config.exit,
      ...(o.exit ?? {}),
    },
    entry: {
      ...base.config.entry,
      ...(o.entry ?? {}),
    },
  }

  if (base.config.social || o.social) {
    config.social = {
      ...(base.config.social ?? {}),
      ...(o.social ?? {}),
    }
  }

  const notify = mergeNotifyConfig(base.config.notify, o.notify)
  if (notify) config.notify = notify

  return {
    ...base,
    is_active: isActiveOverride ?? base.is_active,
    config,
  }
}
