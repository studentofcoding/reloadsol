import type { StrategyDomain } from './types'
import {
  DLMM_STRATEGY_DEFAULTS,
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
    case 'dlmm':
      return DLMM_STRATEGY_DEFAULTS.name
    default:
      return strategyId
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

export function notifyStrategyOpen(params: {
  domain: StrategyDomain
  strategyId: string
  tokenSymbol: string
  tokenAddress: string
  marketCap?: number | null
  isSimulated: boolean
}): void {
  void sendStrategyTrackOpenAlert({
    strategyId: params.strategyId,
    strategyName: resolveStrategyDisplayName(params.domain, params.strategyId),
    domain: params.domain,
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    marketCap: params.marketCap,
    isSimulated: params.isSimulated,
  }).catch((err) => {
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
}): void {
  const symbol =
    params.tokenSymbol?.trim() ||
    readFeatureString(params.features, 'token_symbol', 'pool_name') ||
    params.tokenAddress.slice(0, 8)

  void sendStrategyTrackCloseAlert({
    strategyId: params.strategyId,
    strategyName: resolveStrategyDisplayName(params.domain, params.strategyId),
    domain: params.domain,
    tokenSymbol: symbol,
    tokenAddress: params.tokenAddress,
    pnlPct: params.pnlPct,
    status: params.status ?? (params.pnlPct >= 0 ? 'won' : 'lost'),
    isSimulated: params.isSimulated,
  }).catch((err) => {
    console.error('[strategy-telegram] close notify failed:', err)
  })
}
