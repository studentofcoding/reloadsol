import { NextRequest, NextResponse } from 'next/server'
import { getActiveMcapTrackerForSim } from '@/strategies/load-mcap-tracker'
import { recordMcapTrackerOutcome } from '@/strategies/outcomes'
import {
  appendMonitorSnapshot,
  buildEntryFeatureSnapshot,
  mergeEntryFeaturesForOutcome,
  readMonitorSnapshotsFromFeatures,
} from '@/strategies/entry-feature-snapshot'
import { fetchTradingRecordsForWallet, loadMcapSimClosedOutcomeKeys, mcapSimClosedOutcomeKey } from '@/strategies/db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import {
  buildMcapOutcomeFeatures,
  computeMcapSimPnlPct,
  fetchMcapTrackingRow,
  fetchRecentMcapTrackingRows,
  getMcapSimCloseReason,
  type McapSnapshot,
} from '@/utils/mcap-tracker'
import {
  getMcapSimOpenSkipReason,
  getOpenMcapSimPositions,
  resolveMcapSimEntry,
  shouldOpenMcapSim,
  type McapSimOpenPosition,
} from '@/utils/mcap-sim-track'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MCAP_TRACKER_SIM_WALLET =
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'

function getSimTrackSecret(): string {
  return (
    process.env.MCAP_TRACKER_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

type OpenPosition = McapSimOpenPosition

function getOpenPositionsForStrategy(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
): OpenPosition[] {
  return getOpenMcapSimPositions(records, strategyId)
}

async function openSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  solAmount: number
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  entryAt: string
  snapshot: McapSnapshot
}): Promise<void> {
  const solPrice = await getSolPriceUSD()
  const priceUsd = 0.000001
  const tokenAmount =
    priceUsd > 0 && solPrice > 0
      ? (params.solAmount * solPrice) / priceUsd
      : params.solAmount * 1000

  const entryFeatures = {
    entry_template: params.entryTemplate,
    ...buildEntryFeatureSnapshot({
      entryAt: params.entryAt,
      firstSeenAt: params.snapshot.first_seen_at,
      entryMcap: params.entryMcap,
      organicScore: params.snapshot.organic_score,
      topHoldersPct: params.snapshot.top_holders_pct,
      volume5m: params.snapshot.volume_5m,
      tokenSymbol: params.symbol,
    }),
    ...buildMcapOutcomeFeatures({
      snapshot: params.snapshot,
      entryTemplate: params.entryTemplate,
      entryMcap: params.entryMcap,
      exitMcap: params.snapshot.current_mcap,
    }),
  }

  const record = buildTradingRecord({
    walletAddress: MCAP_TRACKER_SIM_WALLET,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount: params.solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: params.solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? params.solAmount * solPrice : undefined,
    signatures: [`mcap-tracker-sim-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      strategy_id: params.strategyId,
      entry_at: params.entryAt,
      entry_features: entryFeatures,
    },
  })

  await insertTradingRecord(record)
}

async function closeSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  snapshot: McapSnapshot
  closeReason: NonNullable<ReturnType<typeof getMcapSimCloseReason>>
}): Promise<number> {
  const records = await fetchTradingRecordsForWallet(MCAP_TRACKER_SIM_WALLET)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const exitMcap = params.snapshot.current_mcap
  const pnlPct = computeMcapSimPnlPct(params.entryMcap, exitMcap)
  const solPrice = await getSolPriceUSD()
  const sellPriceUsd = 0.000001
  const remaining = cycle.remainingTokenAmount
  const solReceived =
    sellPriceUsd && solPrice > 0
      ? (remaining * sellPriceUsd) / solPrice
      : cycle.totalSolBought * (1 + pnlPct / 100)

  const record = buildTradingRecord({
    walletAddress: MCAP_TRACKER_SIM_WALLET,
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
    signatures: [`mcap-tracker-sim-close-${Date.now()}`],
    status: pnlPct >= 0 ? 'won' : 'lost',
  })

  await insertTradingRecord(record)

  const buyRecord = [...records]
    .reverse()
    .find(
      (rec) =>
        rec.operationType === 'buy' &&
        rec.bot_strategy === params.strategyId &&
        rec.tokens?.some((t) => t.mintAddress === params.mintAddress),
    )
  const buyFeatures =
    buyRecord?.trading_simulation &&
    typeof buyRecord.trading_simulation === 'object' &&
    buyRecord.trading_simulation.entry_features &&
    typeof buyRecord.trading_simulation.entry_features === 'object'
      ? (buyRecord.trading_simulation.entry_features as Record<string, unknown>)
      : null

  const closeFeatures = buildMcapOutcomeFeatures({
    snapshot: params.snapshot,
    entryTemplate: params.entryTemplate,
    entryMcap: params.entryMcap,
    exitMcap,
    closeReason: params.closeReason,
  })
  const monitorSnapshots = appendMonitorSnapshot(
    readMonitorSnapshotsFromFeatures(buyFeatures),
    {
      timestamp: new Date().toISOString(),
      volume_5m: params.snapshot.volume_5m ?? null,
      market_cap: exitMcap,
    },
  )

  await recordMcapTrackerOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: mergeEntryFeaturesForOutcome(buyFeatures, {
      ...closeFeatures,
      monitor_snapshots: monitorSnapshots,
    }),
  })

  return pnlPct
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const strategies = await getActiveMcapTrackerForSim()
    const records = await fetchTradingRecordsForWallet(MCAP_TRACKER_SIM_WALLET)
    const results: Array<{
      strategyId: string
      opened: number
      closed: number
      skipped: string[]
    }> = []

    const maxRecency = Math.max(
      240,
      ...strategies.map((s) => s.config.query.recencyMinutes),
    )
    const trackingRows = await fetchRecentMcapTrackingRows({
      recencyMinutes: maxRecency,
      limit: 300,
    })
    const trackingByMint = new Map(trackingRows.map((r) => [r.token_address, r]))

    for (const strategy of strategies) {
      const openPositions = getOpenPositionsForStrategy(records, strategy.id)
      const openMintSet = new Set(openPositions.map((p) => p.mintAddress))
      let opened = 0
      let closed = 0
      const skipped: string[] = []

      const closedOutcomeKeys = await loadMcapSimClosedOutcomeKeys(
        strategy.id,
        trackingRows.map((row) => row.token_address),
      )

      for (const pos of openPositions) {
        const snapshot =
          trackingByMint.get(pos.mintAddress) ??
          (await fetchMcapTrackingRow(pos.mintAddress))
        if (!snapshot) continue

        const closeReason = getMcapSimCloseReason(snapshot, {
          stopLossPct: strategy.config.exit.stopLossPct,
          takeProfitPct: strategy.config.exit.takeProfitPct,
          maxHoldHours: strategy.config.exit.maxHoldHours,
        })
        if (!closeReason) continue

        await closeSimPosition({
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          symbol: pos.symbol,
          entryAt: pos.entryAt,
          entryMcap: pos.entryMcap || snapshot.first_mcap,
          entryTemplate: pos.entryTemplate,
          snapshot,
          closeReason,
        })
        closed++
        openMintSet.delete(pos.mintAddress)
        if (pos.entryAt) {
          closedOutcomeKeys.add(
            mcapSimClosedOutcomeKey(pos.mintAddress, pos.entryAt),
          )
        }
      }

      const refreshedRecords = await fetchTradingRecordsForWallet(MCAP_TRACKER_SIM_WALLET)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      for (const snapshot of trackingRows) {
        const skipReason = getMcapSimOpenSkipReason(
          strategy,
          snapshot,
          openMintSet,
          closedOutcomeKeys,
        )
        if (skipReason) {
          if (
            skipReason !== 'already_open' &&
            skipReason !== 'first_seen_too_old' &&
            skipReason !== 'already_closed'
          ) {
            skipped.push(`${snapshot.token_symbol}: ${skipReason}`)
          }
          continue
        }
        if (!shouldOpenMcapSim(strategy, snapshot, openMintSet, closedOutcomeKeys)) {
          continue
        }
        if (currentOpen + opened >= maxOpen) {
          skipped.push(`${snapshot.token_symbol}: max positions`)
          break
        }

        const entry = resolveMcapSimEntry(strategy, snapshot)
        if (!entry) {
          skipped.push(`${snapshot.token_symbol}: no_entry_mcap`)
          continue
        }

        await openSimPosition({
          strategyId: strategy.id,
          mintAddress: snapshot.token_address,
          symbol: snapshot.token_symbol,
          solAmount: strategy.config.execution.simBuySol,
          entryMcap: entry.entryMcap,
          entryTemplate: strategy.config.entryTemplate,
          entryAt: entry.entryAt,
          snapshot,
        })
        opened++
        openMintSet.add(snapshot.token_address)
      }

      results.push({ strategyId: strategy.id, opened, closed, skipped })
    }

    log.info('mcap_tracker', 'MCap tracker sim track cycle complete', { results })

    return NextResponse.json({
      success: true,
      wallet: MCAP_TRACKER_SIM_WALLET,
      results,
    })
  } catch (error) {
    log.error('error_handling', 'MCap tracker sim track failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
