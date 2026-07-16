import type { SignalsStrategy, SignalsStrategyConfig, SignalsStrategyOverride } from './types'
import { mergeNotifyConfig } from './strategy-notify'

export function mergeSignalsStrategy(
  base: SignalsStrategy,
  override?: SignalsStrategyOverride | null,
  isActiveOverride?: boolean | null,
): SignalsStrategy {
  const o = override ?? {}
  const mergedConfig: SignalsStrategyConfig = {
    template: base.config.template,
    enterScoreFloor: o.enterScoreFloor ?? base.config.enterScoreFloor,
    query: {
      ...base.config.query,
      ...(o.query ?? {}),
    },
    scoring: {
      ...base.config.scoring,
      ...(o.scoring ?? {}),
    },
    social: {
      ...(base.config.social ?? {}),
      ...(o.social ?? {}),
    },
    execution: {
      ...base.config.execution,
      ...(o.execution ?? {}),
    },
  }
  if (!base.config.social && !o.social) {
    delete (mergedConfig as { social?: unknown }).social
  }
  const notify = mergeNotifyConfig(base.config.notify, o.notify)
  if (notify) mergedConfig.notify = notify

  return {
    ...base,
    is_active: isActiveOverride ?? base.is_active,
    config: mergedConfig,
  }
}
