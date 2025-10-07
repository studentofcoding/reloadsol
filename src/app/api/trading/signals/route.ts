import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'
import { isInTrackingRange, STOP_LOSS_THRESHOLD } from '@/utils/mcap-tracker'
import { log } from '@/utils/unified-logger'

type SignalItem = {
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
  // Computed
  in_tracking_range: boolean
  trend_age_minutes: number
  time_to_80_minutes?: number | null
  score: number
  decision: 'enter' | 'hold' | 'exit' | 'skip'
  rationale: string
}

function minutesBetween(aIso?: string | null, bIso?: string | null): number | null {
  if (!aIso || !bIso) return null
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  if (!isFinite(a) || !isFinite(b)) return null
  return Math.round(Math.abs(b - a) / (60 * 1000))
}

function computeScoreAndDecision(
  item: Omit<SignalItem, 'score' | 'decision' | 'rationale'>,
  params: { minGrowth: number; recencyMinutes: number }
) {
  const growth = item.mcap_growth_percent || 0
  const isStuck = item.is_tracking_stuck === true
  const nowIso = new Date().toISOString()
  const trendAge = minutesBetween(item.first_seen_at, nowIso) || 0
  const timeTo80 = minutesBetween(item.first_seen_at, item.when_reach_80mc)

  // Base score from current growth
  let score = growth

  // Recency boost: stronger boost for very recent tokens
  const recencyBoost = Math.max(0, (params.recencyMinutes - trendAge) / params.recencyMinutes) * 20
  score += recencyBoost

  // Threshold boosts
  if (item.when_reach_80mc) score += 15
  if (item.when_reach_120mc) score += 20
  if (item.when_reach_200mc) score += 25

  // Speed-to-80%: faster is better
  if (typeof timeTo80 === 'number') {
    if (timeTo80 <= 15) score += 15
    else if (timeTo80 <= 30) score += 10
    else if (timeTo80 <= 60) score += 5
  }

  // Tracking range boost
  if (item.in_tracking_range) score += 10

  // Penalties
  if (isStuck) score -= 50
  if (growth <= STOP_LOSS_THRESHOLD) score -= 100

  // Decision logic
  let decision: SignalItem['decision'] = 'skip'
  let rationale: string[] = []

  if (growth <= STOP_LOSS_THRESHOLD || isStuck) {
    decision = 'exit'
    rationale.push('Stop-loss or stuck triggered')
  } else if (growth >= params.minGrowth && score >= 50) {
    decision = 'enter'
    rationale.push('Strong momentum and recency')
    if (item.when_reach_80mc) rationale.push('Reached +80% threshold')
    if (typeof timeTo80 === 'number') rationale.push(`Reached +80% in ${timeTo80}m`)
  } else if (growth >= params.minGrowth * 0.5) {
    decision = 'hold'
    rationale.push('Moderate momentum, watching for continuation')
  } else {
    decision = 'skip'
    rationale.push('Insufficient momentum')
  }

  return { score, decision, rationale: rationale.join('; ') }
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '30'), 100)
    const recencyMinutes = Math.max(parseInt(searchParams.get('recencyMinutes') || '90'), 1)
    const minGrowth = parseFloat(searchParams.get('minGrowth') || '25')
    const includeStuck = searchParams.get('includeStuck') === 'true'
    const maxAgeMinutes = Math.max(parseInt(searchParams.get('maxAgeMinutes') || '60'), 1)

    // Build base query
    let query = supabase
      .from('token_mcap_tracking')
      .select(
        'token_address, token_symbol, first_mcap, current_mcap, mcap_growth_percent, first_seen_at, last_updated_at, when_reach_80mc, when_reach_120mc, when_reach_200mc, is_tracking_stuck'
      )
      .not('mcap_growth_percent', 'is', null)
      .not('current_mcap', 'is', null)
      .not('first_mcap', 'is', null)
      .gt('first_mcap', 0)
      .gt('current_mcap', 0)

    if (!includeStuck) {
      query = query.eq('is_tracking_stuck', false)
    }

    // Time filters
    const now = new Date()
    const recencyCutoff = new Date(now.getTime() - recencyMinutes * 60 * 1000).toISOString()
    const lastUpdateCutoff = new Date(now.getTime() - maxAgeMinutes * 60 * 1000).toISOString()

    query = query.gte('first_seen_at', recencyCutoff).gte('last_updated_at', lastUpdateCutoff)

    // Growth filter (server-side where possible)
    query = query.gte('mcap_growth_percent', Math.min(minGrowth, 10000)) // guard against extreme inputs

    // Order by growth descending as a first pass
    query = query.order('mcap_growth_percent', { ascending: false }).limit(limit * 5) // over-fetch for scoring

    const { data, error } = await query
    if (error) throw error

    const items = (data || []) as Array<{
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

    const signals: SignalItem[] = items.map((row) => {
      const inRange = isInTrackingRange(row.current_mcap)
      const trendAgeMinutes = minutesBetween(row.first_seen_at, new Date().toISOString()) || 0
      const timeTo80Minutes = minutesBetween(row.first_seen_at, row.when_reach_80mc)

      const base: Omit<SignalItem, 'score' | 'decision' | 'rationale'> = {
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
        in_tracking_range: inRange,
        trend_age_minutes: trendAgeMinutes,
        time_to_80_minutes: typeof timeTo80Minutes === 'number' ? timeTo80Minutes : null,
      }

      const { score, decision, rationale } = computeScoreAndDecision(base, { minGrowth, recencyMinutes })

      return {
        ...base,
        score,
        decision,
        rationale,
      }
    })

    // Final sort by score descending, then growth
    signals.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (b.mcap_growth_percent || 0) - (a.mcap_growth_percent || 0)
    })

    const limited = signals.slice(0, limit)

  log.info('mcap_tracker', 'Generated trading signals', {
      count: limited.length,
      fetched: items.length,
      params: { limit, recencyMinutes, minGrowth, includeStuck, maxAgeMinutes },
    })

    return NextResponse.json({
      success: true,
      params: { limit, recencyMinutes, minGrowth, includeStuck, maxAgeMinutes },
      stats: {
        totalCandidates: items.length,
        returnedSignals: limited.length,
      },
      signals: limited,
    })
  } catch (error) {
    log.error('error_handling', 'Failed to generate trading signals', error as Error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    )
  } finally {
    const duration = Date.now() - startedAt
  log.info('api_request', 'Signals request completed', { durationMs: duration })
  }
}