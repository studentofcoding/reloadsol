/**
 * Robinhood twin of the trending_bot cycle: paper-only, GMGN market rank as the
 * candidate source, ETH-denominated sizing. The Solana cycle in
 * /api/trending/track keeps its Jupiter list, tracker table and live wallet —
 * none of that exists on robinhood, so RH runs on trading_records alone.
 */

import {
  createBrainRiskSession,
  resolveSimOpenSize,
  stampBrainRisk,
  type BrainRiskSession,
} from '@/utils/brain-regime-risk'
import { fetchTradingRecordsForWallet } from './db'
import { decideRhTrendingExit } from './exit-ladder'
import { registerSimExitContract } from './sim-exit-contract'
import { getActiveStrategiesWithState } from './load-strategy'
import { loadClosedTrendingOutcomes, recordTrendingBotOutcome } from './outcomes'
import { RH_MAX_OPEN_POSITIONS_DEFAULT } from './registry'
import { trendingBlockedKeys, trendingReentryKey } from '@/utils/trending-reopen-guard'
import {
  TRENDING_MAX_PURCHASES_PER_TOKEN,
  TRENDING_REENTRY_COOLDOWN_MIN,
} from './trending-track/constants'
import { simWalletForChain, TRENDING_BOT_SIM_WALLET } from './sim-wallets'
import type { TrendingBotStrategy } from './types'
import { getFilteredGmgnTrending } from '@/utils/gmgn-trending-feed'
import { getNativeUsd } from '@/utils/native-usd'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import {
  computeOpenSimCycles,
  type OpenSimCycle,
} from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecords } from '@/utils/trading-records-db'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { log } from '@/utils/unified-logger'
import { closeOutcomeStatusFromPnl } from '@/strategies/close-outcome-status'

// Re-export so existing consumers/tests keep their import path.
export { decideRhTrendingExit }

const CHAIN = 'robinhood' as const

const SIM_WALLET = simWalletForChain(TRENDING_BOT_SIM_WALLET, CHAIN)

type OpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryPriceUsd: number
  tp1Done: boolean
  entryFeatures: Record<string, unknown>
  cycle: OpenSimCycle
}

type Records = Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>

export type RhTrendingSimResult = {
  strategyId: string
  chain: typeof CHAIN
  candidates: number
  opened: number
  closed: number
  skipped: string[]
}

/**
 * Single-pass position reconstruction: group records by mint once (candidate
 * discovery, first buy record, tp1-marker sells), then compute all open sim
 * cycles in one sorted walk instead of re-scanning records per position.
 */
export function openPositionsFor(records: Records, strategyId: string): OpenPosition[] {
  const candidateMints = new Set<string>()
  const candidateOrder: string[] = []
  const candidateToken = new Map<string, { symbol?: string }>()
  const buysByMint = new Map<string, TrackingRecord[]>()
  const lastCloseTsByMint = new Map<string, number>()
  const tp1Mints = new Set<string>()

  for (const r of records) {
    const isCandidate = r.is_simulation === true && r.bot_strategy === strategyId
    const isBuy = r.operationType === 'buy' && r.bot_strategy === strategyId
    const isFullClose =
      r.operationType === 'sell' &&
      r.bot_strategy === strategyId &&
      r.close_position === true
    const isTp1Sell =
      r.operationType === 'sell' &&
      r.bot_strategy === strategyId &&
      !r.close_position
    if (!isCandidate && !isBuy && !isFullClose && !isTp1Sell) continue

    for (const t of r.tokens ?? []) {
      const mint = t.mintAddress
      if (isCandidate && !candidateMints.has(mint)) {
        candidateMints.add(mint)
        candidateOrder.push(mint)
        candidateToken.set(mint, t)
      }
      if (isBuy) {
        const buys = buysByMint.get(mint)
        if (buys) buys.push(r)
        else buysByMint.set(mint, [r])
      }
      if (isFullClose) {
        lastCloseTsByMint.set(
          mint,
          Math.max(lastCloseTsByMint.get(mint) ?? 0, r.timestamp),
        )
      }
      if (isTp1Sell) tp1Mints.add(mint)
    }
  }

  /**
   * Entry metadata belongs to the buy that opened the mint's *current* cycle:
   * the earliest buy at/after the most recent full close. Taking the first-ever
   * buy instead stamps every later re-entry with the same `entry_at`, so
   * `(strategy, mint, entry_at)` stops identifying a trade and the read-side
   * dedupe silently collapses all of a mint's trades into one (att_rh: 77,319
   * distinct trades sharing 1,331 entry stamps). Records arrive ascending
   * (`fetchTradingRecordsForWallet` orders by timestamp ASC).
   */
  const entryBuyFor = (mint: string): TrackingRecord | undefined => {
    const buys = buysByMint.get(mint)
    if (!buys || buys.length === 0) return undefined
    const lastCloseTs = lastCloseTsByMint.get(mint)
    if (lastCloseTs == null) return buys[0]
    return buys.find((b) => b.timestamp >= lastCloseTs) ?? buys[buys.length - 1]
  }

  const cycles = computeOpenSimCycles(records, candidateMints)
  const open: OpenPosition[] = []

  for (const mint of candidateOrder) {
    const cycle = cycles.get(mint)
    if (!cycle || cycle.simulationType !== 'strategy') continue

    const buy = entryBuyFor(mint)
    const sim = (buy?.trading_simulation ?? {}) as Record<string, unknown>
    const t = candidateToken.get(mint)

    open.push({
      mintAddress: mint,
      symbol: t?.symbol ?? mint.slice(0, 8),
      entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
      entryPriceUsd:
        typeof sim.entry_price_usd === 'number' && sim.entry_price_usd > 0
          ? sim.entry_price_usd
          : cycle.weightedBuyPriceUsd,
      tp1Done: tp1Mints.has(mint),
      entryFeatures:
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {},
      cycle,
    })
  }

  return open
}

