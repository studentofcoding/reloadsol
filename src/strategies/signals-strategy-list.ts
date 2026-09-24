import { getMcapSimOpenSkipReason } from '@/utils/mcap-sim-track'
import type { McapSnapshot } from '@/utils/mcap-tracker'
import {
  signalsListStrategyIds,
  type SignalsListChain,
  type SignalsListPickerOption,
} from '@/utils/signals-strategy-id'
import { MCAP_TRACKER_STRATEGIES, SIGNALS_STRATEGIES } from './registry'
import { computeScoreAndDecision, type SignalScoringItem } from './signals-scoring'
import type { ScoredSignal } from './signals-pipeline'
import type {
  McapTrackerStrategy,
  SignalsStrategyConfig,
  StrategyChain,
  StrategyDomain,
} from './types'

/**
 * Signals tab list: picker rank + unique-mint membership.
 * Closed PnL orders the picker. It does not decide which mints appear.
 * Soft-active and Noul are not inputs here.
 */

export const SIGNALS_LIST_SCORING = {
  recencyBoostMax: 20,
  milestone80: 15,
  milestone120: 20,
  milestone200: 25,
  speedTo80Fast: 15,
  speedTo80Medium: 10,
  speedTo80Slow: 5,
  inTrackingRange: 10,
  stuckPenalty: 50,
  stopLossPenalty: 100,
  sellOver100LatePenalty: 40,
} as const

type UniverseEntry = {
  strategyId: string
  domain: 'signals' | 'mcap_tracker'
  template?: 'default' | 'sell_over_100'
}

const UNIVERSE: Record<SignalsListChain, readonly UniverseEntry[]> = {
  sol: [
    { strategyId: 'signals_default', domain: 'signals', template: 'default' },
    { strategyId: 'signals_sell_over_100', domain: 'signals', template: 'sell_over_100' },
    { strategyId: 'mcap_enter_first_seen', domain: 'mcap_tracker' },
    { strategyId: 'mcap_enter_at_80', domain: 'mcap_tracker' },
  ],
  robinhood: [
    { strategyId: 'signals_default_rh', domain: 'signals', template: 'default' },
    { strategyId: 'mcap_enter_first_seen_rh', domain: 'mcap_tracker' },
    { strategyId: 'mcap_enter_at_80_rh', domain: 'mcap_tracker' },
  ],
}

export type SignalsListPnlRow = {
  strategy_id: string
  domain?: StrategyDomain
  is_simulated: boolean
  trade_count: number
  avg_pnl_pct: number
  total_pnl_pct: number
}

export type SignalsListAlsoMatch = { strategyId: string; name: string }

export type SignalsListQueryResolution =
  | { ok: true; strategyId: string }
  | { ok: false; error: string }

export function signalsListUniverse(chain: StrategyChain): readonly UniverseEntry[] {
  return UNIVERSE[chain]
}

export function signalsListTemplate(
  strategyId: string,
): 'default' | 'sell_over_100' | null {
  for (const entries of Object.values(UNIVERSE)) {
    const found = entries.find((entry) => entry.strategyId === strategyId)
    if (found) return found.template ?? null
  }
  return null
}

export function signalsListEntry(
  chain: StrategyChain,
  strategyId: string,
): UniverseEntry | null {
  return UNIVERSE[chain].find((entry) => entry.strategyId === strategyId) ?? null
}

/**
 * `default` → signals_default, `sell_over_100` → signals_sell_over_100.
 * Any id outside the chain universe is 400. Robinhood has no sell-over-100 twin.
 */
export function resolveSignalsListQueryStrategy(
  raw: string | null | undefined,
  chain: StrategyChain,
): SignalsListQueryResolution {
  const trimmed = (raw ?? '').trim()
  const mapped =
    trimmed === '' || trimmed === 'default'
      ? 'signals_default'
      : trimmed === 'sell_over_100'
        ? 'signals_sell_over_100'
        : trimmed
  if (!signalsListStrategyIds(chain).includes(mapped)) {
    return { ok: false, error: `Unknown strategy: ${trimmed || 'default'}` }
  }
  return { ok: true, strategyId: mapped }
}

