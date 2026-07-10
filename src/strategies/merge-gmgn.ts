import type { GmgnStrategy, GmgnStrategyOverride } from './types'

export function mergeGmgnStrategy(
  base: GmgnStrategy,
  override?: GmgnStrategyOverride | null,
  isActiveOverride?: boolean | null,
): GmgnStrategy {
  const o = override ?? {}
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
  }

  return {
    ...base,
    is_active: isActiveOverride ?? base.is_active,
    config,
  }
}
