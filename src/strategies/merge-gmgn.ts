import type { GmgnStrategy, GmgnStrategyOverride } from './types'
import { DEFAULT_GMGN_RADAR } from './registry'
import { mergeNotifyConfig } from './strategy-notify'

export function mergeGmgnStrategy(
  base: GmgnStrategy,
  override?: GmgnStrategyOverride | null,
  isActiveOverride?: boolean | null,
): GmgnStrategy {
  const o = override ?? {}
  const baseRadar = base.config.radar ?? DEFAULT_GMGN_RADAR
  const oRadar = o.radar
  const config: GmgnStrategy['config'] = {
    discovery: {
      ...base.config.discovery,
      ...(o.discovery ?? {}),
    },
    security: {
      ...base.config.security,
      ...(o.security ?? {}),
    },
    execution: {
      ...base.config.execution,
      ...(o.execution ?? {}),
    },
    exit: {
      ...base.config.exit,
      ...(o.exit ?? {}),
    },
    radar: {
      ...baseRadar,
      ...(oRadar ?? {}),
      comeback: {
        ...baseRadar.comeback,
        ...(oRadar?.comeback ?? {}),
      },
      telegram: {
        ...baseRadar.telegram,
        ...(oRadar?.telegram ?? {}),
      },
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
