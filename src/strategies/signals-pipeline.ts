import { supabase } from '@/utils/supabase'
import { isInTrackingRange } from '@/utils/mcap-tracker'
import { getRugAddressSet } from '@/utils/rug-list/db'
import { log } from '@/utils/unified-logger'
import {
  computeScoreAndDecision,
  minutesBetween,
  type SignalScoringItem,
} from './signals-scoring'
import type { SignalsStrategy, SignalsStrategyConfig } from './types'

export type ScoredSignal = SignalScoringItem & {
  score: number
  decision: 'enter' | 'hold' | 'exit' | 'skip'
  rationale: string
}

async function validateTokensAgainstRugPulls(
  signals: ScoredSignal[],
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
      validatedSignals.push({
        ...signal,
        current_mcap: currentMcap,
        mcap_growth_percent:
          ((currentMcap - signal.first_mcap) / signal.first_mcap) * 100,
      })
    }
  }

  return validatedSignals
}

export async function fetchAndScoreSignals(
  strategyConfig: SignalsStrategyConfig,
  options?: { skipRugValidation?: boolean },
): Promise<ScoredSignal[]> {
  const { query } = strategyConfig
  const limit = Math.min(query.limit, 100)
  const recencyMinutes = Math.max(query.recencyMinutes, 1)
  const minGrowth = query.minGrowth
  const includeStuck = query.includeStuck
  const maxAgeMinutes = Math.max(query.maxAgeMinutes, 1)

  let dbQuery = supabase
    .from('token_mcap_tracking')
    .select(
      'token_address, token_symbol, first_mcap, current_mcap, mcap_growth_percent, first_seen_at, last_updated_at, when_reach_80mc, when_reach_120mc, when_reach_200mc, is_tracking_stuck',
    )
    .not('mcap_growth_percent', 'is', null)
    .not('current_mcap', 'is', null)
    .not('first_mcap', 'is', null)
    .gt('first_mcap', 0)
    .gt('current_mcap', 0)

  if (!includeStuck) {
    dbQuery = dbQuery.eq('is_tracking_stuck', false)
  }

  const now = new Date()
  const recencyCutoff = new Date(now.getTime() - recencyMinutes * 60 * 1000).toISOString()
  const lastUpdateCutoff = new Date(now.getTime() - maxAgeMinutes * 60 * 1000).toISOString()

  dbQuery = dbQuery
    .gte('first_seen_at', recencyCutoff)
    .gte('last_updated_at', lastUpdateCutoff)
    .gte('mcap_growth_percent', Math.min(minGrowth, 10000))
    .order('mcap_growth_percent', { ascending: false })
    .limit(limit * 5)

  const { data, error } = await dbQuery
  if (error) throw error

  const items = (data ?? []) as Array<{
    token_address: string
    token_symbol: string
    first_mcap: number
    current_mcap: number
    mcap_growth_percent: number
    first_seen_at: string
    last_updated_at: string
    when_reach_80mc?: string | null
    when_reach_120mc?: string | null
    when_reach_200mc?: string | null
    is_tracking_stuck?: boolean
  }>

  let signals: ScoredSignal[] = items.map((row) => {
    const base: SignalScoringItem = {
      token_address: row.token_address,
      token_symbol: row.token_symbol,
      first_mcap: row.first_mcap,
      current_mcap: row.current_mcap,
      mcap_growth_percent: row.mcap_growth_percent,
      first_seen_at: row.first_seen_at,
      last_updated_at: row.last_updated_at,
      when_reach_80mc: row.when_reach_80mc,
      when_reach_120mc: row.when_reach_120mc,
      when_reach_200mc: row.when_reach_200mc,
      is_tracking_stuck: row.is_tracking_stuck,
      in_tracking_range: isInTrackingRange(row.current_mcap),
      trend_age_minutes: minutesBetween(row.first_seen_at, new Date().toISOString()) || 0,
      time_to_80_minutes: (() => {
        const t = minutesBetween(row.first_seen_at, row.when_reach_80mc)
        return typeof t === 'number' ? t : null
      })(),
    }
    const { score, decision, rationale } = computeScoreAndDecision(base, strategyConfig)
    return { ...base, score, decision, rationale }
  })

  if (!options?.skipRugValidation) {
    signals = await validateTokensAgainstRugPulls(signals)
  }

  const manualRugSet = await getRugAddressSet()
  signals = signals.filter((s) => !manualRugSet.has(s.token_address))

  signals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (b.mcap_growth_percent || 0) - (a.mcap_growth_percent || 0)
  })

  return signals.slice(0, limit)
}

export async function scoreSignalsForStrategy(
  strategy: SignalsStrategy,
  options?: { skipRugValidation?: boolean },
): Promise<ScoredSignal[]> {
  return fetchAndScoreSignals(strategy.config, options)
}
