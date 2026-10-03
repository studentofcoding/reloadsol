import { fetchTradingRecordsForWallet, hasStrategyOutcome } from '@/strategies/db'
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
import {
  computeOpenSimCycle,
  computeOpenTradeCycle,
  scopeRecordsToStrategy,
} from '@/utils/simulation-trades'
import { log } from '@/utils/unified-logger'
import type { TrackingRecord } from '@/utils/trading-tracker'
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

/** Relative + absolute slack for float noise when comparing token quantities. */
const QTY_EPSILON_REL = 1e-9
const QTY_EPSILON_ABS = 1e-6

/**
 * Invariant: a strategy never sells more of a mint than ITS OWN ledger holds.
 *
 * `ownOpenQty` is recomputed from the strategy-scoped records, independently of the cycle the sell
 * quantity came from, so a regression that reads a wallet-wide (sibling-contaminated) cycle trips
 * this instead of silently selling other strategies' tokens (the 2026-10-01..03 stall: a sibling
 * sell removed 3-4 strategies' tokens in one record). Returns false and logs at ERROR level; the
 * caller refuses the sell. It never throws, so a violation cannot take down a cron loop.
 */
export function sellQtyWithinOwnOpenQty(params: {
  strategyId: string
  mintAddress: string
  sellQty: number
  ownOpenQty: number
}): boolean {
  const { strategyId, mintAddress, sellQty, ownOpenQty } = params
  const limit = ownOpenQty * (1 + QTY_EPSILON_REL) + QTY_EPSILON_ABS
  if (Number.isFinite(sellQty) && Number.isFinite(ownOpenQty) && sellQty <= limit) return true
  log.error(
    'error_handling',
    'Sell refused: quantity exceeds this strategy\'s own open quantity (would sell sibling tokens)',
    new Error('sell_qty_exceeds_own_open_qty'),
    { strategyId, mintAddress, sellQty, ownOpenQty },
  )
  return false
}

