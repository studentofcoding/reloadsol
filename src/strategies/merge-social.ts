import type { SocialStrategy, SocialStrategyOverride } from './types'
import { mergeNotifyConfig } from './strategy-notify'

export function mergeSocialStrategy(
  base: SocialStrategy,
  override?: SocialStrategyOverride | null,
  isActiveOverride?: boolean | null,
): SocialStrategy {
  const o = override ?? {}
  const config: SocialStrategy['config'] = {
    entry: {
      ...base.config.entry,
      ...(o.entry ?? {}),
    },
    execution: {
      ...base.config.execution,
      ...(o.execution ?? {}),
    },
    exit: {
      ...base.config.exit,
      ...(o.exit ?? {}),
    },
  }

  const notify = mergeNotifyConfig(base.config.notify, o.notify)
  if (notify) config.notify = notify

  return {
    ...base,
    is_active: isActiveOverride ?? base.is_active,
    config,
  }
}
