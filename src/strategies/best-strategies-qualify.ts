/**
 * Cached set of strategy_ids that currently qualify as “best” emitters.
 * Researchy lock: avg×n+win% among strategies that pass min-n floors.
 * Hypothesis / low-n never enter this set.
 */

import { aggregateStrategyReports } from './db'
import {
  DEFAULT_BEST_STRATEGIES_TOP_N,
  qualifyBestStrategies,
  rankedBestStrategyIds,
  type BestStrategyRankRow,
  type BestStrategiesBoard,
} from './best-strategies-rank'
import type { StrategyDomain } from './types'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CACHE_KEY = 'best_strategies:qualified_ids_v3'
const CACHE_TTL_S = 15 * 60
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const DEFAULT_DOMAINS: StrategyDomain[] = [
  'mcap_tracker',
  'trending_bot',
  'signals',
  'gmgn',
]

export type QualifiedBestStrategies = {
  refreshedAtMs: number
  ids: string[]
  rows: BestStrategyRankRow[]
  /** Below-floor strategies (footnote only; never Telegram blast). */
  hypothesis: BestStrategyRankRow[]
}

function readTopN(): number {
  const raw = process.env.BEST_STRATEGIES_TOP_N
  if (!raw) return DEFAULT_BEST_STRATEGIES_TOP_N
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : DEFAULT_BEST_STRATEGIES_TOP_N
}

export async function refreshQualifiedBestStrategies(): Promise<QualifiedBestStrategies> {
  const topN = readTopN()
  const weekFrom = new Date(Date.now() - WEEK_MS).toISOString()

  const [allTime, week] = await Promise.all([
    aggregateStrategyReports({}),
    aggregateStrategyReports({ from: weekFrom }),
  ])

  const board: BestStrategiesBoard = qualifyBestStrategies({
    allTime: allTime.breakdown,
    week: week.breakdown,
    topN,
    domains: DEFAULT_DOMAINS,
  })

  const ids = rankedBestStrategyIds(board)

  const payload: QualifiedBestStrategies = {
    refreshedAtMs: Date.now(),
    ids,
    rows: board.ranked,
    hypothesis: board.hypothesis,
  }
  await cacheSet(CACHE_KEY, payload, CACHE_TTL_S)
  return payload
}

export async function getQualifiedBestStrategyIds(): Promise<Set<string>> {
  const cached = await cacheGet<QualifiedBestStrategies>(CACHE_KEY)
  if (cached?.ids) {
    return new Set(cached.ids)
  }
  const fresh = await refreshQualifiedBestStrategies()
  return new Set(fresh.ids)
}

export async function isQualifiedBestStrategy(
  strategyId: string,
): Promise<boolean> {
  const ids = await getQualifiedBestStrategyIds()
  return ids.has(strategyId)
}

/** Rank place (1-based) + row for a strategy in the current ranked board. */
export async function getQualifiedBestStrategyRank(
  strategyId: string,
): Promise<{ place: number; row: BestStrategyRankRow } | null> {
  const cached = await cacheGet<QualifiedBestStrategies>(CACHE_KEY)
  const payload = cached?.rows?.length
    ? cached
    : await refreshQualifiedBestStrategies()
  const idx = payload.rows.findIndex((r) => r.strategy_id === strategyId)
  if (idx < 0) return null
  return { place: idx + 1, row: payload.rows[idx]! }
}
