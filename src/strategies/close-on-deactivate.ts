import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'
import { finalizeBotPositionClose } from '@/utils/bot-position-close'
import {
  forceCloseSLTPPositionForDeactivate,
  type SLTPPosition,
} from '@/utils/sl-tp-tracker'
import {
  isOpenTrackerPosition,
  isSimulatedTrackerPosition,
  resolveTrackerStrategyId,
} from '@/utils/trading-simulation'
import { getPositions } from '@/utils/dlmm/db'
import { removePosition } from '@/utils/dlmm/actions'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { getOpenStrategySimPositions } from '@/strategies/open-strategy-sim-positions'
import {
  closeMcapStrategySimPositions,
  closePriceStrategySimPosition,
} from '@/strategies/close-strategy-sim-position'
import {
  GMGN_SIM_WALLET,
  SIGNALS_SIM_WALLET,
  SOCIAL_SIM_WALLET,
  simWalletForChain,
} from '@/strategies/sim-wallets'
import type { StrategyChain, StrategyDomain } from '@/strategies/types'

export type CloseOnDeactivateResult = {
  closed: number
  failed: Array<{ token: string; error: string }>
}

type TrackerRow = {
  id: string
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: unknown
  status: string | null
  trading_simulation: Record<string, unknown> | null
}

function getTrackerTableName(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

async function closeTrendingOpens(
  strategyId: string,
): Promise<CloseOnDeactivateResult> {
  const failed: Array<{ token: string; error: string }> = []
  let closed = 0

  // Live SL/TP first
  try {
    const { rows } = await query<SLTPPosition>(
      `SELECT * FROM sl_tp_positions
       WHERE is_active = true AND strategy_id = $1`,
      [strategyId],
    )
    for (const pos of rows) {
      try {
        const ok = await forceCloseSLTPPositionForDeactivate(pos)
        if (ok) closed++
        else
          failed.push({
            token: pos.token_address,
            error: 'live sell failed',
          })
      } catch (err) {
        failed.push({
          token: pos.token_address,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      failed.push({
        token: '*sltp*',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Tracker sim holdings (live sells go through SL/TP above)
  try {
    const { rows } = await query<TrackerRow>(
      `SELECT id, token_address, token_symbol, token_name, logo_url,
              initial_price_usd, status, trading_simulation
       FROM ${getTrackerTableName()}
       WHERE status = 'tracking'`,
    )
    for (const row of rows) {
      if (!isOpenTrackerPosition(row)) continue
      if (resolveTrackerStrategyId(row.trading_simulation) !== strategyId) continue
      if (!isSimulatedTrackerPosition(row)) {
        failed.push({
          token: row.token_address,
          error: 'live open without SL/TP — sell manually',
        })
        continue
      }

      const sim = row.trading_simulation ?? {}
      try {
        const remaining =
          typeof sim.remaining_token_amount === 'string'
            ? sim.remaining_token_amount
            : typeof sim.remaining_token_amount === 'number'
              ? String(sim.remaining_token_amount)
              : '0'
        const buyPrice =
          typeof sim.buy_price_usd === 'number'
            ? sim.buy_price_usd
            : Number(row.initial_price_usd) || 0
        await finalizeBotPositionClose({
          tokenAddress: row.token_address,
          tokenSymbol: row.token_symbol ?? row.token_address.slice(0, 8),
          tokenName: row.token_name ?? undefined,
          logoUrl: row.logo_url ?? undefined,
          walletAddress: 'simulation',
          strategyId,
          isSimulated: true,
          sellResult: {
            success: true,
            inputAmount: remaining,
            outputAmount: '0',
          },
          sellPercentage: 100,
          currentPriceUsd: buyPrice,
          initialPriceUsd: buyPrice,
          closeReason: 'strategy_deactivated',
          isFullClose: true,
        })
        closed++
      } catch (err) {
        failed.push({
          token: row.token_address,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      failed.push({
        token: '*tracker*',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { closed, failed }
}

async function closePriceDomainOpens(
  domain: 'signals' | 'gmgn' | 'social',
  strategyId: string,
  chain: StrategyChain,
): Promise<CloseOnDeactivateResult> {
  const failed: Array<{ token: string; error: string }> = []
  let closed = 0
  const wallet = simWalletForChain(
    domain === 'signals'
      ? SIGNALS_SIM_WALLET
      : domain === 'gmgn'
        ? GMGN_SIM_WALLET
        : SOCIAL_SIM_WALLET,
    chain,
  )
  const records = await fetchTradingRecordsForWallet(wallet)
  const open = getOpenStrategySimPositions(records, strategyId)

  for (const pos of open) {
    try {
      await closePriceStrategySimPosition({
        domain,
        chain,
        strategyId,
        mintAddress: pos.mintAddress,
        symbol: pos.symbol,
        entryAt: pos.entryAt,
        entryFeatures: pos.entryFeatures,
      })
      closed++
    } catch (err) {
      failed.push({
        token: pos.mintAddress,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { closed, failed }
}

async function closeDlmmOpens(): Promise<CloseOnDeactivateResult> {
  const failed: Array<{ token: string; error: string }> = []
  let closed = 0
  const all = await getPositions()
  const open = all.filter((p) =>
    ['open', 'out_of_range', 'pending'].includes(p.status),
  )
  for (const p of open) {
    try {
      const result = await removePosition(p.id)
      if (result.success) closed++
      else
        failed.push({
          token: p.pool_address,
          error: result.error || result.message || 'remove failed',
        })
    } catch (err) {
      failed.push({
        token: p.pool_address,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { closed, failed }
}

/**
 * Close all open positions for a strategy after is_active → false.
 * Does not roll back the inactive flag on partial failure.
 */
export async function closeOpenPositionsForStrategy(params: {
  strategyId: string
  domain: StrategyDomain
  /** Sim wallets and price sources are chain-scoped; RH paper lives in `*-rh` wallets. */
  chain?: StrategyChain
}): Promise<CloseOnDeactivateResult> {
  const { strategyId, domain } = params
  const chain = params.chain ?? 'sol'

  if (domain === 'trending_bot') return closeTrendingOpens(strategyId)
  if (domain === 'mcap_tracker') return closeMcapStrategySimPositions(strategyId, chain)
  if (domain === 'signals' || domain === 'gmgn' || domain === 'social') {
    return closePriceDomainOpens(domain, strategyId, chain)
  }
  if (domain === 'dlmm') return closeDlmmOpens()

  return { closed: 0, failed: [] }
}