/** Hardcoded route floors. Not a DB-merged signals config. */
export function buildSignalsListStrategyConfig(
  template: 'default' | 'sell_over_100',
  query: SignalsStrategyConfig['query'],
): SignalsStrategyConfig {
  return {
    template,
    enterScoreFloor: 50,
    query: {
      holdGrowthFloor: 10,
      ...query,
    },
    scoring: { ...SIGNALS_LIST_SCORING },
    execution: { simBuySol: 0.01, maxOpenPositions: 10 },
  }
}

function displayName(strategyId: string, overrides?: Record<string, string>): string {
  const override = overrides?.[strategyId]?.trim()
  if (override) return override
  return (
    SIGNALS_STRATEGIES[strategyId]?.name ??
    MCAP_TRACKER_STRATEGIES[strategyId]?.name ??
    strategyId
  )
}

function simBreakdown(
  entry: UniverseEntry,
  rows: readonly SignalsListPnlRow[],
): SignalsListPnlRow | undefined {
  return rows.find(
    (row) =>
      row.strategy_id === entry.strategyId &&
      row.is_simulated === true &&
      (row.domain == null || row.domain === entry.domain),
  )
}

/**
 * Picker order: sim trade_count > 0 first, then raw avg_pnl_pct desc,
 * then total_pnl_pct desc, then strategy_id asc.
 * No min-n floor. No avg × n. No win%. Tiny-n outranks a lower mean.
 */
/** Instant picker seed: universe names with n=0 (no DB). */
export function seedSignalsListStrategies(
  chain: StrategyChain,
  nameOverrides?: Record<string, string>,
): SignalsListPickerOption[] {
  return rankSignalsListStrategies(chain, [], nameOverrides)
}

export function rankSignalsListStrategies(
  chain: StrategyChain,
  breakdown: readonly SignalsListPnlRow[],
  nameOverrides?: Record<string, string>,
): SignalsListPickerOption[] {
  const ranked = UNIVERSE[chain].map((entry) => {
    const row = simBreakdown(entry, breakdown)
    const n = row?.trade_count ?? 0
    const sampled = n > 0 && row != null
    return {
      strategyId: entry.strategyId,
      name: displayName(entry.strategyId, nameOverrides),
      domain: entry.domain,
      avgPnlPct: sampled ? row.avg_pnl_pct : null,
      totalPnlPct: sampled ? row.total_pnl_pct : null,
      n,
      avg: sampled ? row.avg_pnl_pct : 0,
      sum: sampled ? row.total_pnl_pct : 0,
    }
  })

  ranked.sort((a, b) => {
    const aSample = a.n > 0
    const bSample = b.n > 0
    if (aSample !== bSample) return aSample ? -1 : 1
    if (aSample && bSample) {
      if (a.avg !== b.avg) return b.avg - a.avg
      if (a.sum !== b.sum) return b.sum - a.sum
    }
    return a.strategyId.localeCompare(b.strategyId)
  })

  return ranked.map((row) => ({
    strategyId: row.strategyId,
    name: row.name,
    domain: row.domain,
    avgPnlPct: row.avgPnlPct,
    totalPnlPct: row.totalPnlPct,
    n: row.n,
  }))
}

function toMcapSnapshot(item: SignalScoringItem & {
  organic_score?: number | null
  top_holders_pct?: number | null
}): McapSnapshot {
  return {
    token_address: item.token_address,
    token_symbol: item.token_symbol,
    first_mcap: item.first_mcap,
    current_mcap: item.current_mcap,
    first_seen_at: item.first_seen_at,
    last_updated_at: item.last_updated_at,
    mcap_growth_percent: item.mcap_growth_percent,
    when_reach_80pct: item.when_reach_80pct,
    when_reach_120pct: item.when_reach_120pct,
    when_reach_200pct: item.when_reach_200pct,
    when_drop_40pct: item.when_drop_40pct,
    when_drop_80pct: item.when_drop_80pct,
    peak_mcap: item.peak_mcap,
    peak_growth_percent: item.peak_growth_percent,
    peak_seen_at: item.peak_seen_at,
    label: (item.label ?? null) as McapSnapshot['label'],
    is_tracking_stuck: item.is_tracking_stuck,
    organic_score: item.organic_score,
    top_holders_pct: item.top_holders_pct,
  }
}

