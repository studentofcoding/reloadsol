/**
 * Promote / deactivate / dormant ↔ market-brain lego recipes.
 *
 * Mapping (SPEC):
 * - promote (existing active-sim / human promote rails) → PUT fat recipe + POST activate
 * - deactivate from active assign → POST deactivate (not hard-delete)
 * - dormant / zero-trade → POST dormant (keep params)
 *
 * Tidy rules (inverse of the lego promote gate; never DELETE):
 * - Keep / promote toward active: n ≥ 10 and avg PnL > 0
 * - Deactivate thin (0 < n < 10) or losing (n ≥ 10 and avg PnL ≤ 0) **active** recipes
 * - Zero-trade (n = 0): POST dormant — params stay in the store
 * - Already dormant: leave dormant (do not drop / delete)
 *
 * Fail-soft: missing MARKET_BRAIN_ADMIN_TOKEN logs once and does not throw.
 * Live execute is unchanged.
 */

import {
  DEFAULT_LIQUIDITY_MIN_USD,
  DEFAULT_MCAP_MIN_USD,
} from '@/utils/brain-gates'
import {
  activateBrainRecipe,
  deactivateBrainRecipe,
  dormantBrainRecipe,
  fetchBrainRecipes,
  isMarketBrainAdminConfigured,
  putBrainRecipe,
  warnMissingBrainAdminTokenOnce,
  type BrainClimateState,
  type BrainGateWrite,
  type BrainListName,
  type BrainResult,
  type LegoDomain,
  type LegoRecipe,
  type LegoRecipeWrite,
  type MarketBrainFetchOpts,
  type RegimeRiskCell,
} from '@/utils/market-brain'

export const DEFAULT_LEGO_PROFILE_ID = 'default'
export const DEFAULT_LEGO_UNIVERSE: BrainListName[] = ['union']

/** SPEC seed `default` risk grid (embedded on every fat recipe). */
export const DEFAULT_LEGO_RISK_GRID: Record<
  BrainClimateState,
  RegimeRiskCell | null
> = {
  Cash: { sizeScale: 0, takeProfitPct: null, stopLossPct: null, holdHours: null },
  'De-risk': { sizeScale: 0.25, takeProfitPct: 8, stopLossPct: 6, holdHours: 4 },
  Mixed: { sizeScale: 0.5, takeProfitPct: 12, stopLossPct: 8, holdHours: 8 },
  Range: { sizeScale: 0.75, takeProfitPct: 15, stopLossPct: 10, holdHours: 12 },
  Hype: { sizeScale: 1, takeProfitPct: 20, stopLossPct: 12, holdHours: 24 },
}

/** Default AND pack in brain-native `{ kind, n? }` form. No bmScore. */
export const DEFAULT_LEGO_GATES: BrainGateWrite[] = [
  { kind: 'membership' },
  { kind: 'mcap', n: DEFAULT_MCAP_MIN_USD },
  { kind: 'liquidity', n: DEFAULT_LIQUIDITY_MIN_USD },
  { kind: 'climateSafe' },
]

export const KNOWN_WINNER_STRATEGY_IDS = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
  'signals_sell_over_100',
] as const

export type KnownWinnerStrategyId = (typeof KNOWN_WINNER_STRATEGY_IDS)[number]

const TRENDING_STRATEGY_IDS = new Set([
  'att',
  'lowcap_moonbag',
  'scalper',
  'hodl',
  'att_rh',
  'lowcap_moonbag_rh',
  'scalper_rh',
  'hodl_rh',
])

export type LegoRecipeEvent = 'promote' | 'deactivate' | 'dormant' | 'zero-trade'

export type LegoRecipeWriteAction = 'upsert-activate' | 'deactivate' | 'dormant'

/** SPEC lego promote gate: avg PnL > 0 and n ≥ 10. Existing fitness rails may be stricter. */
export const LEGO_PROMOTE_MIN_N = 10

