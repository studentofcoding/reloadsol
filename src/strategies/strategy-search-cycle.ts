import {
  passesEntryFilter,
  type McapSearchConfig,
} from '@/strategies/mcap-exit-replay'
import {
  passesGmgnEntryFilter,
  passesSignalsEntryFilter,
  runDomainSearch,
} from '@/strategies/domain-strategy-search'
import { readMlGatePBad } from '@/strategies/outcome-features'
import {
  computeFitnessByStrategy,
  DEFAULT_FITNESS,
  type StrategyFitness,
} from '@/strategies/strategy-fitness'
import {
  type CandidateConfig,
  isSearchStrategyId,
  listActiveSearchStrategies,
  pruneLosingSearchStrategies,
  spawnFromCandidatesFile,
} from '@/strategies/strategy-search-bandit'
import {
  listStrategyOutcomes,
  loadStrategyDefinitionById,
  upsertStrategyDefinition,
} from '@/strategies/db'
import { invalidateGmgnCache } from '@/strategies/load-gmgn'
import { invalidateMcapTrackerCache } from '@/strategies/load-mcap-tracker'
import { invalidateSignalsCache } from '@/strategies/load-signals'
import type { StrategyDomain, StrategyOutcomeRow } from '@/strategies/types'

export const SEARCH_CYCLE_DOMAINS: StrategyDomain[] = ['mcap_tracker', 'gmgn', 'signals']

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function meanPBad(rows: readonly StrategyOutcomeRow[]): { mean: number | null; n: number } {
  const vals: number[] = []
  for (const row of rows) {
    const v = readMlGatePBad(row.features)
    if (v != null && Number.isFinite(v)) vals.push(v)
  }
  if (vals.length === 0) return { mean: null, n: 0 }
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }
}

/** Rank for spawn order: PnL discounted by pBad (0 → full, 1 → half). */
export function spawnRank(avgPnlPct: number, meanPBadValue: number | null): number {
  const p =
    meanPBadValue == null || !Number.isFinite(meanPBadValue)
      ? 0
      : Math.min(1, Math.max(0, meanPBadValue))
  return avgPnlPct * (1 - 0.5 * p)
}

export function passesPBadPrior(
  mean: number | null,
  n: number,
  max = envNum('SOL_SEARCH_PBAD_MAX', 0.65),
  minN = 10,
): boolean {
  if (mean == null || n < minN) return true
  return mean <= max
}

export function shouldReplaceCanonical(
  search: StrategyFitness,
  canonical: StrategyFitness | null,
): boolean {
  if (!search.passes) return false
  if (!canonical) return true
  return search.expectancyPct > canonical.expectancyPct
}

export function canonicalSimId(
  domain: StrategyDomain,
  candidate: CandidateConfig,
): string | null {
  if (domain === 'signals') return 'signals_default'
  if (domain === 'gmgn') return 'gmgn_smartmoney_default'
  if (domain === 'mcap_tracker') {
    return candidate.config.entryTemplate === 'milestone_80'
      ? 'mcap_enter_at_80'
      : 'mcap_enter_first_seen'
  }
  return null
}

export function candidateFromSearchRow(params: {
  domain: StrategyDomain
  configId: string
  config: unknown
}): CandidateConfig {
  if (params.domain === 'mcap_tracker') {
    const c = params.config as McapSearchConfig
    return {
      id: c.id ?? params.configId,
      beatsBaseline: true,
      config: {
        entry: c.entry as unknown as Record<string, unknown>,
        exit: c.exit as unknown as Record<string, unknown>,
        entryTemplate: c.entry?.entryTemplate,
      },
    }
  }
  const raw = (params.config ?? {}) as Record<string, unknown>
  const nested = raw.params && typeof raw.params === 'object' ? (raw.params as Record<string, unknown>) : raw
  return {
    id: params.configId,
    beatsBaseline: true,
    config: nested,
  }
}

function rowsForCandidate(
  domain: StrategyDomain,
  candidate: CandidateConfig,
  rows: StrategyOutcomeRow[],
): StrategyOutcomeRow[] {
  if (domain === 'mcap_tracker') {
    const entry = (candidate.config.entry ?? {}) as {
      mcapMin?: number
      mcapMax?: number
      entryTemplate?: 'first_seen' | 'milestone_80'
    }
    return rows.filter((r) =>
      passesEntryFilter(r, {
        mcapMin: Number(entry.mcapMin ?? 0),
        mcapMax: Number(entry.mcapMax ?? Number.MAX_SAFE_INTEGER),
        entryTemplate: entry.entryTemplate,
      }),
    )
  }
  if (domain === 'gmgn') {
    const security = (candidate.config.security ?? {}) as Record<string, unknown>
    const extra = candidate.config as Record<string, unknown>
    return rows.filter((r) =>
      passesGmgnEntryFilter(r, {
        minSmartWallets: Number(security.minSmartWallets ?? 0) || undefined,
        maxTop10HolderRate: Number(security.maxTop10HolderRate ?? 0) || undefined,
        minRadarScore: Number(extra.minRadarScore ?? 0) || undefined,
      }),
    )
  }
  return rows.filter((r) =>
    passesSignalsEntryFilter(r, {
      enterScoreFloor: Number(candidate.config.enterScoreFloor ?? 0) || undefined,
      minGrowth: Number((candidate.config.query as { minGrowth?: number } | undefined)?.minGrowth ?? 0) || undefined,
      template: typeof candidate.config.template === 'string' ? candidate.config.template : undefined,
    }),
  )
}

