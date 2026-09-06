import { fetchTradingRecordsForWallet } from '@/strategies/db'
import {
  recordGmgnOutcome,
  recordMcapTrackerOutcome,
  recordSignalsOutcome,
  recordSocialOutcome,
} from '@/strategies/outcomes'
import { mergeEntryFeaturesForOutcome } from '@/strategies/entry-feature-snapshot'
import { ensureCompleteBuyFeaturesForOutcome } from '@/strategies/resolve-entry-snapshot'
import {
  GMGN_SIM_WALLET,
  MCAP_TRACKER_SIM_WALLET,
  SIGNALS_SIM_WALLET,
  SOCIAL_SIM_WALLET,
  simWalletForChain,
} from '@/strategies/sim-wallets'
import { computeOpenSimCycle, computeOpenTradeCycle } from '@/utils/simulation-trades'
import {
  buildTradingRecord,
  insertTradingRecord,
} from '@/utils/trading-records-db'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import { getNativeUsd } from '@/utils/native-usd'
import {
  buildMcapOutcomeFeatures,
  computeMcapSimPnlPct,
  fetchMcapTrackingRow,
  type McapSimCloseReason,
} from '@/utils/mcap-tracker'
import { getOpenMcapSimPositions } from '@/utils/mcap-sim-track'
import type { StrategyChain, StrategyDomain } from '@/strategies/types'

const CLOSE_REASON = 'strategy_deactivated' as const

type PriceDomain = 'signals' | 'gmgn' | 'social'

function walletForDomain(domain: PriceDomain, chain: StrategyChain): string {
  const base =
    domain === 'signals' ? SIGNALS_SIM_WALLET : domain === 'gmgn' ? GMGN_SIM_WALLET : SOCIAL_SIM_WALLET
  return simWalletForChain(base, chain)
}

async function recordPriceDomainOutcome(params: {
  domain: PriceDomain
  strategyId: string
  mintAddress: string
  entryAt: string | null
  pnlPct: number
  features: Record<string, unknown>
}) {
  const common = {
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct: params.pnlPct,
    status: params.pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true as const,
    features: params.features,
  }
  if (params.domain === 'signals') await recordSignalsOutcome(common)
  else if (params.domain === 'gmgn') await recordGmgnOutcome(common)
  else await recordSocialOutcome(common)
}

/** Mark-close a price-based strategy sim (signals / gmgn / social). */
export async function closePriceStrategySimPosition(params: {
  domain: PriceDomain
  chain: StrategyChain
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryFeatures: Record<string, unknown>
}): Promise<number> {
  const wallet = walletForDomain(params.domain, params.chain)
  const records = await fetchTradingRecordsForWallet(wallet)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const prices = await getOpenPositionPrices([params.mintAddress], params.chain)
  const sellPriceUsd = prices[params.mintAddress] || cycle.weightedBuyPriceUsd
  const solPrice = await getNativeUsd(params.chain)
  const remaining = cycle.remainingTokenAmount
  const solReceived =
    sellPriceUsd && solPrice > 0
      ? (remaining * sellPriceUsd) / solPrice
      : cycle.totalSolBought
  const pnlPct =
    cycle.totalSolBought > 0
      ? ((solReceived - cycle.totalSolBought) / cycle.totalSolBought) * 100
      : 0

  await insertTradingRecord(
    buildTradingRecord({
      walletAddress: wallet,
      operationType: 'sell',
      is_simulation: true,
      simulation_type: 'strategy',
      bot_strategy: params.strategyId,
      close_position: true,
      tokens: [
        {
          mintAddress: params.mintAddress,
          symbol: params.symbol,
          tokenAmount: remaining,
          solAmount: solReceived,
          priceUsd: sellPriceUsd,
          solPrice,
        },
      ],
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount: solReceived,
      feesPaid: 0,
      solPriceUsd: solPrice,
      signatures: [`${params.domain}-sim-deactivate-${Date.now()}`],
      status: pnlPct >= 0 ? 'won' : 'lost',
      trading_simulation: { close_reason: CLOSE_REASON },
    }),
  )

  const buyFeatures =
    (await ensureCompleteBuyFeaturesForOutcome({
      mintAddress: params.mintAddress,
      buyFeatures: params.entryFeatures,
      domain: params.domain as StrategyDomain,
      overrides: {
        entryAt: params.entryAt,
        tokenSymbol: params.symbol,
      },
    })) ?? params.entryFeatures

  await recordPriceDomainOutcome({
    domain: params.domain,
    strategyId: params.strategyId,
    mintAddress: params.mintAddress,
    entryAt: params.entryAt,
    pnlPct,
    features: mergeEntryFeaturesForOutcome(buyFeatures, {
      token_symbol: params.symbol,
      exit_price_usd: sellPriceUsd,
      close_reason: CLOSE_REASON,
      sol_spent: cycle.totalSolBought,
      sol_received: solReceived,
      initial_price_usd:
        typeof buyFeatures.initial_price_usd === 'number'
          ? buyFeatures.initial_price_usd
          : cycle.weightedBuyPriceUsd,
    }),
  })

  return pnlPct
}

