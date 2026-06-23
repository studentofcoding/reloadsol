import { defaultAgentConfig } from '@/utils/dlmm/config'
import { loadStrategyDefinitionRows } from './db'
import { mergeDlmmStrategy } from './merge-dlmm'
import { DLMM_STRATEGY_DEFAULTS } from './registry'
import type { DlmmStrategy } from './types'

let cached: DlmmStrategy | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateDlmmStrategyCache(): void {
  cached = null
  cacheLoadedAt = 0
}

async function buildMergedDlmmStrategy(): Promise<DlmmStrategy> {
  const envDefaults = defaultAgentConfig()
  const base: DlmmStrategy = {
    ...DLMM_STRATEGY_DEFAULTS,
    config: {
      ...DLMM_STRATEGY_DEFAULTS.config,
      min_tvl: envDefaults.min_tvl,
      min_fee_tvl: envDefaults.min_fee_tvl,
      min_organic_score: envDefaults.min_organic_score,
      min_holders: envDefaults.min_holders,
      take_profit_pct: envDefaults.take_profit_pct,
      stop_loss_pct: envDefaults.stop_loss_pct,
      oor_timeout_min: envDefaults.oor_timeout_min,
      max_sol_per_position: envDefaults.max_sol_per_position,
      max_sol_at_risk: envDefaults.max_sol_at_risk,
      bin_range_interval: envDefaults.bin_range_interval,
    },
  }

  const rows = await loadStrategyDefinitionRows('dlmm')
  const row = rows.find((r) => r.id === 'dlmm_default')
  const merged = mergeDlmmStrategy(
    base,
    row?.config as import('./types').DlmmStrategyOverride,
    row?.is_active ?? null,
  )
  if (row?.name) merged.name = row.name
  if (row?.description) merged.description = row.description ?? base.description
  if (row?.execution_mode) merged.execution_mode = row.execution_mode

  return merged
}

export async function getMergedDlmmStrategy(): Promise<DlmmStrategy> {
  const now = Date.now()
  if (cached && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cached
  }

  cached = await buildMergedDlmmStrategy()
  cacheLoadedAt = now
  return cached
}

export async function getActiveDlmmForSim(): Promise<DlmmStrategy | null> {
  const strategy = await getMergedDlmmStrategy()
  if (!strategy.is_active) return null
  if (
    strategy.execution_mode !== 'sim_only' &&
    strategy.execution_mode !== 'ab_parallel'
  ) {
    return null
  }
  return strategy
}
