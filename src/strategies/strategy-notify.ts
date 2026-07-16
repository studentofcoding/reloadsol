import type { StrategyNotifyConfig } from './types'

export type StrategyNotifyFlags = {
  telegram: boolean
  ui: boolean
}

/** Defaults both on when unset (backward compatible). */
export function readNotifyFlags(
  notify?: StrategyNotifyConfig | null,
): StrategyNotifyFlags {
  return {
    telegram: notify?.telegram ?? true,
    ui: notify?.ui ?? true,
  }
}

export function mergeNotifyConfig(
  base?: StrategyNotifyConfig | null,
  override?: StrategyNotifyConfig | null,
): StrategyNotifyConfig | undefined {
  if (!base && !override) return undefined
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  }
}

/** Payload when Activate/Deactivate syncs notify with is_active. */
export function notifySyncForActive(isActive: boolean): StrategyNotifyConfig {
  return { telegram: isActive, ui: isActive }
}
