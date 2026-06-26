import { NextRequest, NextResponse } from 'next/server'
import { getActiveMcapTrackerForSim } from '@/strategies/load-mcap-tracker'
import { recordMcapTrackerOutcome } from '@/strategies/outcomes'
import { buildEntryMcapFeatures } from '@/strategies/outcome-features'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import type { McapTrackerStrategy } from '@/strategies/types'
import {
  buildMcapOutcomeFeatures,
  computeMcapSimPnlPct,
  fetchMcapTrackingRow,
  fetchRecentMcapTrackingRows,
  getMcapSimCloseReason,
  isInTrackingRange,
  type McapSnapshot,
} from '@/utils/mcap-tracker'

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

type OpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  entryFeatures: Record<string, unknown>
}

function readEntryMcap(features: Record<string, unknown>): number {
  const v = features.entry_mcap
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function readEntryTemplate(
  features: Record<string, unknown>,
): 'first_seen' | 'milestone_80' {
  return features.entry_template === 'milestone_80' ? 'milestone_80' : 'first_seen'
}

function getOpenPositionsForStrategy(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
): OpenPosition[] {
  const seen = new Set<string>()
  const open: OpenPosition[] = []

  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategyId) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenSimCycle(records, t.mintAddress)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      seen.add(t.mintAddress)
      const buyRecord = records.find(
        (rec) =>
          rec.operationType === 'buy' &&
          rec.bot_strategy === strategyId &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      const sim = (buyRecord?.trading_simulation ?? {}) as Record<string, unknown>
      const entryFeatures =
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {}
      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol ?? t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryMcap: readEntryMcap(entryFeatures),
        entryTemplate: readEntryTemplate(entryFeatures),
        entryFeatures,
      })
    }
  }

  return open
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
    entry_mcap: params.entryMcap,
    token_symbol: params.symbol,
    ...buildEntryMcapFeatures(params.entryMcap),
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

  await recordMcapTrackerOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: buildMcapOutcomeFeatures({
      snapshot: params.snapshot,
      entryTemplate: params.entryTemplate,
      entryMcap: params.entryMcap,
      exitMcap,
      closeReason: params.closeReason,
    }),
  })

  return pnlPct
}

function resolveEntryMcap(
  strategy: McapTrackerStrategy,
  snapshot: McapSnapshot,
): { entryMcap: number; entryAt: string } | null {
  if (strategy.config.entryTemplate === 'first_seen') {
    if (!snapshot.first_mcap || snapshot.first_mcap <= 0) return null
    return { entryMcap: snapshot.first_mcap, entryAt: snapshot.first_seen_at }
  }

  if (!snapshot.when_reach_80mc || !snapshot.first_mcap) return null
  const entryMcap = Math.round(snapshot.first_mcap * 1.8)
  return { entryMcap, entryAt: snapshot.when_reach_80mc }
}

function shouldOpenForStrategy(
  strategy: McapTrackerStrategy,
  snapshot: McapSnapshot,
  openMintSet: Set<string>,
): boolean {
  if (openMintSet.has(snapshot.token_address)) return false
  if (snapshot.label === 'rugged') return false
  if (!isInTrackingRange(snapshot.current_mcap)) return false

  if (strategy.config.entryTemplate === 'first_seen') {
    const ageMs = Date.now() - new Date(snapshot.first_seen_at).getTime()
    return ageMs <= strategy.config.query.recencyMinutes * 60 * 1000
  }

  return !!snapshot.when_reach_80mc
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

      for (const pos of openPositions) {
        const snapshot =
          trackingByMint.get(pos.mintAddress) ??
          (await fetchMcapTrackingRow(pos.mintAddress))
        if (!snapshot) continue

        const closeReason = getMcapSimCloseReason(snapshot)
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
      }

      const refreshedRecords = await fetchTradingRecordsForWallet(MCAP_TRACKER_SIM_WALLET)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      for (const snapshot of trackingRows) {
        if (!shouldOpenForStrategy(strategy, snapshot, openMintSet)) continue
        if (currentOpen + opened >= maxOpen) {
          skipped.push(`${snapshot.token_symbol}: max positions`)
          break
        }

        const entry = resolveEntryMcap(strategy, snapshot)
        if (!entry) {
          skipped.push(`${snapshot.token_symbol}: no entry mcap`)
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
