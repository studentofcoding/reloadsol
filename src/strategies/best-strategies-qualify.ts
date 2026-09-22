/**
 * Cached set of strategy_ids that currently qualify as “best” emitters
 * (Researchy min-n + locked avg×n+win% rank).
 */

import { aggregateStrategyReports } from './db'
import {
  DEFAULT_BEST_STRATEGIES_TOP_N,
  qualifyBestStrategies,
  type BestStrategyRankRow,
} from './best-strategies-rank'
import type { StrategyDomain } from './types'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CACHE_KEY = 'best_strategies:qualified_ids_v1'
const CACHE_TTL_S = 15 * 60
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Domains that typically have outcomes (mcap principals are the high-n winners today). */
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

  const rows = qualifyBestStrategies({
    allTime: allTime.breakdown,
    week: week.breakdown,
    topN,
    domains: DEFAULT_DOMAINS,
  })

  // Collapse SIM/LIVE twins: any mode that qualifies counts the strategy_id.
  const ids = [...new Set(rows.map((r) => r.strategy_id))]

  const payload: QualifiedBestStrategies = {
    refreshedAtMs: Date.now(),
    ids,
    rows,
  }
  await cacheSet(CACHE_KEY, payload, CACHE_TTL_S)
  return payload
}

export async function getQualifiedBestStrategyIds(): Promise<Set<string>> {
  const cached = await cacheGet<QualifiedBestStrategies>(CACHE_KEY)
  if (cached?.ids?.length) {
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