/** This strategy's own open quantity for a mint, from its scoped records. */
function ownOpenQtyForMint(scoped: TrackingRecord[], mintAddress: string): number {
  return computeOpenTradeCycle(scoped, mintAddress, 'sim')?.remainingTokenAmount ?? 0
}

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
  // Scoped to the closing strategy: several strategies share these wallets, and a wallet-wide cycle
  // would sell (and book under this strategy) tokens a sibling bought.
  const scoped = scopeRecordsToStrategy(records, params.strategyId)
  const cycle = computeOpenSimCycle(scoped, params.mintAddress)
  if (!cycle) {
    // Nothing open in THIS strategy's ledger. The worker treats a clean return as closed and retires
    // the mirror, so say so loudly rather than silently: no sell and no outcome are written here.
    log.warn('mcap_tracker', 'Paper close (price domain): no open cycle for strategy+mint — nothing written', {
      domain: params.domain,
      strategyId: params.strategyId,
      mint: params.mintAddress,
      chain: params.chain,
    })
    return 0
  }

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

  if (
    !sellQtyWithinOwnOpenQty({
      strategyId: params.strategyId,
      mintAddress: params.mintAddress,
      sellQty: remaining,
      ownOpenQty: ownOpenQtyForMint(scoped, params.mintAddress),
    })
  ) {
    // Callers catch per position (worker: releases the claim, keeps the mirror; deactivation: failed[]).
    throw new Error('sell refused: quantity exceeds strategy-owned open quantity')
  }

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
   *
   * "Already closed" is strict: this strategy's OWN ledger cycle is flat because of its OWN sell AND
   * an outcome row exists. Anything weaker (no buy, no own sell, no outcome) is NOT closed: it is
   * logged at error level and reported in `failed`, so the mirror stays active and the problem stays
   * visible rather than being retired with nothing written.
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
  // Throws on a DB error (it used to return []): an unreadable ledger must not read as "nothing
  // open, already closed". The worker's caller catches, releases its claim and retries next tick.
  const records = await fetchTradingRecordsForWallet(wallet)
  // Every cycle below is THIS strategy's. A mint-wide cycle nets all sibling strategies' buys, so the
  // sell would remove their tokens too and be booked under the closer alone (the 2026-10 stall).
  const scoped = scopeRecordsToStrategy(records, strategyId)
  const allOpen = getOpenMcapSimPositions(records, strategyId)
  const open = options?.mintAddress
    ? allOpen.filter((p) => p.mintAddress === options.mintAddress)
    : allOpen

  if (options?.mintAddress && open.length === 0) {
    const mint = options.mintAddress
    const hasBuy = scoped.some(
      (r) => r.operationType === 'buy' && r.is_simulation && r.tokens?.some((t) => t.mintAddress === mint),
    )
    const ownSell = findOwnCloseSell(scoped, mint)
    const outcomeExists = await hasStrategyOutcome({ chain, strategyId, tokenAddress: mint })

    if (hasBuy && ownSell && outcomeExists) {
      log.info('mcap_tracker', 'Paper close: already closed (own sell + outcome present)', {
        strategyId,
        mint,
      })
      return { closed: 1, alreadyClosed: 1, failed }
    }

    if (hasBuy && ownSell && !outcomeExists) {
      // The sell landed but the outcome write did not (Reggie[tp150]). Finish the job from the
      // ledger instead of retiring a mirror whose trade has no outcome. No second sell is written.
      try {
        const recovered = await recoverOutcomeFromOwnSell({
          strategyId,
          chain,
          mint,
          scoped,
          sell: ownSell,
        })
        if (recovered) {
          log.warn('mcap_tracker', 'Paper close: outcome recovered from existing own sell', {
            strategyId,
            mint,
          })
          return { closed: 1, alreadyClosed: 0, failed }
        }
      } catch (err) {
        failed.push({ token: mint, error: err instanceof Error ? err.message : String(err) })
        log.error(
          'error_handling',
          'Paper close: outcome recovery failed',
          err instanceof Error ? err : new Error(String(err)),
          { strategyId, mint },
        )
        return { closed, alreadyClosed, failed }
      }
    }

    // Not provably closed. Do NOT retire silently (57b3b6e did, and swallowed the stall).
    const reason = !hasBuy
      ? 'no_buy_in_strategy_ledger'
      : !ownSell
        ? 'no_own_sell_and_no_open_cycle'
        : 'outcome_unrecoverable'
    log.error(
      'error_handling',
      'Paper close: mint-scoped close found no open cycle and cannot prove it closed — mirror NOT retired',
      new Error(reason),
      { strategyId, mint, chain, hasBuy, ownSell: ownSell != null, outcomeExists, reason },
    )
    failed.push({ token: mint, error: reason })
    return { closed, alreadyClosed, failed }
  }

  for (const pos of open) {
    try {
      const snapshot = await fetchMcapTrackingRow(pos.mintAddress)
      const cycle = computeOpenTradeCycle(scoped, pos.mintAddress, 'sim')
      if (!cycle) {
        // `open` came from this same scoped view, so a missing cycle is an inconsistency, not a
        // closed trade: say so rather than counting it closed.
        log.error(
          'error_handling',
          'Paper close: position listed open but its scoped cycle is empty — not counted closed',
          new Error('open_without_cycle'),
          { strategyId, mint: pos.mintAddress },
        )
        failed.push({ token: pos.mintAddress, error: 'open_without_cycle' })
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

      if (
        !sellQtyWithinOwnOpenQty({
          strategyId,
          mintAddress: pos.mintAddress,
          sellQty: remaining,
          ownOpenQty: ownOpenQtyForMint(scoped, pos.mintAddress),
        })
      ) {
        failed.push({ token: pos.mintAddress, error: 'sell_qty_exceeds_own_open_qty' })
        continue
      }

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

      await writeMcapCloseOutcome({
        strategyId,
        pos,
        snapshot,
        exit,
        pnlPct,
        closeReason: (options?.closeReason ?? CLOSE_REASON) as McapSimCloseReason,
        // The real stake, not a value derived from the nominal solReceived.
        entryCostSol: cycle.totalSolBought,
        exitAt: new Date().toISOString(),
      })
      closed++
    } catch (err) {
      failed.push({
        token: pos.mintAddress,
        error: err instanceof Error ? err.message : String(err),
      })
      log.error(
        'error_handling',
        'Paper close failed for position',
        err instanceof Error ? err : new Error(String(err)),
        { strategyId, mint: pos.mintAddress },
      )
    }
  }

  return { closed, alreadyClosed, failed }
}

