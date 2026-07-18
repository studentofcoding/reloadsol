import { getAppLocalDayName, getAppLocalWeekday } from '@/utils/datetime'
import { loadStrategyDefinitionRows } from './db'
import { mergeFiltersUnion, mergeStrategyOverride } from './merge'
import { TRENDING_BOT_STRATEGIES } from './registry'
import type {
  ActiveStrategiesResult,
  ExecutionMode,
  TokenFilterConfig,
  TrendingBotStrategy,
} from './types'

let cachedRegistry: Record<string, TrendingBotStrategy> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

function getDayTypeInfo() {
  const now = new Date()
  const dayOfWeek = getAppLocalWeekday(now)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
  const dayName = getAppLocalDayName(now)
  return {
    isWeekend,
    dayType: isWeekend ? ('weekend' as const) : ('weekday' as const),
    dayName,
  }
}

export function validateStrategyConfig(config: TrendingBotStrategy): boolean {
  if (
    config.take_profit_levels.tp1_percentage < 5 ||
    config.take_profit_levels.tp1_percentage > 1000
  ) {
    return false
  }
  if (
    config.take_profit_levels.tp1_sell_percentage < 10 ||
    config.take_profit_levels.tp1_sell_percentage > 100
  ) {
    return false
  }
  if (config.stop_loss_percentage > -5 || config.stop_loss_percentage < -90) {
    return false
  }
  if (config.max_hold_hours < 1 || config.max_hold_hours > 720) {
    return false
  }
  return true
}

export async function getMergedTrendingBotRegistry(): Promise<
  Record<string, TrendingBotStrategy>
> {
  const now = Date.now()
  if (cachedRegistry && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedRegistry
  }

  const rows = await loadStrategyDefinitionRows('trending_bot')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const merged: Record<string, TrendingBotStrategy> = {}

  for (const [id, base] of Object.entries(TRENDING_BOT_STRATEGIES)) {
    const row = byId.get(id)
    merged[id] = mergeStrategyOverride(
      base,
      row?.config,
      row?.is_active ?? null,
    )
    if (row?.name) merged[id].name = row.name
    if (row?.description) merged[id].description = row.description ?? base.description
    if (row?.execution_mode) merged[id].execution_mode = row.execution_mode
  }

  cachedRegistry = merged
  cacheLoadedAt = now
  return merged
}

export function invalidateStrategyCache(): void {
  cachedRegistry = null
  cacheLoadedAt = 0
}

export function isStrategyActive(
  strategyId: string,
  registry: Record<string, TrendingBotStrategy>,
): boolean {
  const strategy = registry[strategyId]
  if (!strategy) {
    console.warn(`Strategy '${strategyId}' not found`)
    return false
  }

  const envKey = `STRATEGY_ACTIVE_${strategyId.toUpperCase()}`
  const envValue = process.env[envKey]
  if (envValue !== undefined) {
    return envValue.toLowerCase() === 'true'
  }

  const globalEnabled = process.env.STRATEGIES_ENABLED
  if (globalEnabled !== undefined && globalEnabled.toLowerCase() !== 'true') {
    return false
  }

  const dayTypeInfo = getDayTypeInfo()
  const dayTypeEnvKey = `STRATEGY_ACTIVE_${dayTypeInfo.dayType.toUpperCase()}_${strategyId.toUpperCase()}`
  const dayTypeEnvValue = process.env[dayTypeEnvKey]
  if (dayTypeEnvValue !== undefined) {
    return dayTypeEnvValue.toLowerCase() === 'true'
  }

  const globalDayTypeEnvKey = `STRATEGIES_${dayTypeInfo.dayType.toUpperCase()}_ENABLED`
  const globalDayTypeEnvValue = process.env[globalDayTypeEnvKey]
  if (
    globalDayTypeEnvValue !== undefined &&
    globalDayTypeEnvValue.toLowerCase() !== 'true'
  ) {
    return false
  }

  return strategy.is_active
}

