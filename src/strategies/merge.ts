import type {
  TokenFilterConfig,
  TrendingBotStrategy,
  TrendingBotStrategyOverride,
} from './types'
import { mergeNotifyConfig } from './strategy-notify'

function mergeFilter(
  base?: TokenFilterConfig,
  override?: Partial<TokenFilterConfig>,
): TokenFilterConfig | undefined {
  if (!base && !override) return undefined
  const b = base ?? { enabled: true }
  const o = override ?? {}
  return {
    ...b,
    ...o,
    mcap: { ...b.mcap, ...o.mcap },
    priceChange5m: { ...b.priceChange5m, ...o.priceChange5m },
    priceChange1h: { ...b.priceChange1h, ...o.priceChange1h },
    priceChange6h: { ...b.priceChange6h, ...o.priceChange6h },
    organicScore: { ...b.organicScore, ...o.organicScore },
    topHoldersPercentage: {
      ...b.topHoldersPercentage,
      ...o.topHoldersPercentage,
    },
  }
}

export function mergeStrategyOverride(
  base: TrendingBotStrategy,
  override?: TrendingBotStrategyOverride | null,
  isActiveOverride?: boolean | null,
): TrendingBotStrategy {
  if (!override && isActiveOverride == null) {
    return { ...base, take_profit_levels: { ...base.take_profit_levels } }
  }

  const o = override ?? {}
  const notify = mergeNotifyConfig(base.notify, o.notify)
  return {
    ...base,
    ...o,
    id: base.id,
    is_active: isActiveOverride ?? o.is_active ?? base.is_active,
    take_profit_levels: {
      ...base.take_profit_levels,
      ...o.take_profit_levels,
    },
    conditions: o.conditions
      ? { ...base.conditions, ...o.conditions }
      : base.conditions,
    filtering: mergeFilter(base.filtering, o.filtering),
    ...(notify ? { notify } : {}),
  }
}

export function mergeFiltersUnion(
  configs: Record<string, TrendingBotStrategy>,
): TokenFilterConfig {
  const strategies = Object.values(configs)
  if (strategies.length === 0) {
    return { enabled: true }
  }

  const filters = strategies
    .map((s) => s.filtering)
    .filter((f): f is TokenFilterConfig => !!f && f.enabled !== false)

  if (filters.length === 0) {
    return { enabled: false }
  }

  const pickMin = (vals: (number | undefined)[]) => {
    const n = vals.filter((v): v is number => v != null && !Number.isNaN(v))
    return n.length ? Math.min(...n) : undefined
  }

  const pickMax = (vals: (number | undefined)[]) => {
    const n = vals.filter((v): v is number => v != null && !Number.isNaN(v))
    return n.length ? Math.max(...n) : undefined
  }

  return {
    enabled: true,
    mcap: {
      min: pickMin(filters.map((f) => f.mcap?.min)),
      max: pickMax(filters.map((f) => f.mcap?.max)),
    },
    priceChange5m: {
      min: pickMin(filters.map((f) => f.priceChange5m?.min)),
      max: pickMax(filters.map((f) => f.priceChange5m?.max)),
    },
    priceChange1h: {
      min: pickMin(filters.map((f) => f.priceChange1h?.min)),
      max: pickMax(filters.map((f) => f.priceChange1h?.max)),
    },
    priceChange6h: {
      min: pickMin(filters.map((f) => f.priceChange6h?.min)),
      max: pickMax(filters.map((f) => f.priceChange6h?.max)),
    },
    organicScore: {
      min: pickMin(filters.map((f) => f.organicScore?.min)),
    },
    topHoldersPercentage: {
      max: pickMax(filters.map((f) => f.topHoldersPercentage?.max)),
    },
    requireCompleteData: filters.some((f) => f.requireCompleteData !== false),
    checkManualTradingHistory: filters.some(
      (f) => f.checkManualTradingHistory !== false,
    ),
  }
}