/** The strategy's latest own sell for a mint, or null. Scoped records only. */
function findOwnCloseSell(scoped: TrackingRecord[], mint: string): TrackingRecord | null {
  let best: TrackingRecord | null = null
  for (const r of scoped) {
    if (r.operationType !== 'sell' || !r.is_simulation) continue
    if ((r.successCount ?? 0) === 0) continue
    if (!r.tokens?.some((t) => t.mintAddress === mint)) continue
    if (!best || r.timestamp > best.timestamp) best = r
  }
  return best
}

/** Build and write the mcap outcome row for a close (shared by the live close and the recovery). */
async function writeMcapCloseOutcome(params: {
  strategyId: string
  pos: ReturnType<typeof getOpenMcapSimPositions>[number]
  snapshot: Awaited<ReturnType<typeof fetchMcapTrackingRow>>
  exit: ReturnType<typeof resolveMcapExit>
  pnlPct: number
  closeReason: McapSimCloseReason
  entryCostSol: number
  exitAt: string
  extraFeatures?: Record<string, unknown>
}): Promise<void> {
  const { strategyId, pos, snapshot, exit, pnlPct, closeReason } = params
  const exitMcap = exit.exitMcap
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
  Object.assign(closeFeatures, params.extraFeatures ?? {})

  // Propagates on failure (insertStrategyOutcome throws): a close without its outcome is a failed
  // close, retried by the next pass, not a success.
  await recordMcapTrackerOutcome({
    strategyId,
    tokenAddress: pos.mintAddress,
    entryAt: pos.entryAt,
    exitAt: params.exitAt,
    pnlPct,
    status: closeOutcomeStatusFromPnl(pnlPct),
    isSimulated: true,
    solAmount: params.entryCostSol,
    features: mergeEntryFeaturesForOutcome(pos.entryFeatures, { ...closeFeatures }),
  })
}

/**
 * The strategy's sell is in the ledger but its outcome never landed. Rebuild the position as it was
 * just before that sell and write the outcome at the price the sell actually booked. Writes NO sell.
 * Returns false when the pre-sell position cannot be reconstructed (caller then fails loudly).
 */
async function recoverOutcomeFromOwnSell(params: {
  strategyId: string
  chain: StrategyChain
  mint: string
  scoped: TrackingRecord[]
  sell: TrackingRecord
}): Promise<boolean> {
  const { strategyId, mint, scoped, sell } = params
  const pre = scoped.filter((r) => r.timestamp < sell.timestamp)
  const pos = getOpenMcapSimPositions(pre, strategyId).find((p) => p.mintAddress === mint)
  const cycle = computeOpenTradeCycle(pre, mint, 'sim')
  if (!pos || !cycle) return false

  const sellToken = sell.tokens?.find((t) => t.mintAddress === mint)
  const snapshot = await fetchMcapTrackingRow(mint)
  const exit = resolveMcapExit({
    entryMcap: pos.entryMcap,
    entryPriceUsd: cycle.weightedBuyPriceUsd,
    triggerPriceUsd: sellToken?.priceUsd,
    snapshotMcap: snapshot?.current_mcap,
  })
  const pnlPct = computeMcapSimPnlPct(pos.entryMcap, exit.exitMcap)
  const rawReason = (sell.trading_simulation as { close_reason?: unknown } | undefined)?.close_reason
  await writeMcapCloseOutcome({
    strategyId,
    pos,
    snapshot,
    exit,
    pnlPct,
    closeReason: (typeof rawReason === 'string' ? rawReason : CLOSE_REASON) as McapSimCloseReason,
    entryCostSol: cycle.totalSolBought,
    exitAt: new Date(sell.timestamp).toISOString(),
    extraFeatures: { outcome_recovered_from_sell: true },
  })
  return true
}