/** Promote gate from SPEC (avg PnL > 0 and n ≥ 10). Existing rails may be stricter. */
export function passesLegoPromoteGate(params: {
  avgPnl: number
  n: number
}): boolean {
  return params.n >= LEGO_PROMOTE_MIN_N && params.avgPnl > 0
}

export type LegoRecipeTidyStats = {
  n: number
  avgPnl: number
}

export type LegoRecipeTidySnapshot = {
  id: string
  active?: boolean
  dormant?: boolean
  domain?: string
}

export type LegoTidyActionKind = 'keep' | 'deactivate' | 'dormant' | 'leave-dormant'

export type LegoTidyReason =
  | 'passes-promote-gate'
  | 'thin-sample'
  | 'losing'
  | 'zero-trade'
  | 'already-dormant'
  | 'already-inactive'

export type LegoTidyDecision = {
  action: LegoTidyActionKind
  reason: LegoTidyReason
}

export type LegoTidyPlanRow = LegoTidyDecision & { id: string }

/**
 * Decide the tidy action for one recipe. Inverse of `passesLegoPromoteGate`
 * for recipes that are (or may be) in the active assign set.
 *
 * Never returns a delete: dormant rows keep params; inactive losers stay stored.
 */
export function legoTidyDecision(params: {
  n: number
  avgPnl: number
  active?: boolean
  dormant?: boolean
}): LegoTidyDecision {
  if (params.dormant === true) {
    return { action: 'leave-dormant', reason: 'already-dormant' }
  }
  if (params.n <= 0) {
    return { action: 'dormant', reason: 'zero-trade' }
  }
  if (passesLegoPromoteGate({ avgPnl: params.avgPnl, n: params.n })) {
    return { action: 'keep', reason: 'passes-promote-gate' }
  }
  const reason: LegoTidyReason =
    params.n < LEGO_PROMOTE_MIN_N ? 'thin-sample' : 'losing'
  // Unknown snapshot (active omitted) is treated as possibly-active first-cut.
  if (params.active === false) {
    return { action: 'keep', reason: 'already-inactive' }
  }
  return { action: 'deactivate', reason }
}

export function legoRecipeActionForEvent(
  event: LegoRecipeEvent,
): LegoRecipeWriteAction {
  if (event === 'promote') return 'upsert-activate'
  if (event === 'deactivate') return 'deactivate'
  return 'dormant'
}

export function legoDomainForStrategy(
  strategyId: string,
  domain?: string | null,
): LegoDomain | null {
  if (domain === 'mcap_tracker' || strategyId.startsWith('mcap_')) return 'mcap'
  if (domain === 'signals' || strategyId.startsWith('signals_')) return 'signals'
  if (domain === 'trending_bot' || TRENDING_STRATEGY_IDS.has(strategyId)) {
    return 'trending'
  }
  return null
}

export function legoDomainForSearchDomain(domain: string): LegoDomain | null {
  if (domain === 'mcap_tracker') return 'mcap'
  if (domain === 'signals') return 'signals'
  if (domain === 'trending_bot') return 'trending'
  return null
}

function normalizeLegoDomain(domain: string | undefined): LegoDomain | null {
  if (domain === 'mcap' || domain === 'mcap_tracker') return 'mcap'
  if (domain === 'signals') return 'signals'
  if (domain === 'trending' || domain === 'trending_bot') return 'trending'
  return null
}

/** Extra brain recipes belong to a tidy domain by id prefix or recipe.domain — not the cycle domain override. */
function recipeMatchesTidyDomain(
  recipe: LegoRecipeTidySnapshot,
  domain: string,
): boolean {
  const cycle = legoDomainForSearchDomain(domain)
  if (!cycle) return false
  const fromId = legoDomainForStrategy(recipe.id)
  if (fromId) return fromId === cycle
  const fromSnap = normalizeLegoDomain(recipe.domain)
  return fromSnap === cycle
}