function mcapStrategyFor(
  strategyId: string,
  registry: Record<string, McapTrackerStrategy>,
): McapTrackerStrategy | null {
  return registry[strategyId] ?? MCAP_TRACKER_STRATEGIES[strategyId] ?? null
}

function strategyMatches(
  entry: UniverseEntry,
  item: ScoredSignal,
  scoreConfig: SignalsStrategyConfig,
  mcapById: Record<string, McapTrackerStrategy>,
  openMints: Set<string>,
  closedMints: Set<string>,
): boolean {
  if (entry.domain === 'signals' && entry.template) {
    const result = computeScoreAndDecision(item, {
      ...scoreConfig,
      template: entry.template,
    })
    return result.decision === 'enter' || result.decision === 'hold'
  }
  const strategy = mcapStrategyFor(entry.strategyId, mcapById)
  if (!strategy) return false
  return (
    getMcapSimOpenSkipReason(strategy, toMcapSnapshot(item), openMints, closedMints) ===
    null
  )
}

function collapseMints(pool: readonly ScoredSignal[]): ScoredSignal[] {
  const seen = new Set<string>()
  const out: ScoredSignal[] = []
  for (const row of pool) {
    if (seen.has(row.token_address)) continue
    seen.add(row.token_address)
    out.push(row)
  }
  return out
}

export type SignalsListRow = ScoredSignal & { alsoMatches: SignalsListAlsoMatch[] }

/**
 * One row per mint that matches the selected strategy.
 * alsoMatches is every other universe match, in picker rank order.
 * Open and closed sets passed to the mcap skip helper are empty so
 * already_open / already_closed never hide a live mint.
 */
export function projectSignalsStrategyList(input: {
  chain: StrategyChain
  selectedId: string
  pool: readonly ScoredSignal[]
  limit: number
  scoreConfig: SignalsStrategyConfig
  mcapById: Record<string, McapTrackerStrategy>
  nameOverrides?: Record<string, string>
  breakdown: readonly SignalsListPnlRow[]
}): { strategies: SignalsListPickerOption[]; signals: SignalsListRow[] } {
  const strategies = rankSignalsListStrategies(
    input.chain,
    input.breakdown,
    input.nameOverrides,
  )
  const selected = signalsListEntry(input.chain, input.selectedId)
  if (!selected) return { strategies, signals: [] }

  const universe = UNIVERSE[input.chain]
  const openMints = new Set<string>()
  const closedMints = new Set<string>()
  const displayTemplate = selected.template ?? 'default'
  const rows: SignalsListRow[] = []

  for (const item of collapseMints(input.pool)) {
    const matching = new Set<string>()
    for (const entry of universe) {
      if (
        strategyMatches(
          entry,
          item,
          input.scoreConfig,
          input.mcapById,
          openMints,
          closedMints,
        )
      ) {
        matching.add(entry.strategyId)
      }
    }
    if (!matching.has(input.selectedId)) continue

    const display = computeScoreAndDecision(item, {
      ...input.scoreConfig,
      template: displayTemplate,
    })
    const alsoMatches = strategies
      .filter(
        (option) => option.strategyId !== input.selectedId && matching.has(option.strategyId),
      )
      .map((option) => ({ strategyId: option.strategyId, name: option.name }))

    rows.push({
      ...item,
      ...display,
      alsoMatches,
    })
  }

  if (selected.domain === 'signals') {
    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (b.mcap_growth_percent || 0) - (a.mcap_growth_percent || 0)
    })
  } else {
    rows.sort((a, b) => {
      const growth = (b.mcap_growth_percent || 0) - (a.mcap_growth_percent || 0)
      if (growth !== 0) return growth
      return a.token_address.localeCompare(b.token_address)
    })
  }

  const limit = Number.isFinite(input.limit) ? Math.max(0, input.limit) : rows.length
  return { strategies, signals: rows.slice(0, limit) }
}