export async function getActiveStrategiesWithState(): Promise<ActiveStrategiesResult> {
  const registry = await getMergedTrendingBotRegistry()

  const activeStrategyIds = Object.keys(registry).filter((strategyId) =>
    isStrategyActive(strategyId, registry),
  )

  const envStrategies =
    process.env.ACTIVE_STRATEGIES ||
    process.env.BOT_STRATEGY ||
    process.env.TRADING_STRATEGY

  let finalActiveStrategies = activeStrategyIds

  if (envStrategies) {
    const envStrategyList = envStrategies
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    finalActiveStrategies = activeStrategyIds.filter((id) =>
      envStrategyList.includes(id),
    )
  }

  // ponytail: empty active = no trending entries (no silent 'att' force)
  if (finalActiveStrategies.length === 0) {
    console.warn('No active trending strategies — skipping new entries')
  }

  const activeConfigs: Record<string, TrendingBotStrategy> = {}
  finalActiveStrategies.forEach((strategyId) => {
    if (registry[strategyId]) {
      activeConfigs[strategyId] = registry[strategyId]
    }
  })

  const allocationEnv = process.env.STRATEGY_ALLOCATION || ''
  const allocation: Record<string, number> = {}

  if (allocationEnv) {
    const allocPairs = allocationEnv.split(',').map((s) => s.trim())
    let totalAllocation = 0

    for (const pair of allocPairs) {
      const [strategyId, percentStr] = pair.split(':')
      const percent = parseFloat(percentStr)

      if (
        finalActiveStrategies.includes(strategyId) &&
        !Number.isNaN(percent) &&
        percent > 0
      ) {
        allocation[strategyId] = percent
        totalAllocation += percent
      }
    }

    if (totalAllocation > 0) {
      for (const strategyId of finalActiveStrategies) {
        if (allocation[strategyId]) {
          allocation[strategyId] /= totalAllocation
        }
      }
    }
  }

  if (Object.keys(allocation).length === 0 && finalActiveStrategies.length > 0) {
    const equalShare = 1.0 / finalActiveStrategies.length
    finalActiveStrategies.forEach((strategyId) => {
      allocation[strategyId] = equalShare
    })
  }

  const defRows = await loadStrategyDefinitionRows('trending_bot')
  const defById = new Map(defRows.map((r) => [r.id, r]))
  const executionModes: Record<string, ExecutionMode> = {}
  for (const strategyId of finalActiveStrategies) {
    executionModes[strategyId] =
      defById.get(strategyId)?.execution_mode ??
      registry[strategyId]?.execution_mode ??
      'sim_only'
  }

  return {
    strategies: finalActiveStrategies,
    configs: activeConfigs,
    allocation,
    executionModes,
  }
}

export async function getTradingStrategy(
  strategyId?: string,
): Promise<TrendingBotStrategy> {
  const registry = await getMergedTrendingBotRegistry()
  const selectedId = strategyId || process.env.DEFAULT_TRADING_STRATEGY || 'att'
  const strategy = registry[selectedId]

  if (!strategy) {
    console.warn(`Unknown trading strategy '${selectedId}', falling back to 'att'`)
    return registry.att
  }

  if (!validateStrategyConfig(strategy)) {
    console.error(`Invalid strategy configuration for '${selectedId}', falling back to 'att'`)
    return registry.att
  }

  return strategy
}

export async function getStrategyStatusSummary(): Promise<{
  is_active: string[]
  is_inactive: string[]
  total: number
}> {
  const registry = await getMergedTrendingBotRegistry()
  const allStrategies = Object.keys(registry)
  const activeStrategies: string[] = []
  const inactiveStrategies: string[] = []

  allStrategies.forEach((strategyId) => {
    if (isStrategyActive(strategyId, registry)) {
      activeStrategies.push(strategyId)
    } else {
      inactiveStrategies.push(strategyId)
    }
  })

  return {
    is_active: activeStrategies,
    is_inactive: inactiveStrategies,
    total: allStrategies.length,
  }
}

export async function getCurrentBotStrategy(): Promise<string> {
  const { strategies } = await getActiveStrategiesWithState()
  return strategies[0] || process.env.DEFAULT_TRADING_STRATEGY || 'att'
}

export async function getUnionFilterForActiveStrategies(): Promise<{
  filterConfig: TokenFilterConfig
  activeStrategyIds: string[]
}> {
  const { strategies, configs } = await getActiveStrategiesWithState()
  return {
    filterConfig: mergeFiltersUnion(configs),
    activeStrategyIds: strategies,
  }
}

let syncRegistry: Record<string, TrendingBotStrategy> = {
  ...TRENDING_BOT_STRATEGIES,
}
let syncActiveState: ActiveStrategiesResult | null = null

/** Load merged registry + active set once per track POST (sync helpers below). */
export async function refreshTrackStrategyCache(): Promise<void> {
  invalidateStrategyCache()
  syncRegistry = await getMergedTrendingBotRegistry()
  syncActiveState = await getActiveStrategiesWithState()
}

export function getTrackStrategyRegistry(): Record<string, TrendingBotStrategy> {
  return syncRegistry
}

export function resolveTradingStrategy(strategyId?: string): TrendingBotStrategy {
  const selectedId = strategyId || process.env.DEFAULT_TRADING_STRATEGY || 'att'
  const strategy = syncRegistry[selectedId]
  if (!strategy) {
    return syncRegistry.att
  }
  if (!validateStrategyConfig(strategy)) {
    return syncRegistry.att
  }
  return strategy
}

export function getActiveStrategiesSync(): ActiveStrategiesResult {
  if (syncActiveState) {
    return syncActiveState
  }
  const ids = Object.keys(syncRegistry).filter((id) =>
    isStrategyActive(id, syncRegistry),
  )
  const configs: Record<string, TrendingBotStrategy> = {}
  ids.forEach((id) => {
    if (syncRegistry[id]) configs[id] = syncRegistry[id]
  })
  const equal = ids.length > 0 ? 1 / ids.length : 0
  const allocation = Object.fromEntries(ids.map((id) => [id, equal]))
  const executionModes = Object.fromEntries(
    ids.map((id) => [id, syncRegistry[id]?.execution_mode ?? 'sim_only']),
  ) as Record<string, ExecutionMode>
  return { strategies: ids, configs, allocation, executionModes }
}

export function getCurrentBotStrategySync(): string {
  return getActiveStrategiesSync().strategies[0] || 'att'
}
