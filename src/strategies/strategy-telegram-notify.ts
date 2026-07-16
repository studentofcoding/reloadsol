import type { StrategyDomain } from './types'
import {
  DLMM_STRATEGY_DEFAULTS,
  GMGN_STRATEGIES,
  MCAP_TRACKER_STRATEGIES,
  SIGNALS_STRATEGIES,
  TRENDING_BOT_STRATEGIES,
} from './registry'
import {
  sendStrategyTrackCloseAlert,
  sendStrategyTrackOpenAlert,
} from '@/utils/telegram'

export function resolveStrategyDisplayName(
  domain: StrategyDomain,
  strategyId: string,
): string {
  switch (domain) {
    case 'trending_bot':
      return TRENDING_BOT_STRATEGIES[strategyId]?.name ?? strategyId
    case 'signals':
      return SIGNALS_STRATEGIES[strategyId]?.name ?? strategyId
    case 'mcap_tracker':
      return MCAP_TRACKER_STRATEGIES[strategyId]?.name ?? strategyId
    case 'gmgn':
      return GMGN_STRATEGIES[strategyId]?.name ?? strategyId
    case 'dlmm':
      return DLMM_STRATEGY_DEFAULTS.name
    default:
      return strategyId
  }
}

/** Admin `is_active` master switch for strategy position Telegram. */
export async function isStrategyActiveForTelegram(
  domain: StrategyDomain,
  strategyId: string,
): Promise<boolean> {
  switch (domain) {
    case 'signals': {
      const { getSignalsStrategy } = await import('./load-signals')
      const s = await getSignalsStrategy(strategyId)
      return s?.is_active === true
    }
    case 'mcap_tracker': {
      const { getMergedMcapTrackerRegistry } = await import('./load-mcap-tracker')
      const registry = await getMergedMcapTrackerRegistry()
      return registry[strategyId]?.is_active === true
    }
    case 'gmgn': {
      const { getMergedGmgnRegistry } = await import('./load-gmgn')
      const registry = await getMergedGmgnRegistry()
      return registry[strategyId]?.is_active === true
    }
    case 'trending_bot': {
      const { getMergedTrendingBotRegistry, isStrategyActive } = await import(
        './load-strategy'
      )
      const registry = await getMergedTrendingBotRegistry()
      return isStrategyActive(strategyId, registry)
    }
    case 'dlmm': {
      const { getMergedDlmmStrategy } = await import('./load-dlmm')
      const s = await getMergedDlmmStrategy()
      return s.is_active === true && (strategyId === s.id || strategyId === 'dlmm_default')
    }
    default: {
      const { loadStrategyDefinitionById } = await import('./db')
      const row = await loadStrategyDefinitionById(strategyId)
      return row?.is_active === true
    }
  }
}

function readFeatureString(
  features: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | null {
  if (!features) return null
  for (const key of keys) {
    const value = features[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readFeatureNumber(
  features: Record<string, unknown> | null | undefined,
  ...keys: string[]
): number | null {
  if (!features) return null
  for (const key of keys) {
    const value = features[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function telegramExtrasFromFeatures(
  features: Record<string, unknown> | null | undefined,
): {
  organicScore: number | null
  topHoldersPct: number | null
  sm: number | null
  kol: number | null
  marketCap: number | null
} {
  return {
    organicScore: readFeatureNumber(features, 'organic_score', 'organicScore'),
    topHoldersPct: readFeatureNumber(
      features,
      'top_holders_pct',
      'topHoldersPct',
      'top_holders_percentage',
    ),
    sm: readFeatureNumber(features, 'sm', 'sm_count', 'smart_money_count'),
    kol: readFeatureNumber(features, 'kol', 'kol_count'),
    marketCap: readFeatureNumber(
      features,
      'market_cap',
      'entry_mcap',
      'exit_mcap',
      'current_mcap',
    ),
  }
}

export function notifyStrategyOpen(params: {
  domain: StrategyDomain
  strategyId: string
  tokenSymbol: string
  tokenAddress: string
  marketCap?: number | null
  isSimulated: boolean
  features?: Record<string, unknown> | null
  organicScore?: number | null
  topHoldersPct?: number | null
  sm?: number | null
  kol?: number | null
}): void {
  const fromFeatures = telegramExtrasFromFeatures(params.features)
  void (async () => {
    if (!(await isStrategyActiveForTelegram(params.domain, params.strategyId))) {
      return
    }
    await sendStrategyTrackOpenAlert({
      strategyId: params.strategyId,
      strategyName: resolveStrategyDisplayName(params.domain, params.strategyId),
      domain: params.domain,
      tokenSymbol: params.tokenSymbol,
      tokenAddress: params.tokenAddress,
      marketCap: params.marketCap ?? fromFeatures.marketCap,
      isSimulated: params.isSimulated,
      organicScore: params.organicScore ?? fromFeatures.organicScore,
      topHoldersPct: params.topHoldersPct ?? fromFeatures.topHoldersPct,
      sm: params.sm ?? fromFeatures.sm,
      kol: params.kol ?? fromFeatures.kol,
    })
  })().catch((err) => {
    console.error('[strategy-telegram] open notify failed:', err)
  })
}

export function notifyStrategyClose(params: {
  domain: StrategyDomain
  strategyId: string
  tokenAddress: string
  tokenSymbol?: string | null
  pnlPct: number
  status?: string | null
  isSimulated: boolean
  features?: Record<string, unknown> | null
  marketCap?: number | null
}): void {
  const symbol =
    params.tokenSymbol?.trim() ||
    readFeatureString(params.features, 'token_symbol', 'pool_name') ||
    params.tokenAddress.slice(0, 8)
  const fromFeatures = telegramExtrasFromFeatures(params.features)

  void (async () => {
    if (!(await isStrategyActiveForTelegram(params.domain, params.strategyId))) {
      return
    }
    await sendStrategyTrackCloseAlert({
      strategyId: params.strategyId,
      strategyName: resolveStrategyDisplayName(params.domain, params.strategyId),
      domain: params.domain,
      tokenSymbol: symbol,
      tokenAddress: params.tokenAddress,
      marketCap: params.marketCap ?? fromFeatures.marketCap,
      pnlPct: params.pnlPct,
      status: params.status ?? (params.pnlPct >= 0 ? 'won' : 'lost'),
      isSimulated: params.isSimulated,
      organicScore: fromFeatures.organicScore,
      topHoldersPct: fromFeatures.topHoldersPct,
      sm: fromFeatures.sm,
      kol: fromFeatures.kol,
    })
  })().catch((err) => {
    console.error('[strategy-telegram] close notify failed:', err)
  })
}
