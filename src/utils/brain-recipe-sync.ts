/**
 * Promote / deactivate / dormant ↔ market-brain lego recipes.
 *
 * Mapping (SPEC):
 * - promote (existing active-sim / human promote rails) → PUT fat recipe + POST activate
 * - deactivate from active assign → POST deactivate (not hard-delete)
 * - dormant / zero-trade → POST dormant (keep params)
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

/** Promote gate from SPEC (avg PnL > 0 and n ≥ 10). Existing rails may be stricter. */
export function passesLegoPromoteGate(params: {
  avgPnl: number
  n: number
}): boolean {
  return params.n >= 10 && params.avgPnl > 0
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

/**
 * Park first-cut recipes that have zero closes (keep params).
 * Used by the strategy-search tidy pass; fail-soft.
 */
export async function dormantZeroTradeLegoRecipes(params: {
  domain: string
  closesByStrategy: ReadonlyMap<string, number>
  skipIds?: readonly string[]
  opts?: MarketBrainFetchOpts
}): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const ids = FIRST_CUT_IDS_BY_DOMAIN[params.domain] ?? []
  const skip = new Set(params.skipIds ?? [])
  const out: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const id of ids) {
    if (skip.has(id)) continue
    const n = params.closesByStrategy.get(id) ?? 0
    if (n !== 0) continue
    const result = await dormantLegoRecipe(id, { ...params.opts, domain: params.domain })
    out.push(
      result.ok
        ? { id, ok: true }
        : { id, ok: false, error: result.error },
    )
  }
  return out
}