export function fatLegoRecipeForStrategy(params: {
  strategyId: string
  domain?: string | null
  active?: boolean
  dormant?: boolean
}): LegoRecipeWrite | null {
  const legoDomain = legoDomainForStrategy(params.strategyId, params.domain)
  if (!legoDomain) return null
  const dormant = params.dormant === true
  const active = dormant ? false : params.active !== false
  const recipe: LegoRecipeWrite = {
    id: params.strategyId,
    active,
    domain: legoDomain,
    universe: [...DEFAULT_LEGO_UNIVERSE],
    gates: DEFAULT_LEGO_GATES.map((g) => ({ ...g })),
    profileId: DEFAULT_LEGO_PROFILE_ID,
    riskGrid: { ...DEFAULT_LEGO_RISK_GRID },
  }
  if (dormant) recipe.dormant = true
  else if (params.dormant === false || params.active === true) recipe.dormant = false
  return recipe
}

export function knownWinnerRecipes(): LegoRecipeWrite[] {
  return KNOWN_WINNER_STRATEGY_IDS.map((id) => {
    const recipe = fatLegoRecipeForStrategy({
      strategyId: id,
      active: true,
      dormant: false,
    })
    if (!recipe) throw new Error(`known winner ${id} is not a first-cut lego strategy`)
    return recipe
  })
}

function skipIfNoAdmin(
  context: string,
  opts: MarketBrainFetchOpts,
): BrainResult<LegoRecipe> | null {
  if (isMarketBrainAdminConfigured({ adminToken: opts.adminToken, baseUrl: opts.baseUrl })) {
    return null
  }
  warnMissingBrainAdminTokenOnce(context)
  return { ok: false, error: 'MARKET_BRAIN_ADMIN_TOKEN is not set' }
}

function skippedDomain(strategyId: string): BrainResult<LegoRecipe> {
  return {
    ok: false,
    error: `not a first-cut lego strategy: ${strategyId}`,
  }
}

/**
 * Promote → upsert fat payload (active, not dormant) then POST /activate.
 * Fail-soft: missing admin token logs once; fetch errors do not throw.
 */
export async function promoteLegoRecipe(
  strategyId: string,
  opts: MarketBrainFetchOpts & { domain?: string | null } = {},
): Promise<BrainResult<LegoRecipe>> {
  const recipe = fatLegoRecipeForStrategy({
    strategyId,
    domain: opts.domain,
    active: true,
    dormant: false,
  })
  if (!recipe) return skippedDomain(strategyId)
  const skipped = skipIfNoAdmin(`promote ${strategyId}`, opts)
  if (skipped) return skipped
  try {
    const upserted = await putBrainRecipe(recipe, opts)
    if (!upserted.ok) return upserted
    const activated = await activateBrainRecipe(strategyId, opts)
    if (!activated.ok) return activated
    return activated
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: msg }
  }
}

export async function deactivateLegoRecipe(
  strategyId: string,
  opts: MarketBrainFetchOpts & { domain?: string | null } = {},
): Promise<BrainResult<LegoRecipe>> {
  if (!legoDomainForStrategy(strategyId, opts.domain)) return skippedDomain(strategyId)
  const skipped = skipIfNoAdmin(`deactivate ${strategyId}`, opts)
  if (skipped) return skipped
  try {
    return await deactivateBrainRecipe(strategyId, opts)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: msg }
  }
}

export async function dormantLegoRecipe(
  strategyId: string,
  opts: MarketBrainFetchOpts & { domain?: string | null } = {},
): Promise<BrainResult<LegoRecipe>> {
  if (!legoDomainForStrategy(strategyId, opts.domain)) return skippedDomain(strategyId)
  const skipped = skipIfNoAdmin(`dormant ${strategyId}`, opts)
  if (skipped) return skipped
  try {
    return await dormantBrainRecipe(strategyId, opts)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: msg }
  }
}

