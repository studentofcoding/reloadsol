/**
 * Live sim_only bandit: spawn/kill search experiment strategies (P2).
 * Cap concurrent search_* clones; kill on Review loss streaks.
 */

import {
  computeFitnessByStrategy,
  DEFAULT_FITNESS,
  type FitnessConfig,
} from '@/strategies/strategy-fitness'
import {
  listStrategyOutcomes,
  loadStrategyDefinitionRows,
  upsertStrategyDefinition,
} from '@/strategies/db'
import { invalidateMcapTrackerCache } from '@/strategies/load-mcap-tracker'
import { invalidateGmgnCache } from '@/strategies/load-gmgn'
import { invalidateSignalsCache } from '@/strategies/load-signals'
import {
  MCAP_TRACKER_STRATEGIES,
  GMGN_STRATEGIES,
  SIGNALS_STRATEGIES,
} from '@/strategies/registry'
import type { StrategyDomain } from '@/strategies/types'

export const SEARCH_ID_PREFIX = {
  mcap_tracker: 'search_mcap_',
  gmgn: 'search_gmgn_',
  signals: 'search_signals_',
} as const

export const MAX_CONCURRENT_SEARCH = 3

export type CandidateConfig = {
  id: string
  config: {
    entry?: Record<string, unknown>
    exit?: Record<string, unknown>
    entryTemplate?: string
    discovery?: Record<string, unknown>
    security?: Record<string, unknown>
    query?: Record<string, unknown>
    enterScoreFloor?: number
    template?: string
  }
  beatsBaseline?: boolean
}

function slug(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 48)
}

export function searchStrategyId(domain: StrategyDomain, candidateId: string): string {
  const prefix =
    domain === 'gmgn'
      ? SEARCH_ID_PREFIX.gmgn
      : domain === 'signals'
        ? SEARCH_ID_PREFIX.signals
        : SEARCH_ID_PREFIX.mcap_tracker
  return `${prefix}${slug(candidateId)}`
}

export function isSearchStrategyId(id: string): boolean {
  return (
    id.startsWith(SEARCH_ID_PREFIX.mcap_tracker) ||
    id.startsWith(SEARCH_ID_PREFIX.gmgn) ||
    id.startsWith(SEARCH_ID_PREFIX.signals)
  )
}

export async function listActiveSearchStrategies(
  domain: StrategyDomain,
): Promise<Array<{ id: string; is_active: boolean; name: string }>> {
  const rows = await loadStrategyDefinitionRows(domain)
  return rows
    .filter((r) => isSearchStrategyId(r.id) && r.is_active)
    .map((r) => ({ id: r.id, is_active: r.is_active, name: r.name }))
}

function mcapConfigFromCandidate(c: CandidateConfig) {
  const entryTemplate =
    (c.config.entryTemplate as 'first_seen' | 'milestone_80' | undefined) ??
    (c.config.entry?.entryTemplate as 'first_seen' | 'milestone_80' | undefined) ??
    'first_seen'
  const base =
    entryTemplate === 'milestone_80'
      ? MCAP_TRACKER_STRATEGIES.mcap_enter_at_80
      : MCAP_TRACKER_STRATEGIES.mcap_enter_first_seen
  const entry = { ...base.config.entry, ...(c.config.entry ?? {}) }
  const exit = { ...base.config.exit, ...(c.config.exit ?? {}) }
  return {
    ...base.config,
    entryTemplate,
    entry: {
      mcapMin: Number(entry.mcapMin ?? base.config.entry.mcapMin),
      mcapMax: Number(entry.mcapMax ?? base.config.entry.mcapMax),
      organicScoreMin: entry.organicScoreMin as number | undefined,
      topHoldersPctMax: entry.topHoldersPctMax as number | undefined,
    },
    exit: {
      stopLossPct: Number(exit.stopLossPct ?? base.config.exit.stopLossPct),
      takeProfitPct: Number(exit.takeProfitPct ?? base.config.exit.takeProfitPct),
      maxHoldHours: Number(exit.maxHoldHours ?? base.config.exit.maxHoldHours),
    },
  }
}

function gmgnConfigFromCandidate(c: CandidateConfig) {
  const base = GMGN_STRATEGIES.gmgn_smartmoney_default
  return {
    ...base.config,
    discovery: { ...base.config.discovery, ...(c.config.discovery ?? {}) },
    security: { ...base.config.security, ...(c.config.security ?? {}) },
    exit: { ...base.config.exit, ...(c.config.exit ?? {}) },
  }
}

function signalsConfigFromCandidate(c: CandidateConfig) {
  const base = SIGNALS_STRATEGIES.signals_default
  return {
    ...base.config,
    template: (c.config.template as typeof base.config.template) ?? base.config.template,
    enterScoreFloor: Number(
      c.config.enterScoreFloor ?? base.config.enterScoreFloor,
    ),
    query: { ...base.config.query, ...(c.config.query ?? {}) },
  }
}

