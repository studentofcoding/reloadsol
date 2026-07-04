import { query } from '@/utils/db'
import { normalizeTrackingTimeline, isInTrackingRange, type McapSnapshot } from '@/utils/mcap-tracker'
import { getRugAddressSet } from '@/utils/rug-list/db'
import { log } from '@/utils/unified-logger'
import { fetchSocialRollupsMap } from '@/strategies/social/db'
import {
  evaluateSocialGate,
  rollupToSocialSnapshot,
} from '@/strategies/social-snapshot'
import type { SocialSnapshot } from '@/strategies/social/types'
import {
  applyScoreToItem,
  buildSignalScoringItem,
  type SignalScoringItem,
} from './signals-scoring'
import type { SignalsStrategy, SignalsStrategyConfig } from './types'

export type ScoredSignal = SignalScoringItem & {
  score: number
  decision: 'enter' | 'hold' | 'exit' | 'skip'
  rationale: string
  socialBoost?: number
  socialNotes?: string[]
}

type McapTrackingRow = {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  mcap_growth_percent: number
  first_seen_at: string
  last_updated_at: string
  when_reach_80pct?: string | null
  when_reach_120pct?: string | null
  when_reach_200pct?: string | null
  is_tracking_stuck?: boolean
}

function rowToScoredSignal(
  row: McapTrackingRow,
  strategyConfig: SignalsStrategyConfig,
  socialSnapshot?: SocialSnapshot | null,
): ScoredSignal {
  const base = buildSignalScoringItem({
    token_address: row.token_address,
    token_symbol: row.token_symbol?.trim() || row.token_address.slice(0, 8),
    first_mcap: row.first_mcap,
    current_mcap: row.current_mcap,
    mcap_growth_percent: row.mcap_growth_percent,
    first_seen_at: row.first_seen_at,
    last_updated_at: row.last_updated_at,
    when_reach_80pct: row.when_reach_80pct,
    when_reach_120pct: row.when_reach_120pct,
    when_reach_200pct: row.when_reach_200pct,
    is_tracking_stuck: row.is_tracking_stuck,
    in_tracking_range: isInTrackingRange(row.current_mcap),
  })
  return applyScoreToItem(base, strategyConfig, socialSnapshot) as ScoredSignal
}

export function rescoreScoredSignal(
  signal: ScoredSignal,
  strategyConfig: SignalsStrategyConfig,
  socialSnapshot?: SocialSnapshot | null,
): ScoredSignal {
  const base = buildSignalScoringItem({
    token_address: signal.token_address,
    token_symbol: signal.token_symbol,
    first_mcap: signal.first_mcap,
    current_mcap: signal.current_mcap,
    mcap_growth_percent: signal.mcap_growth_percent,
    first_seen_at: signal.first_seen_at,
    last_updated_at: signal.last_updated_at,
    when_reach_80pct: signal.when_reach_80pct,
    when_reach_120pct: signal.when_reach_120pct,
    when_reach_200pct: signal.when_reach_200pct,
    is_tracking_stuck: signal.is_tracking_stuck,
    in_tracking_range: isInTrackingRange(signal.current_mcap),
  })
  return applyScoreToItem(base, strategyConfig, socialSnapshot) as ScoredSignal
}

function sortScoredSignals(signals: ScoredSignal[]): ScoredSignal[] {
  return [...signals].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (b.mcap_growth_percent || 0) - (a.mcap_growth_percent || 0)
  })
}