export async function syncLegoRecipe(
  strategyId: string,
  event: LegoRecipeEvent,
  opts: MarketBrainFetchOpts & { domain?: string | null } = {},
): Promise<BrainResult<LegoRecipe>> {
  const action = legoRecipeActionForEvent(event)
  if (action === 'upsert-activate') return promoteLegoRecipe(strategyId, opts)
  if (action === 'deactivate') return deactivateLegoRecipe(strategyId, opts)
  return dormantLegoRecipe(strategyId, opts)
}

export type SeedBrainRecipesResult = {
  ok: boolean
  seeded: Array<{ id: string; ok: boolean; error?: string; status?: number }>
}

/** Idempotent PUT of the three known-winner recipes as active. */
export async function seedKnownWinnerRecipes(
  opts: MarketBrainFetchOpts = {},
): Promise<SeedBrainRecipesResult> {
  if (!isMarketBrainAdminConfigured({ adminToken: opts.adminToken, baseUrl: opts.baseUrl })) {
    warnMissingBrainAdminTokenOnce('seed known winners')
    return {
      ok: false,
      seeded: KNOWN_WINNER_STRATEGY_IDS.map((id) => ({
        id,
        ok: false,
        error: 'MARKET_BRAIN_ADMIN_TOKEN is not set',
      })),
    }
  }
  const seeded: SeedBrainRecipesResult['seeded'] = []
  for (const recipe of knownWinnerRecipes()) {
    const result = await putBrainRecipe(recipe, opts)
    seeded.push(
      result.ok
        ? { id: recipe.id, ok: true, status: result.status }
        : { id: recipe.id, ok: false, error: result.error, status: result.status },
    )
  }
  return { ok: seeded.every((row) => row.ok), seeded }
}

const FIRST_CUT_IDS_BY_DOMAIN: Record<string, readonly string[]> = {
  mcap_tracker: ['mcap_enter_first_seen', 'mcap_enter_at_80'],
  signals: ['signals_sell_over_100'],
}

export function firstCutLegoStrategyIds(domain: string): readonly string[] {
  return FIRST_CUT_IDS_BY_DOMAIN[domain] ?? []
}

/**
 * Pure tidy plan: first-cut ids plus any in-domain recipe snapshots.
 * skipIds (e.g. just-promoted canonical) are omitted. Never plans a delete.
 */
export function planLegoRecipeTidy(params: {
  domain: string
  statsByStrategy: ReadonlyMap<string, LegoRecipeTidyStats>
  recipes?: readonly LegoRecipeTidySnapshot[]
  skipIds?: readonly string[]
}): LegoTidyPlanRow[] {
  const skip = new Set(params.skipIds ?? [])
  const snapshots = new Map<string, LegoRecipeTidySnapshot>()
  for (const id of firstCutLegoStrategyIds(params.domain)) {
    snapshots.set(id, { id })
  }
  for (const recipe of params.recipes ?? []) {
    if (!recipeMatchesTidyDomain(recipe, params.domain)) continue
    snapshots.set(recipe.id, recipe)
  }
  const planned: LegoTidyPlanRow[] = []
  for (const [id, snap] of snapshots) {
    if (skip.has(id)) continue
    const stats = params.statsByStrategy.get(id) ?? { n: 0, avgPnl: 0 }
    const decision = legoTidyDecision({
      n: stats.n,
      avgPnl: stats.avgPnl,
      active: snap.active,
      dormant: snap.dormant,
    })
    planned.push({ id, ...decision })
  }
  return planned
}

export type TidyLegoWriteRow = {
  id: string
  reason: LegoTidyReason
  ok: boolean
  error?: string
}

export type TidyLegoRecipesResult = {
  deactivated: TidyLegoWriteRow[]
  dormant: TidyLegoWriteRow[]
  preserved: Array<{ id: string; action: 'keep' | 'leave-dormant'; reason: LegoTidyReason }>
}