function passesConditions(
  strategy: TrendingBotStrategy,
  token: { mcap: number; organic_score: number },
): boolean {
  const c = strategy.conditions
  if (!c) return true
  if (c.min_market_cap != null && token.mcap < c.min_market_cap) return false
  if (c.max_market_cap != null && token.mcap > c.max_market_cap) return false
  if (c.min_organic_score != null && token.organic_score < c.min_organic_score) {
    return false
  }
  return true
}

async function sellSim(params: {
  strategyId: string
  position: OpenPosition
  sellPriceUsd: number
  fraction: number
  reason: string
  closePosition: boolean
  /** REL-20: records are collected and bulk-inserted by the cycle caller. */
  collect: (record: TrackingRecord) => void
}): Promise<void> {
  // Reuse the cycle computed during single-pass position reconstruction.
  const cycle = params.position.cycle

  const nativeUsd = await getNativeUsd(CHAIN)
  const tokenAmount = params.closePosition
    ? cycle.remainingTokenAmount
    : cycle.remainingTokenAmount * params.fraction
  const nativeReceived =
    params.sellPriceUsd > 0 && nativeUsd > 0
      ? (tokenAmount * params.sellPriceUsd) / nativeUsd
      : cycle.totalSolBought * params.fraction

  const pnlPct =
    cycle.weightedBuyPriceUsd > 0
      ? ((params.sellPriceUsd - cycle.weightedBuyPriceUsd) /
          cycle.weightedBuyPriceUsd) *
        100
      : 0

  params.collect(
    buildTradingRecord({
      walletAddress: SIM_WALLET,
      chain: CHAIN,
      operationType: 'sell',
      is_simulation: true,
      simulation_type: 'strategy',
      bot_strategy: params.strategyId,
      close_position: params.closePosition,
      tokens: [
        {
          mintAddress: params.position.mintAddress,
          symbol: params.position.symbol,
          tokenAmount,
          solAmount: nativeReceived,
          priceUsd: params.sellPriceUsd,
          solPrice: nativeUsd,
        },
      ],
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount: nativeReceived,
      feesPaid: 0,
      solPriceUsd: nativeUsd,
      signatures: [`trending-rh-sim-sell-${Date.now()}`],
      status: closeOutcomeStatusFromPnl(pnlPct),
      trading_simulation: { close_reason: params.reason },
    }),
  )

  // Partial take-profit keeps the position open; outcomes land on full close only.
  if (!params.closePosition) return

  await recordTrendingBotOutcome({
    strategyId: params.strategyId,
    chain: CHAIN,
    tokenAddress: params.position.mintAddress,
    entryAt: params.position.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: closeOutcomeStatusFromPnl(pnlPct),
    isSimulated: true,
    features: {
      ...params.position.entryFeatures,
      token_symbol: params.position.symbol,
      exit_price_usd: params.sellPriceUsd,
      close_reason: params.reason,
      sol_spent: cycle.totalSolBought,
      sol_received: nativeReceived,
    },
  })
}