async function validateTokensAgainstRugPulls(
  signals: ScoredSignal[],
  strategyConfig: SignalsStrategyConfig,
): Promise<ScoredSignal[]> {
  if (signals.length === 0) return signals

  const RUG_PULL_THRESHOLD = 0.6
  const validatedSignals: ScoredSignal[] = []
  const baseUrl =
    process.env.API_HOST || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'

  const tokenAddresses = signals.map((s) => s.token_address)
  const currentMcaps: Record<string, number> = {}
  const BATCH_SIZE = 10

  for (let i = 0; i < tokenAddresses.length; i += BATCH_SIZE) {
    const batch = tokenAddresses.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (tokenAddress) => {
        try {
          const response = await fetch(
            `${baseUrl}/api/trending/search?query=${tokenAddress}`,
            { headers: { 'User-Agent': 'TradingSignals/1.0' } },
          )
          if (response.ok) {
            const data = await response.json()
            const tokenData = Array.isArray(data)
              ? data.find((t: { id: string }) => t.id === tokenAddress)
              : null
            if (tokenData?.mcap && tokenData.mcap > 0) {
              currentMcaps[tokenAddress] = tokenData.mcap
            }
          }
        } catch {
          /* fail-safe */
        }
      }),
    )
    if (i + BATCH_SIZE < tokenAddresses.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  for (const signal of signals) {
    const currentMcap = currentMcaps[signal.token_address]
    if (!currentMcap) {
      validatedSignals.push(signal)
      continue
    }
    const mcapDecrease = (signal.current_mcap - currentMcap) / signal.current_mcap
    if (mcapDecrease > RUG_PULL_THRESHOLD) {
      log.warn('mcap_tracker', 'Token filtered due to sudden mcap drop', {
        tokenAddress: signal.token_address,
      })
    } else {
      const refreshedGrowth =
        ((currentMcap - signal.first_mcap) / signal.first_mcap) * 100
      validatedSignals.push(
        rescoreScoredSignal(
          {
            ...signal,
            current_mcap: currentMcap,
            mcap_growth_percent: refreshedGrowth,
          },
          strategyConfig,
        ),
      )
    }
  }

  return validatedSignals
}

export async function fetchAndScoreSignals(
  strategyConfig: SignalsStrategyConfig,
  options?: { skipRugValidation?: boolean },
): Promise<ScoredSignal[]> {
  const { query: queryConfig } = strategyConfig
  const limit = Math.min(queryConfig.limit, 100)
  const recencyMinutes = Math.max(queryConfig.recencyMinutes, 1)
  const minGrowth = queryConfig.minGrowth
  const includeStuck = queryConfig.includeStuck
  const maxAgeMinutes = Math.max(queryConfig.maxAgeMinutes, 1)

  const now = new Date()
  const recencyCutoff = new Date(now.getTime() - recencyMinutes * 60 * 1000).toISOString()
  const lastUpdateCutoff = new Date(now.getTime() - maxAgeMinutes * 60 * 1000).toISOString()

  const conditions = [
    'mcap_growth_percent IS NOT NULL',
    'current_mcap IS NOT NULL',
    'first_mcap IS NOT NULL',
    'first_mcap > 0',
    'current_mcap > 0',
  ]
  const params: unknown[] = []

  if (!includeStuck) {
    conditions.push('is_tracking_stuck = false')
  }

  params.push(recencyCutoff)
  conditions.push(`first_seen_at >= $${params.length}`)
  params.push(lastUpdateCutoff)
  conditions.push(`last_updated_at >= $${params.length}`)
  params.push(Math.min(minGrowth, 10000))
  conditions.push(`mcap_growth_percent >= $${params.length}`)
  params.push(limit * 5)
  const limitParam = `$${params.length}`

  const { rows } = await query<McapTrackingRow>(
    `SELECT token_address, token_symbol, first_mcap, current_mcap, mcap_growth_percent,
            first_seen_at, last_updated_at, when_reach_80pct, when_reach_120pct,
            when_reach_200pct, is_tracking_stuck
     FROM token_mcap_tracking
     WHERE ${conditions.join(' AND ')}
     ORDER BY mcap_growth_percent DESC
     LIMIT ${limitParam}`,
    params,
  )

  const items = rows

  for (const row of items) {
    normalizeTrackingTimeline(row as McapSnapshot)
  }

  const rollupMap = await fetchSocialRollupsMap(items.map((r) => r.token_address))

  let signals: ScoredSignal[] = []
  for (const row of items) {
    const rollup = rollupMap.get(row.token_address) ?? null
    const socialSnapshot = rollupToSocialSnapshot(rollup, now)
    if (strategyConfig.social) {
      const gate = evaluateSocialGate(socialSnapshot, strategyConfig.social, {
        tokenAddress: row.token_address,
        domain: 'signals',
      })
      if (!gate.passed) continue
    }
    signals.push(rowToScoredSignal(row, strategyConfig, socialSnapshot))
  }

  if (!options?.skipRugValidation) {
    signals = await validateTokensAgainstRugPulls(signals, strategyConfig)
  }

  const manualRugSet = await getRugAddressSet()
  signals = signals.filter((s) => !manualRugSet.has(s.token_address))

  return sortScoredSignals(signals).slice(0, limit)
}

export async function scoreSignalsForStrategy(
  strategy: SignalsStrategy,
  options?: { skipRugValidation?: boolean },
): Promise<ScoredSignal[]> {
  return fetchAndScoreSignals(strategy.config, options)
}
