import { NextRequest, NextResponse } from 'next/server'
import { deployPosition } from '@/utils/dlmm/actions'
import { getAgentConfig, getLatestCandidates, getPositions } from '@/utils/dlmm/db'
import { runDlmmScreen } from '@/utils/dlmm/screener'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { getActiveDlmmForSim } from '@/strategies/load-dlmm'
import {
  outcomeBlockedKeys,
  poolsBlockedByRecentClose,
} from '@/utils/dlmm/reopen-guard'

export const maxDuration = 120

function getSimTrackSecret(): string {
  return (
    process.env.DLMM_SIM_TRACK_SECRET ||
    process.env.DLMM_MANAGE_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

const OPEN_STATUSES = new Set(['open', 'out_of_range', 'pending'])

/** Don't re-deploy a pool whose last position closed within this cooldown (min). */
const REOPEN_COOLDOWN_MIN = Number(
  process.env.DLMM_REOPEN_COOLDOWN_MIN ?? 60,
)

/**
 * Durable cooldown (min) for re-opening a token/pool we've already closed on,
 * keyed off `strategy_outcomes`. This is the guard that actually stops the
 * sim's open → close → reopen churn: even if the screener keeps re-offering the
 * same pool, we refuse to re-enter within the window. Default 24h.
 */
const REOPEN_TOKEN_COOLDOWN_MIN = Number(
  process.env.DLMM_REOPEN_TOKEN_COOLDOWN_MIN ?? 1440,
)

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const strategy = await getActiveDlmmForSim()
    if (!strategy) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'dlmm_default inactive or not in sim/ab_parallel mode',
        opened: 0,
        skippedPools: [],
      })
    }

    const agentConfig = await getAgentConfig()
    if (!agentConfig.enabled) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'DLMM agent disabled (enable in /dev/dlmm or activate strategy in admin)',
        opened: 0,
        skippedPools: [],
      })
    }

    if (!agentConfig.dry_run) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'dry_run is false — sim-track only runs in dry_run mode',
        opened: 0,
        skippedPools: [],
      })
    }

    let candidates = await getLatestCandidates(25)
    if (candidates.length === 0) {
      await runDlmmScreen({ notify: false })
      candidates = await getLatestCandidates(25)
    }

    const positions = await getPositions()
    const openPositions = positions.filter((p) => OPEN_STATUSES.has(p.status))
    const openPoolSet = new Set(openPositions.map((p) => p.pool_address))
    const recentCloseBlocked = poolsBlockedByRecentClose(
      positions,
      REOPEN_COOLDOWN_MIN * 60_000,
    )

    // Durable token/pool re-entry guard — stops the sim from re-opening the
    // same token after it was already closed, within a longer window than the
    // transient position cooldown above. Sources BOTH the persistent
    // strategy_outcomes ledger and the closed dlmm_positions rows, so it still
    // bites even when a close never wrote an outcome row.
    const tokenCooldownMs = REOPEN_TOKEN_COOLDOWN_MIN * 60_000
    const { loadRecentlyClosedDlmmOutcomes } = await import(
      '@/strategies/outcomes'
    )
    const recentOutcomePool = outcomeBlockedKeys(
      await loadRecentlyClosedDlmmOutcomes(tokenCooldownMs),
      tokenCooldownMs,
    ).poolKeys
    const recentLongWindowBlocked = poolsBlockedByRecentClose(
      positions,
      tokenCooldownMs,
    )
    const recentlyCleared = new Set<string>([
      ...recentOutcomePool,
      ...recentLongWindowBlocked,
    ])

    const openCount = openPositions.length

    const { execution } = strategy.config
    const maxOpen = execution.maxOpenPositions
    const minScore = execution.minCandidateScore
    const simDeploySol = Math.min(
      execution.simDeploySol,
      strategy.config.max_sol_per_position,
    )

    let opened = 0
    const skippedPools: string[] = []

    for (const candidate of candidates) {
      if (openCount + opened >= maxOpen) {
        skippedPools.push(`${candidate.pool_address}: max open positions (${maxOpen})`)
        continue
      }

      if (openPoolSet.has(candidate.pool_address)) {
        skippedPools.push(`${candidate.pool_address}: already open`)
        continue
      }

      if (recentCloseBlocked.has(candidate.pool_address)) {
        skippedPools.push(
          `${candidate.pool_address}: cooldown after recent close (${REOPEN_COOLDOWN_MIN}m)`,
        )
        continue
      }

      if (recentlyCleared.has(candidate.pool_address)) {
        skippedPools.push(
          `${candidate.pool_address}: already traded (cooldown ${REOPEN_TOKEN_COOLDOWN_MIN}m)`,
        )
        continue
      }

      if (candidate.score < minScore) {
        skippedPools.push(
          `${candidate.pool_address}: score ${candidate.score} < ${minScore}`,
        )
        continue
      }

      const result = await deployPosition({
        poolAddress: candidate.pool_address,
        amountSol: simDeploySol,
        takeProfitPct: strategy.config.take_profit_pct,
        stopLossPct: strategy.config.stop_loss_pct,
        oorTimeoutMin: strategy.config.oor_timeout_min,
        binRangeInterval: strategy.config.bin_range_interval,
      })

      if (!result.success) {
        skippedPools.push(
          `${candidate.pool_address}: ${result.error ?? result.message}`,
        )
        continue
      }

      opened++
      openPoolSet.add(candidate.pool_address)
    }

    return NextResponse.json({
      success: true,
      strategyId: strategy.id,
      opened,
      openCount: openCount + opened,
      candidatesConsidered: candidates.length,
      skippedPools,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  return POST(request)
}