async function buySim(params: {
  strategy: TrendingBotStrategy
  /** REL-20: records are collected and bulk-inserted by the cycle caller. */
  collect: (record: TrackingRecord) => void
  /** Created once per cycle so the recipe/params fetch is shared across tokens. */
  brainRiskSession?: BrainRiskSession
  token: {
    token_address: string
    token_symbol: string
    price: number
    mcap: number
    organic_score: number
    change_5m: number
    change_1h: number
  }
}): Promise<void> {
  const { strategy, token } = params
  // Level 1 market scalar, on the same path as mcap/signals/social/gmgn. This RH sim had no brain
  // wiring at all, so att_rh ran at full configured size while every other family was cut — which is
  // why its rows carried no `brain_size_scale` and a flat 0.0015 stake.
  const session = params.brainRiskSession ?? createBrainRiskSession()
  const sized = await resolveSimOpenSize({
    session,
    strategyId: strategy.id,
    baseSol: strategy.buy_amount_native ?? strategy.buy_amount_sol,
  })
  if (sized.skip) {
    // LOUD, because this was the one path with no trace. `buySim` used to return here without a log
    // and without a `skipped` entry, so a strategy whose every open the brain refuses looked exactly
    // like one whose candidates were all filtered — and the two need opposite fixes. Found by
    // elimination on 2026-10-02: 28 in-band candidates against a guard that could block at most 11,
    // and `tracking: 0`.
    log.warn('deviation_alert', 'RH sim open SKIPPED by the brain risk layer', {
      strategyId: strategy.id,
      chain: CHAIN,
      tokenSymbol: token.token_symbol,
      // WHICH of the two `resolveSimOpenSize` skips fired, and the values behind it.
      //
      // `standDown` and `scaleOpenSize` actually agree, and I first read this as an inconsistency —
      // worth stating so nobody re-derives it: `applyRisk` hardcodes `applied: true`, so a cell that
      // exists is applied, and `sizeScale <= 0` is then a genuine stand-down in both places
      // (`brain-regime-risk.ts:147` and `:187`). A zero scale is not ambiguous.
      //
      // What the log still has to separate: a real cell saying stand-down (`recipeId`/`reason` set,
      // `sizeScale: 0`) versus a cell that carried NO `sizeScale`, where the `: 0` fallback at `:143`
      // coerces it — the second would be a malformed cell read as a policy decision.
      standDown: sized.risk.standDown,
      applied: sized.risk.applied,
      source: sized.risk.source,
      climateState: sized.risk.state,
      sizeScale: sized.risk.sizeScale,
      recipeId: sized.risk.recipeId ?? null,
      reason: sized.risk.reason ?? null,
      baseSol: strategy.buy_amount_native ?? strategy.buy_amount_sol,
      resolvedSol: sized.sol,
    })
    return
  }
  const nativeAmount = sized.sol
  const nativeUsd = await getNativeUsd(CHAIN)
  const priceUsd = token.price > 0 ? token.price : 0.000001
  const tokenAmount = nativeUsd > 0 ? (nativeAmount * nativeUsd) / priceUsd : 0
  const entryAt = new Date().toISOString()

  const entryFeatures = {
    entry_at: entryAt,
    entry_mcap: token.mcap,
    initial_price_usd: priceUsd,
    token_symbol: token.token_symbol,
    organic_score: token.organic_score,
    price_change_5m: token.change_5m,
    price_change_1h: token.change_1h,
    chain: CHAIN,
    strategy_id: strategy.id,
    domain: 'trending_bot',
  }

  params.collect(
    buildTradingRecord({
      walletAddress: SIM_WALLET,
      chain: CHAIN,
      operationType: 'buy',
      is_simulation: true,
      simulation_type: 'strategy',
      bot_strategy: strategy.id,
      tokens: [
        {
          mintAddress: token.token_address,
          symbol: token.token_symbol,
          tokenAmount,
          solAmount: nativeAmount,
          priceUsd,
          solPrice: nativeUsd,
        },
      ],
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount: nativeAmount,
      feesPaid: 0,
      solPriceUsd: nativeUsd,
      totalUsdValue: nativeUsd ? nativeAmount * nativeUsd : undefined,
      signatures: [`trending-rh-sim-buy-${Date.now()}`],
      status: 'tracking',
      trading_simulation: {
        entry_at: entryAt,
        entry_price_usd: priceUsd,
        entry_features: stampBrainRisk(entryFeatures, sized.risk, { sizedSol: nativeAmount }),
      },
    }),
  )

  // Put this position on the exit standard, in SHADOW.
  //
  // `att_rh` has no entry in `simCloseDomainForStrategy`, so the worker will evaluate its triggers on
  // every pass, report them, and then refuse to close because no closer owns the family. That is the
  // point: it is the only way to compare this strategy's own `decideRhTrendingExit` ladder against
  // `evaluateExit` on real positions without changing how the most active strategy exits.
  //
  // The two ladders DO differ, and exactly one case matters. TP3 is disabled here and both agree on
  // the stop, the max-hold and TP1. But a position that gaps straight past TP2 (100%) before TP1 has
  // fired closes 100% under `decideRhTrendingExit` (it checks TP2 before TP1) while `evaluateExit`
  // would sell TP1's 90% and leave 10% open. So `tp1SellPct` carries the real 90 — registering 100
  // would shadow a different strategy from the one running, which is the one thing a shadow must not
  // do.
  //
  // Enforcing is a later step: it means giving `att_rh` a closer domain, and it waits until this
  // comparison agrees.
  await registerSimExitContract({
    chain: CHAIN,
    walletAddress: SIM_WALLET,
    strategyId: strategy.id,
    mintAddress: token.token_address,
    symbol: token.token_symbol,
    positionSize: nativeAmount,
    entryPriceUsd: priceUsd,
    thresholds: {
      takeProfitPct: strategy.take_profit_levels.tp1_percentage,
      stopLossPct: Math.abs(strategy.stop_loss_percentage),
      maxHoldHours: strategy.max_hold_hours,
      tp1SellPct: strategy.take_profit_levels.tp1_sell_percentage,
    },
  })
}