/** Mark-close mcap tracker sim opens for a strategy. */
export async function closeMcapStrategySimPositions(
  strategyId: string,
  chain: StrategyChain,
): Promise<{ closed: number; failed: Array<{ token: string; error: string }> }> {
  const failed: Array<{ token: string; error: string }> = []
  let closed = 0
  const wallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, chain)
  const records = await fetchTradingRecordsForWallet(wallet)
  const open = getOpenMcapSimPositions(records, strategyId)

  for (const pos of open) {
    try {
      const snapshot = await fetchMcapTrackingRow(pos.mintAddress)
      const cycle = computeOpenTradeCycle(records, pos.mintAddress, 'sim')
      if (!cycle) continue

      const exitMcap =
        snapshot?.current_mcap && snapshot.current_mcap > 0
          ? snapshot.current_mcap
          : pos.entryMcap
      const pnlPct = computeMcapSimPnlPct(pos.entryMcap, exitMcap)
      const solPrice = await getNativeUsd(chain)
      const sellPriceUsd = 0.000001
      const remaining = cycle.remainingTokenAmount
      const solReceived =
        sellPriceUsd && solPrice > 0
          ? (remaining * sellPriceUsd) / solPrice
          : cycle.totalSolBought * (1 + pnlPct / 100)

      await insertTradingRecord(
        buildTradingRecord({
          walletAddress: wallet,
          operationType: 'sell',
          is_simulation: true,
          simulation_type: 'strategy',
          bot_strategy: strategyId,
          close_position: true,
          tokens: [
            {
              mintAddress: pos.mintAddress,
              symbol: pos.symbol,
              tokenAmount: remaining,
              solAmount: solReceived,
              priceUsd: sellPriceUsd,
              solPrice,
            },
          ],
          successCount: 1,
          failureCount: 0,
          totalTokens: 1,
          solAmount: solReceived,
          feesPaid: 0,
          solPriceUsd: solPrice,
          signatures: [`mcap-sim-deactivate-${Date.now()}`],
          status: pnlPct >= 0 ? 'won' : 'lost',
        }),
      )

      const closeReason: McapSimCloseReason = 'strategy_deactivated'
      const closeFeatures = snapshot
        ? buildMcapOutcomeFeatures({
            snapshot,
            entryTemplate: pos.entryTemplate,
            entryMcap: pos.entryMcap,
            exitMcap,
            closeReason,
          })
        : {
            entry_mcap: pos.entryMcap,
            exit_mcap: exitMcap,
            close_reason: closeReason,
            token_symbol: pos.symbol,
          }

      await recordMcapTrackerOutcome({
        strategyId,
        tokenAddress: pos.mintAddress,
        entryAt: pos.entryAt,
        exitAt: new Date().toISOString(),
        pnlPct,
        status: pnlPct >= 0 ? 'won' : 'lost',
        isSimulated: true,
        features: mergeEntryFeaturesForOutcome(pos.entryFeatures, closeFeatures),
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