export async function spawnSearchStrategy(params: {
  domain: StrategyDomain
  candidate: CandidateConfig
}): Promise<{ ok: boolean; id: string; error?: string }> {
  const id = searchStrategyId(params.domain, params.candidate.id)
  const active = await listActiveSearchStrategies(params.domain)
  if (active.some((a) => a.id === id)) {
    return { ok: true, id }
  }
  if (active.length >= MAX_CONCURRENT_SEARCH) {
    return {
      ok: false,
      id,
      error: `max ${MAX_CONCURRENT_SEARCH} active search strategies for ${params.domain}`,
    }
  }

  let config: Record<string, unknown>
  let name: string
  if (params.domain === 'gmgn') {
    config = gmgnConfigFromCandidate(params.candidate) as unknown as Record<string, unknown>
    name = `Search GMGN ${params.candidate.id}`
  } else if (params.domain === 'signals') {
    config = signalsConfigFromCandidate(params.candidate) as unknown as Record<string, unknown>
    name = `Search Signals ${params.candidate.id}`
  } else {
    config = mcapConfigFromCandidate(params.candidate) as unknown as Record<string, unknown>
    name = `Search MCAP ${params.candidate.id}`
  }

  const result = await upsertStrategyDefinition({
    id,
    domain: params.domain,
    name,
    description: `Auto-spawned sim_only experiment from strategy search (${params.candidate.id})`,
    config,
    is_active: true,
    execution_mode: 'sim_only',
  })

  if (result.ok) {
    if (params.domain === 'gmgn') invalidateGmgnCache()
    else if (params.domain === 'signals') invalidateSignalsCache()
    else invalidateMcapTrackerCache()
  }
  return { ok: result.ok, id, error: result.error }
}

export async function killSearchStrategy(params: {
  domain: StrategyDomain
  id: string
  reason: string
}): Promise<{ ok: boolean; error?: string }> {
  if (!isSearchStrategyId(params.id)) {
    return { ok: false, error: 'not a search strategy id' }
  }
  const rows = await loadStrategyDefinitionRows(params.domain)
  const row = rows.find((r) => r.id === params.id)
  if (!row) return { ok: false, error: 'not found' }

  const result = await upsertStrategyDefinition({
    id: params.id,
    domain: params.domain,
    name: row.name,
    description: `${row.description ?? ''}\n[killed] ${params.reason}`.trim(),
    config: (row.config ?? {}) as Record<string, unknown>,
    is_active: false,
    execution_mode: 'sim_only',
  })
  if (result.ok) {
    if (params.domain === 'gmgn') invalidateGmgnCache()
    else if (params.domain === 'signals') invalidateSignalsCache()
    else invalidateMcapTrackerCache()
  }
  return result
}

/**
 * Kill search strategies that have had a fair trial (≥ minCloses in the window)
 * and still fail the shared fitness definition (expectancy ≤ 0 or a drawdown week).
 */
export async function pruneLosingSearchStrategies(params: {
  domain: StrategyDomain
  fitness?: Partial<FitnessConfig>
}): Promise<Array<{ id: string; reason: string }>> {
  const { rows } = await listStrategyOutcomes({
    domain: params.domain,
    limit: 5000,
    offset: 0,
  })
  const byStrategy = computeFitnessByStrategy(rows, params.fitness)
  const minCloses = params.fitness?.minCloses ?? DEFAULT_FITNESS.minCloses
  const killed: Array<{ id: string; reason: string }> = []
  const active = await listActiveSearchStrategies(params.domain)

  for (const s of active) {
    const fit = byStrategy.get(s.id)
    // Not enough closes yet → keep exploring.
    if (!fit || fit.closes < minCloses || fit.passes) continue
    const reason = `fitness: ${fit.reasons.join('; ')} (exp=${fit.expectancyPct}%, n=${fit.closes})`
    const res = await killSearchStrategy({ domain: params.domain, id: s.id, reason })
    if (res.ok) killed.push({ id: s.id, reason })
  }
  return killed
}

export async function spawnFromCandidatesFile(params: {
  domain: StrategyDomain
  candidates: CandidateConfig[]
  onlyBeatsBaseline?: boolean
}): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const list = params.onlyBeatsBaseline
    ? params.candidates.filter((c) => c.beatsBaseline === true)
    : params.candidates
  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const candidate of list) {
    const active = await listActiveSearchStrategies(params.domain)
    if (active.length >= MAX_CONCURRENT_SEARCH) break
    results.push(await spawnSearchStrategy({ domain: params.domain, candidate }))
  }
  return results
}