export function rankAndFilterCandidates(params: {
  domain: StrategyDomain
  rows: StrategyOutcomeRow[]
  beatBaseline: Array<{ configId: string; config: unknown; holdout: { avgPnlPct: number } }>
}): CandidateConfig[] {
  const scored = params.beatBaseline.map((row) => {
    const candidate = candidateFromSearchRow({
      domain: params.domain,
      configId: row.configId,
      config: row.config,
    })
    const prior = meanPBad(rowsForCandidate(params.domain, candidate, params.rows))
    return {
      candidate,
      prior,
      rank: spawnRank(row.holdout.avgPnlPct, prior.mean),
    }
  })
  return scored
    .filter((s) => passesPBadPrior(s.prior.mean, s.prior.n))
    .sort((a, b) => b.rank - a.rank)
    .map((s) => s.candidate)
}

function invalidate(domain: StrategyDomain): void {
  if (domain === 'gmgn') invalidateGmgnCache()
  else if (domain === 'signals') invalidateSignalsCache()
  else invalidateMcapTrackerCache()
}

export async function maybeReplaceCanonicalSim(params: {
  domain: StrategyDomain
  outcomes: StrategyOutcomeRow[]
}): Promise<{ replaced: string | null; from?: string; reason?: string }> {
  const active = await listActiveSearchStrategies(params.domain)
  if (active.length === 0) return { replaced: null }
  const byStrategy = computeFitnessByStrategy(params.outcomes)
  let best: { id: string; fit: StrategyFitness } | null = null
  for (const s of active) {
    const fit = byStrategy.get(s.id)
    if (!fit || !fit.passes) continue
    if (!best || fit.expectancyPct > best.fit.expectancyPct) best = { id: s.id, fit }
  }
  if (!best) return { replaced: null, reason: 'no passing search_*' }

  const searchRow = await loadStrategyDefinitionById(best.id)
  if (!searchRow?.config) return { replaced: null, reason: 'search row missing' }
  const candidate: CandidateConfig = {
    id: best.id,
    config: searchRow.config as CandidateConfig['config'],
  }
  const targetId = canonicalSimId(params.domain, candidate)
  if (!targetId || targetId === best.id) return { replaced: null, reason: 'no canonical target' }

  const canonicalFit = byStrategy.get(targetId) ?? null
  if (!shouldReplaceCanonical(best.fit, canonicalFit)) {
    return { replaced: null, from: best.id, reason: 'does not beat canonical' }
  }

  const target = await loadStrategyDefinitionById(targetId)
  const result = await upsertStrategyDefinition({
    id: targetId,
    domain: params.domain,
    name: target?.name ?? targetId,
    description: `${target?.description ?? ''}\n[auto-sim from ${best.id} @ ${new Date().toISOString()} exp=${best.fit.expectancyPct}% n=${best.fit.closes}]`.trim(),
    config: (searchRow.config ?? {}) as Record<string, unknown>,
    is_active: true,
    execution_mode: 'sim_only',
  })
  if (!result.ok) return { replaced: null, from: best.id, reason: result.error }
  invalidate(params.domain)
  return { replaced: targetId, from: best.id }
}

export type SearchCycleResult = {
  domain: StrategyDomain
  pruned: Array<{ id: string; reason: string }>
  spawned: Array<{ id: string; ok: boolean; error?: string }>
  candidates: number
  canonical: { replaced: string | null; from?: string; reason?: string }
}

export async function runStrategySearchCycle(
  domain: StrategyDomain,
): Promise<SearchCycleResult> {
  const { rows } = await listStrategyOutcomes({ domain, limit: 5000, offset: 0 })
  const search = runDomainSearch({ domain, rows })
  const pruned = await pruneLosingSearchStrategies({ domain })
  const candidates = rankAndFilterCandidates({
    domain,
    rows,
    beatBaseline: search.beatBaseline.map((r) => ({
      configId: r.configId,
      config: r.config,
      holdout: { avgPnlPct: r.holdout.avgPnlPct },
    })),
  })
  const spawned = await spawnFromCandidatesFile({
    domain,
    candidates,
    onlyBeatsBaseline: true,
  })
  const canonical = await maybeReplaceCanonicalSim({ domain, outcomes: rows })
  return {
    domain,
    pruned,
    spawned,
    candidates: candidates.length,
    canonical,
  }
}

export async function runAllStrategySearchCycles(): Promise<SearchCycleResult[]> {
  const out: SearchCycleResult[] = []
  for (const domain of SEARCH_CYCLE_DOMAINS) {
    out.push(await runStrategySearchCycle(domain))
  }
  return out
}

export { isSearchStrategyId, DEFAULT_FITNESS }