export async function runTrendingBotRhSimCycle(): Promise<RhTrendingSimResult[]> {
  const { strategies, configs } = await getActiveStrategiesWithState(CHAIN)
  if (strategies.length === 0) return []

  const { tokens } = await getFilteredGmgnTrending(CHAIN)
  // Only the rows the reconstruction needs: from each mint's last full close onward. The
  // full wallet is 154,930 rows / 151 MB and hydrating it measured 19-78 s inside the shared
  // Node process — long enough to starve the mcap sim past its 30 s cron deadline. A cycle
  // that ended before the last close cannot be open, so the tail is sufficient; validated on
  // prod (2026-09-29): 6 open positions from the full history and 6 from the tail, 0 lost,
  // 1,340 rows / 1.1 MB instead of 154,930 / 151 MB.
  const records = await fetchTradingRecordsForWallet(SIM_WALLET, {
    strategies,
    sinceLastClose: true,
  })
  // Durable re-entry guard: never reopen a (strategy, mint) already closed
  // inside the cooldown, or past its lifetime open cap.
  const blocked = trendingBlockedKeys(
    await loadClosedTrendingOutcomes(CHAIN, TRENDING_REENTRY_COOLDOWN_MIN),
    {
      cooldownMinutes: TRENDING_REENTRY_COOLDOWN_MIN,
      maxPurchasesPerToken: TRENDING_MAX_PURCHASES_PER_TOKEN,
    },
  )
  const results: RhTrendingSimResult[] = []

  for (const strategyId of strategies) {
    const strategy = configs[strategyId]
    if (!strategy) continue

    // REL-20: collect this strategy's trading-record writes and flush once
    const pendingRecords: TrackingRecord[] = []
    const collect = (record: TrackingRecord) => {
      pendingRecords.push(record)
    }

    const open = openPositionsFor(records, strategyId)
    const openMints = new Set(open.map((p) => p.mintAddress))
    const skipped: string[] = []
    let opened = 0
    let closed = 0

    const marks =
      open.length > 0
        ? await getOpenPositionPrices(
            open.map((p) => p.mintAddress),
            CHAIN,
          )
        : {}

    for (const pos of open) {
      const price = marks[pos.mintAddress] ?? pos.entryPriceUsd
      if (!(price > 0) || !(pos.entryPriceUsd > 0)) continue
      const gainPct = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100
      const heldHours = pos.entryAt
        ? (Date.now() - new Date(pos.entryAt).getTime()) / 3_600_000
        : 0

      const decision = decideRhTrendingExit({
        strategy,
        gainPct,
        heldHours,
        tp1Done: pos.tp1Done,
      })
      if (decision.action === 'hold') continue

      await sellSim({
        strategyId,
        position: pos,
        sellPriceUsd: price,
        fraction:
          decision.action === 'partial' ? decision.sellPct / 100 : 1,
        reason: decision.reason,
        closePosition: decision.action === 'close',
        collect,
      })

      if (decision.action === 'close') {
        closed++
        openMints.delete(pos.mintAddress)
        // `blocked` was built from outcomes that existed BEFORE this close, so without
        // this the mint is reopened by the candidate loop below within the same cycle —
        // observed live: close 16:13:01 → buy 16:13:02 on the same mint.
        blocked.add(trendingReentryKey(strategyId, pos.mintAddress))
      }
    }

    const candidates = tokens.filter((t) => passesConditions(strategy, t))
    const maxOpenPositions =
      strategy.max_open_positions ?? RH_MAX_OPEN_POSITIONS_DEFAULT

    // The funnel, logged before anything is skipped. Without this the only visible number was
    // `current_stats.skipped`, which is CUMULATIVE — so "451 skipped" reads like 451 mints blocked
    // when it is 451 decisions across every cycle since boot. This says which gate is actually
    // binding, per cycle, with the values it compared.
    const blockedCandidates = candidates.filter((t) =>
      blocked.has(trendingReentryKey(strategyId, t.token_address)),
    )
    // NOTE on the level: this is `warn`, not `info`, because `unified-logger` writes `info` through
    // `console.log` and production's `removeConsole` strips it (`unified-logger.ts:77`) — so an
    // `info` funnel would be a log that looks correct in dev and is silently absent where it matters.
    // This path has been burned by exactly that before ("most of this path's instrumentation is
    // console.log, which production's removeConsole strips, so the cycle looked silent" — CHANGELOG),
    // and I repeated it; the first version of this line was `info`.
    log.warn('deviation_alert', 'RH sim candidate funnel', {
      strategyId,
      chain: CHAIN,
      feed_tokens: tokens.length,
      after_conditions: candidates.length,
      already_open: candidates.filter((t) => openMints.has(t.token_address)).length,
      blocked_by_guard: blockedCandidates.length,
      blocked_sample: blockedCandidates.slice(0, 5).map((t) => t.token_symbol),
      open_now: openMints.size,
      max_open_positions: maxOpenPositions,
      mcap_min: strategy.conditions?.min_market_cap,
      mcap_max: strategy.conditions?.max_market_cap,
    })

    for (const token of candidates) {
      if (openMints.has(token.token_address)) continue
      if (blocked.has(trendingReentryKey(strategyId, token.token_address))) {
        skipped.push(`${token.token_symbol}: re-entry cooldown`)
        continue
      }
      if (openMints.size >= maxOpenPositions) {
        skipped.push(`${token.token_symbol}: max positions`)
        break
      }
      await buySim({ strategy, token, collect })
      openMints.add(token.token_address)
      opened++
    }

    // REL-20: one round-trip per chunk replaces one insert per position.
    // Throws on DB error exactly as the per-row inserts did.
    if (pendingRecords.length > 0) {
      const startedAt = Date.now()
      const res = await insertTradingRecords(pendingRecords)
      log.info('api_request', 'REL-20 RH sim batched trading-record writes', {
        strategyId,
        inserted: res.inserted,
        skipped: res.skipped,
        statements: res.stats.chunks,
        ms: Date.now() - startedAt,
        replacedRoundTrips: res.inserted,
      })
    }

    results.push({
      strategyId,
      chain: CHAIN,
      candidates: candidates.length,
      opened,
      closed,
      skipped,
    })
  }

  log.info('api_request', 'Robinhood trending sim cycle', { results })
  return results
}
