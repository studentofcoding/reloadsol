import type { DlmmStrategy, DlmmStrategyConfig, DlmmStrategyOverride } from './types'
import { mergeNotifyConfig } from './strategy-notify'

export function mergeDlmmStrategy(
  base: DlmmStrategy,
  override?: DlmmStrategyOverride | null,
  isActiveOverride?: boolean | null,
): DlmmStrategy {
  const o = override ?? {}
  const notify = mergeNotifyConfig(base.config.notify, o.notify)
  return {
    ...base,
    is_active: isActiveOverride ?? base.is_active,
    config: {
      ...base.config,
      ...o,
      execution: {
        ...base.config.execution,
        ...o.execution,
      },
      ...(notify ? { notify } : {}),
    },
  }
}

export function dlmmConfigToAgentPatch(config: DlmmStrategyConfig): Record<string, number> {
  return {
    min_tvl: config.min_tvl,
    min_fee_tvl: config.min_fee_tvl,
    min_organic_score: config.min_organic_score,
    min_holders: config.min_holders,
    take_profit_pct: config.take_profit_pct,
    stop_loss_pct: config.stop_loss_pct,
    oor_timeout_min: config.oor_timeout_min,
    max_sol_per_position: config.max_sol_per_position,
    max_sol_at_risk: config.max_sol_at_risk,
    bin_range_interval: config.bin_range_interval,
  }
}
