import { NextRequest, NextResponse } from 'next/server'
import { discoverAndGateGmgnCandidates } from '@/strategies/gmgn-pipeline'
import { getActiveGmgnForSim } from '@/strategies/load-gmgn'
import { mergeEntryFeaturesForOutcome } from '@/strategies/entry-feature-snapshot'
import { ensureCompleteBuyFeaturesForOutcome } from '@/strategies/resolve-entry-snapshot'
import { recordGmgnOutcome } from '@/strategies/outcomes'
import { closeOutcomeStatusFromPnl } from '@/strategies/close-outcome-status'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import {
  GMGN_SIM_WALLET,
  openGmgnSimPosition,
} from '@/strategies/gmgn-open-sim'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecords } from '@/utils/trading-records-db'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import { getNativeUsd } from '@/utils/native-usd'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { checkGmgnLiveBoostForOpenPosition } from '@/strategies/gmgn-live-boost'
import { simWalletForChain } from '@/strategies/sim-wallets'
import {
  getOpenStrategySimPositions as getOpenPositionsForStrategy,
  shouldClosePriceSimPosition as shouldClosePosition,
  type StrategySimOpenPosition as OpenPosition,
} from '@/strategies/open-strategy-sim-positions'
import { STRATEGY_CHAINS, type GmgnStrategy, type StrategyChain } from '@/strategies/types'

export const maxDuration = 120

export { GMGN_SIM_WALLET }

function getSimTrackSecret(): string {
  return (
    process.env.GMGN_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** GMGN top_10_holder_rate is often 0..1; canonical features use percent. */
function gmgnTopHoldersToPct(rate: number | null): number | null {
  if (rate == null) return null
  if (rate >= 0 && rate <= 1) return rate * 100
  return rate
}

function collectRecentMints(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
  cooldownHours: number,
): Set<string> {
  const cutoff = Date.now() - cooldownHours * 60 * 60 * 1000
  const recent = new Set<string>()

  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategyId) continue
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0
    if (ts < cutoff) continue
    for (const t of r.tokens ?? []) {
      if (t.mintAddress) recent.add(t.mintAddress)
    }
  }

  return recent
}

async function openSimPosition(params: {
  strategy: GmgnStrategy
  mintAddress: string
  symbol: string
  entryFeatures: Record<string, unknown>
  entryPriceUsd: number
}): Promise<boolean> {
  return openGmgnSimPosition(params)
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { withJobLock } = await import('@/utils/bot-job-lock')
  return withJobLock('gmgn_sim_track', 900, () => runSimTrack(request))
}

async function runSimTrack(request: NextRequest) {

  try {
    const results: Array<{
      strategyId: string
      chain: StrategyChain
      discovered: number
      opened: number
      closed: number
      skipped: string[]
    }> = []

    for (const chain of STRATEGY_CHAINS) {
    const strategies = await getActiveGmgnForSim(chain)
    if (strategies.length === 0) continue
    const simWallet = simWalletForChain(GMGN_SIM_WALLET, chain)
    const records = await fetchTradingRecordsForWallet(simWallet)

    for (const strategy of strategies) {
      let opened = 0
      let closed = 0
      const openPositions = getOpenPositionsForStrategy(records, strategy.id)
      const openMintSet = new Set(openPositions.map((p) => p.mintAddress))
      const cooldownHours = strategy.config.discovery.cooldownHours ?? 24
      const recentMints = collectRecentMints(records, strategy.id, cooldownHours)

      for (const pos of openPositions) {
        await checkGmgnLiveBoostForOpenPosition({
          walletAddress: simWallet,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          entryAt: pos.entryAt,
          symbol: pos.symbol,
        })

        // The 60s SL/TP worker owns this position's exit (SPEC-strategy-exit-standard S9). This
        // pass monitors (the live-boost check above) and opens; it no longer closes, so
        // `shouldClosePriceSimPosition` has no caller here and this route cannot disagree with the
        // worker about the same position.
      }

      const { discovered, eligible, skipped } = await discoverAndGateGmgnCandidates({
        strategy,
        openMints: openMintSet,
        recentMints,
      })

      const refreshedRecords = await fetchTradingRecordsForWallet(simWallet)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      for (const candidate of eligible) {
        if (openMintSet.has(candidate.tokenAddress)) continue
        if (currentOpen + opened >= maxOpen) {
          skipped.push('max positions reached')
          break
        }

        const entryPriceUsd =
          typeof candidate.entryFeatures.gmgn_price_usd === 'number' &&
          candidate.entryFeatures.gmgn_price_usd > 0
            ? candidate.entryFeatures.gmgn_price_usd
            : 0

        const openedOk = await openSimPosition({
          strategy,
          mintAddress: candidate.tokenAddress,
          symbol: candidate.symbol,
          entryFeatures: candidate.entryFeatures,
          entryPriceUsd,
        })
        if (!openedOk) {
          skipped.push(`${candidate.symbol}: spine_skip`)
          continue
        }

        opened++
        openMintSet.add(candidate.tokenAddress)
      }

      results.push({
        strategyId: strategy.id,
        chain,
        discovered,
        opened,
        closed,
        skipped,
      })

      log.info('api_request', 'GMGN sim track cycle', {
        strategy: strategy.id,
        chain,
        discovered,
        opened,
        closed,
        skipped: skipped.length,
      })
    }
    }

    return NextResponse.json({ success: true, results })
  } catch (error) {
    log.error('error_handling', 'GMGN sim track failed', error as Error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