async function resolveTidySnapshots(
  domain: string,
  recipes: readonly LegoRecipeTidySnapshot[] | undefined,
  opts: MarketBrainFetchOpts | undefined,
): Promise<readonly LegoRecipeTidySnapshot[]> {
  if (recipes) return recipes
  try {
    const listed = await fetchBrainRecipes(opts)
    if (!listed.ok) return []
    return listed.data.filter((recipe) => recipeMatchesTidyDomain(recipe, domain))
  } catch {
    return []
  }
}

function writeRow(
  id: string,
  reason: LegoTidyReason,
  result: BrainResult<LegoRecipe>,
): TidyLegoWriteRow {
  return result.ok
    ? { id, reason, ok: true }
    : { id, reason, ok: false, error: result.error }
}

/**
 * Tidy pass: deactivate thin/losing **active** recipes; park zero-trade as
 * dormant (keep params). Already-dormant rows are left in the store.
 * Fail-soft; never hard-deletes. `dryRun` returns the plan without writes.
 */
export async function tidyLegoRecipes(params: {
  domain: string
  statsByStrategy: ReadonlyMap<string, LegoRecipeTidyStats>
  recipes?: readonly LegoRecipeTidySnapshot[]
  skipIds?: readonly string[]
  opts?: MarketBrainFetchOpts
  dryRun?: boolean
}): Promise<TidyLegoRecipesResult> {
  const recipes = await resolveTidySnapshots(params.domain, params.recipes, params.opts)
  const plan = planLegoRecipeTidy({
    domain: params.domain,
    statsByStrategy: params.statsByStrategy,
    recipes,
    skipIds: params.skipIds,
  })
  const deactivated: TidyLegoWriteRow[] = []
  const dormant: TidyLegoWriteRow[] = []
  const preserved: TidyLegoRecipesResult['preserved'] = []
  const opts = { ...params.opts, domain: params.domain }

  for (const row of plan) {
    if (row.action === 'keep' || row.action === 'leave-dormant') {
      preserved.push({ id: row.id, action: row.action, reason: row.reason })
      continue
    }
    if (params.dryRun) {
      const queued = { id: row.id, reason: row.reason, ok: true }
      if (row.action === 'deactivate') deactivated.push(queued)
      else dormant.push(queued)
      continue
    }
    if (row.action === 'deactivate') {
      const result = await deactivateLegoRecipe(row.id, opts)
      deactivated.push(writeRow(row.id, row.reason, result))
      continue
    }
    const result = await dormantLegoRecipe(row.id, opts)
    dormant.push(writeRow(row.id, row.reason, result))
  }

  return { deactivated, dormant, preserved }
}

/**
 * Park first-cut recipes that have zero closes (keep params).
 * Used by the strategy-search tidy pass; fail-soft. Does not delete.
 * Thin/losing active recipes are handled by `tidyLegoRecipes`, not this helper.
 */
export async function dormantZeroTradeLegoRecipes(params: {
  domain: string
  closesByStrategy: ReadonlyMap<string, number>
  skipIds?: readonly string[]
  opts?: MarketBrainFetchOpts
}): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const statsByStrategy = new Map<string, LegoRecipeTidyStats>(
    [...params.closesByStrategy].map(([id, n]) => [id, { n, avgPnl: 0 }]),
  )
  const plan = planLegoRecipeTidy({
    domain: params.domain,
    statsByStrategy,
    recipes: firstCutLegoStrategyIds(params.domain).map((id) => ({ id })),
    skipIds: params.skipIds,
  })
  const out: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const row of plan) {
    if (row.action !== 'dormant') continue
    const result = await dormantLegoRecipe(row.id, { ...params.opts, domain: params.domain })
    out.push(
      result.ok ? { id: row.id, ok: true } : { id: row.id, ok: false, error: result.error },
    )
  }
  return out
}
