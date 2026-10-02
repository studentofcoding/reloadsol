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
import { closeOutcomeStatusFromPnl } from '@/strategies/close-outcome-status'

const CLOSE_REASON = 'strategy_deactivated' as const

/**
 * The close reasons the SL/TP worker produces, mapped onto the vocabulary the outcome rows already
 * use. `close_outcome_status` then derives won/lost from the PnL.
 */
const WORKER_CLOSE_REASONS: Record<string, string> = {
  stop_loss: 'stop_loss',
  take_profit_1: 'take_profit',
  take_profit_2: 'take_profit',
  take_profit_3: 'take_profit',
  take_profit: 'take_profit',
  max_hold_time: 'max_hold',
  max_age: 'max_age',
  label_rugged: 'label_rugged',
}

/** The close_reason an SL/TP worker trigger maps to. */
export function closeReasonForTrigger(triggerType: string): string {
  return WORKER_CLOSE_REASONS[triggerType] ?? CLOSE_REASON
}

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
    status: closeOutcomeStatusFromPnl(params.pnlPct),
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
  /**
   * Why this position is closing. Defaults to deactivation, which is what this function originally
   * served. The SL/TP worker passes `closeReasonForTrigger(trigger_type)` instead.
   */
  closeReason?: string
  /**
   * The live price the close decision was made on. Supply it when the caller has already priced the
   * position — the worker has, and re-reading would price the same tick twice.
   */
  sellPriceUsd?: number
}): Promise<number> {
  const closeReason = params.closeReason ?? CLOSE_REASON
  const wallet = walletForDomain(params.domain, params.chain)
  // Unbounded: the bound extracts JSONB paths server-side and forces Postgres to detoast every
  // row's `data` (see the mcap-tracking sim-track route for the buffer measurement). These
  // wallets are small, so the plain indexed read is cheaper.
  const records = await fetchTradingRecordsForWallet(wallet)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const prices =
    params.sellPriceUsd == null
      ? await getOpenPositionPrices([params.mintAddress], params.chain)
      : {}
  const sellPriceUsd =
    params.sellPriceUsd ?? prices[params.mintAddress] ?? cycle.weightedBuyPriceUsd
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
      signatures: [`${params.domain}-sim-${closeReason}-${Date.now()}`],
      status: closeOutcomeStatusFromPnl(pnlPct),
      trading_simulation: { close_reason: closeReason },
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
      close_reason: closeReason,
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

export type McapExitSource = 'trigger_price' | 'live_price' | 'snapshot' | 'entry_fallback'

/**
 * Where an mcap sim's exit comes from, in order of how much it can be trusted:
 *
 *  1. `trigger_price` — the price the SL/TP worker decided on. The close must book THIS tick, not a
 *     tracker snapshot that may be stale or missing.
 *  2. `live_price` — a fresh read when the caller supplied none (deactivation path).
 *  3. `snapshot` — `token_mcap_tracking.current_mcap`, with the price implied by the same growth.
 *  4. `entry_fallback` — nothing readable. Breakeven, and FLAGGED so analysis can exclude it; it used
 *     to be written silently (0% PnL at a `0.000001` placeholder price), which fabricates an outcome.
 *
 * Price and mcap are tied through the entry: `exitMcap = entryMcap × price / entryPrice` (supply is
 * constant over a sim's life), so the sell record's price and the outcome's PnL cannot disagree.
 */
export function resolveMcapExit(input: {
  entryMcap: number
  entryPriceUsd: number
  triggerPriceUsd?: number | null
  livePriceUsd?: number | null
  snapshotMcap?: number | null
}): { exitMcap: number; sellPriceUsd: number; source: McapExitSource } {
  const { entryMcap, entryPriceUsd } = input
  const ok = (v: number | null | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0
  const canMapPrice = ok(entryMcap) && ok(entryPriceUsd)

  const fromPrice = (price: number, source: 'trigger_price' | 'live_price') => ({
    exitMcap: entryMcap * (price / entryPriceUsd),
    sellPriceUsd: price,
    source,
  })
  if (canMapPrice && ok(input.triggerPriceUsd)) return fromPrice(input.triggerPriceUsd, 'trigger_price')
  if (canMapPrice && ok(input.livePriceUsd)) return fromPrice(input.livePriceUsd, 'live_price')
  if (ok(input.snapshotMcap)) {
    return {
      exitMcap: input.snapshotMcap,
      sellPriceUsd: canMapPrice ? entryPriceUsd * (input.snapshotMcap / entryMcap) : entryPriceUsd,
      source: 'snapshot',
    }
  }
  return { exitMcap: entryMcap, sellPriceUsd: entryPriceUsd, source: 'entry_fallback' }
}

/** Mark-close mcap tracker sim opens for a strategy. */
export async function closeMcapStrategySimPositions(
  strategyId: string,
  chain: StrategyChain,
  options?: {
    /** Why this is closing. Defaults to deactivation. */
    closeReason?: string
    /** Scope to one mint. Omitted closes every open mcap sim for the strategy (deactivation). */
    mintAddress?: string
    /** The trigger price the decision was made on. Omitted re-reads the live price, then the tracker snapshot. */
    sellPriceUsd?: number
  },
): Promise<{
  /**
   * Positions that are no longer open after this call: the ones this call closed PLUS the ones found
   * already closed. The SL/TP worker retires its mirror only on `closed > 0`, so counting an
   * already-closed trade here is what lets the mirror retire instead of re-evaluating a dead
   * position forever.
   */
  closed: number
  /** Of `closed`, how many were already closed before this call (nothing was written for them). */
  alreadyClosed: number
  failed: Array<{ token: string; error: string }>
}> {
  const failed: Array<{ token: string; error: string }> = []
  let closed = 0
  let alreadyClosed = 0
  const wallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, chain)
  const records = await fetchTradingRecordsForWallet(wallet)
  const allOpen = getOpenMcapSimPositions(records, strategyId)
  const open = options?.mintAddress
    ? allOpen.filter((p) => p.mintAddress === options.mintAddress)
    : allOpen

  // A mint-scoped close with nothing open for it means the trade already closed (another pass, the
  // strategy's own closer, a deactivation). Report it as closed so the caller retires the mirror;
  // it used to return `closed: 0`, which left the mirror active and re-evaluated forever.
  if (options?.mintAddress && open.length === 0) {
    return { closed: 1, alreadyClosed: 1, failed }
  }

  for (const pos of open) {
    try {
      const snapshot = await fetchMcapTrackingRow(pos.mintAddress)
      const cycle = computeOpenTradeCycle(records, pos.mintAddress, 'sim')
      if (!cycle) {
        // Open per the strategy view but no remaining cycle: already flat. Same meaning as above.
        closed++
        alreadyClosed++
        continue
      }

      // The caller's trigger price wins; only without one is the market re-read. The snapshot is the
      // last resort, and nothing readable is flagged rather than written as a silent breakeven.
      const triggerPriceUsd = options?.sellPriceUsd
      let livePriceUsd: number | null = null
      if (!(triggerPriceUsd != null && triggerPriceUsd > 0)) {
        const live: Record<string, number> = await getOpenPositionPrices(
          [pos.mintAddress],
          chain,
        ).catch(() => ({}))
        livePriceUsd = live[pos.mintAddress] ?? null
      }
      const exit = resolveMcapExit({
        entryMcap: pos.entryMcap,
        entryPriceUsd: cycle.weightedBuyPriceUsd,
        triggerPriceUsd,
        livePriceUsd,
        snapshotMcap: snapshot?.current_mcap,
      })
      const exitMcap = exit.exitMcap
      const pnlPct = computeMcapSimPnlPct(pos.entryMcap, exitMcap)
      const solPrice = await getNativeUsd(chain)
      const sellPriceUsd = exit.sellPriceUsd
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
          status: closeOutcomeStatusFromPnl(pnlPct),
        }),
      )

      const closeReason = (options?.closeReason ?? CLOSE_REASON) as McapSimCloseReason
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
      // Which input the exit was booked on; `entry_fallback` rows are placeholders, not outcomes.
      closeFeatures.exit_price_source = exit.source

      // Entry size for the shadow execution record; the writer builds it (pnlPct unchanged).
      // The real stake, not a value derived from the nominal solReceived.
      const entryCostSol = cycle.totalSolBought

      await recordMcapTrackerOutcome({
        strategyId,
        tokenAddress: pos.mintAddress,
        entryAt: pos.entryAt,
        exitAt: new Date().toISOString(),
        pnlPct,
        status: closeOutcomeStatusFromPnl(pnlPct),
        isSimulated: true,
        solAmount: entryCostSol,
        features: mergeEntryFeaturesForOutcome(pos.entryFeatures, {
          ...closeFeatures,
        }),
      })
      closed++
    } catch (err) {
      failed.push({
        token: pos.mintAddress,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { closed, alreadyClosed, failed }
}
