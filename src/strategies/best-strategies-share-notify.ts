/**
 * Telegram when a qualified “best” strategy shares/opens a mint (copy-trade),
 * with OHLC via sendTelegramOhlcPhotoOrText — not a ranking digest.
 */

import { resolveStrategyDisplayName } from './strategy-telegram-notify'
import {
  isMcapManualTradeStrategy,
  strategyLabelForManualTrade,
  type McapManualTradeStrategyId,
} from './mcap-sim-open-alerts'
import {
  isStrategyTrackTelegramEnabled,
  sendMcapSimManualTradeAlert,
} from '@/utils/telegram'

export type BestStrategyShareTelegramParams = {
  strategyId: string
  domain?: 'mcap_tracker' | string
  tokenAddress: string
  tokenSymbol: string
  entryMcap: number
  entryAt?: string | null
  liveMcap?: number | null
  organicScore?: number | null
  topHoldersPct?: number | null
  sm?: number | null
  kol?: number | null
}

/** Copy-trade Telegram + OHLC for a mint shared by a best strategy. */
export async function sendBestStrategyShareTelegram(
  params: BestStrategyShareTelegramParams,
): Promise<boolean> {
  if (!isStrategyTrackTelegramEnabled()) return false

  const strategyName = isMcapManualTradeStrategy(params.strategyId)
    ? strategyLabelForManualTrade(params.strategyId as McapManualTradeStrategyId)
    : resolveStrategyDisplayName(
        (params.domain as 'mcap_tracker') || 'mcap_tracker',
        params.strategyId,
      )

  return sendMcapSimManualTradeAlert({
    strategyId: params.strategyId,
    strategyName,
    tokenSymbol: params.tokenSymbol,
    tokenAddress: params.tokenAddress,
    entryMcap: params.entryMcap,
    entryAt: params.entryAt,
    liveMcap: params.liveMcap,
    organicScore: params.organicScore,
    topHoldersPct: params.topHoldersPct,
    sm: params.sm,
    kol: params.kol,
  })
}
