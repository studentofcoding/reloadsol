/**
 * First-cut sim-open risk from market-brain.
 *
 * Resolution order (SPEC):
 * 1. Live GET /regime/params?profile=<recipe.profileId|default> wins
 * 2. Else embedded recipe.riskGrid[climate state]
 * 3. Else keep local TP / SL / size (log once)
 *
 * sizeScale multiplies size; 0 = stand-down (skip new opens).
 * Independent of MARKET_BRAIN_* universe flags: an active recipe is enough.
 * Live execute is unchanged — callers must pass isSimulated / skip live paths.
 */

import { fetchClimate } from '@/utils/climateGate'
import {
  BRAIN_CLIMATE_STATES,
  fetchBrainRecipes,
  fetchBrainRegimeParams,
  isMarketBrainConfigured,
  type BrainClimateState,
  type LegoDomain,
  type LegoRecipe,
  type MarketBrainFetchOpts,
  type RegimeParamsResolved,
  type RegimeRiskCell,
} from '@/utils/market-brain'

export const DEFAULT_BRAIN_RISK_PROFILE_ID = 'default'

export type BrainRiskSource = 'live' | 'riskGrid' | 'local'

export type ExitKnobs = {
  stopLossPct: number
  takeProfitPct: number
  maxHoldHours: number
}

export type ResolvedBrainRisk = {
  applied: boolean
  source: BrainRiskSource
  standDown: boolean
  profileId: string
  state: BrainClimateState | null
  sizeScale: number | null
  takeProfitPct: number | null
  stopLossPct: number | null
  holdHours: number | null
  recipeId?: string
  reason?: string
}

export type ResolveBrainRiskParams = MarketBrainFetchOpts & {
  strategyId: string
  domain?: LegoDomain
  recipe?: LegoRecipe | null
  recipes?: Iterable<LegoRecipe>
  climateState?: string | null
  getClimateState?: () => Promise<string | null | undefined>
}

const BRAIN_UNAVAILABLE_LOG =
  '[market-brain] regime risk unavailable; keeping local TP/SL/size'

let brainRiskUnavailableLogged = false

/** Test-only: allow the fail-soft log-once latch to fire again. */
export function resetBrainRiskWarnForTests(): void {
  brainRiskUnavailableLogged = false
}

export function warnBrainRiskUnavailableOnce(reason: string): void {
  if (brainRiskUnavailableLogged) return
  brainRiskUnavailableLogged = true
  console.warn(`${BRAIN_UNAVAILABLE_LOG} (${reason})`)
}

export function asBrainClimateState(
  value: unknown,
): BrainClimateState | null {
  return typeof value === 'string' &&
    (BRAIN_CLIMATE_STATES as readonly string[]).includes(value)
    ? (value as BrainClimateState)
    : null
}

export function localBrainRisk(reason?: string): ResolvedBrainRisk {
  return {
    applied: false,
    source: 'local',
    standDown: false,
    profileId: DEFAULT_BRAIN_RISK_PROFILE_ID,
    state: null,
    sizeScale: null,
    takeProfitPct: null,
    stopLossPct: null,
    holdHours: null,
    reason,
  }
}

export function isActiveLegoRecipe(recipe: LegoRecipe | null | undefined): boolean {
  return Boolean(recipe && recipe.active === true && recipe.dormant !== true)
}

export function pickActiveLegoRecipe(
  recipes: Iterable<LegoRecipe>,
  opts: { recipeId?: string; domain?: LegoDomain } = {},
): LegoRecipe | null {
  const list = Array.isArray(recipes) ? recipes : [...recipes]
  if (opts.recipeId) {
    const exact = list.find((recipe) => recipe.id === opts.recipeId)
    // Exact id only — do not fall through to another domain recipe's grid.
    return isActiveLegoRecipe(exact) ? exact! : null
  }
  if (opts.domain) {
    return (
      list.find((recipe) => recipe.domain === opts.domain && isActiveLegoRecipe(recipe)) ??
      null
    )
  }
  return null
}

export function riskCellFromGrid(
  recipe: LegoRecipe | null | undefined,
  state: BrainClimateState | null,
): RegimeRiskCell | null {
  if (!recipe?.riskGrid || !state) return null
  const cell = recipe.riskGrid[state]
  return cell ?? null
}

export function resolvedRiskFromCell(
  cell: RegimeRiskCell,
  source: Exclude<BrainRiskSource, 'local'>,
  extras: {
    profileId: string
    state: BrainClimateState | null
    recipeId?: string
    reason?: string
  },
): ResolvedBrainRisk {
  const sizeScale = Number.isFinite(cell.sizeScale) ? cell.sizeScale : 0
  return {
    applied: true,
    source,
    standDown: sizeScale <= 0,
    profileId: extras.profileId,
    state: extras.state,
    sizeScale,
    takeProfitPct: cell.takeProfitPct,
    stopLossPct: cell.stopLossPct,
    holdHours: cell.holdHours,
    recipeId: extras.recipeId,
    reason: extras.reason,
  }
}

export function resolvedRiskFromLive(
  live: RegimeParamsResolved,
  recipe?: LegoRecipe | null,
): ResolvedBrainRisk {
  return resolvedRiskFromCell(
    {
      sizeScale: live.sizeScale,
      takeProfitPct: live.takeProfitPct,
      stopLossPct: live.stopLossPct,
      holdHours: live.holdHours,
    },
    'live',
    {
      profileId: live.profileId || recipe?.profileId || DEFAULT_BRAIN_RISK_PROFILE_ID,
      state: live.state,
      recipeId: recipe?.id,
      reason: live.reason,
    },
  )
}

/**
 * Multiply local size by sizeScale. Unapplied risk leaves size unchanged.
 * sizeScale <= 0 → 0 (caller should skip the open).
 */
export function scaleOpenSize(localSize: number, risk: ResolvedBrainRisk): number {
  const base = Number.isFinite(localSize) ? localSize : 0
  if (!risk.applied || risk.sizeScale == null) return base
  if (risk.sizeScale <= 0) return 0
  return Math.round(base * risk.sizeScale * 1e9) / 1e9
}

/**
 * Overlay brain TP / SL / hold onto local exit knobs.
 * Brain SL is a positive magnitude; local signed drawdowns (e.g. -50) stay signed.
 * Null brain fields leave the local value.
 */
export function applyBrainRiskToExit<T extends ExitKnobs>(
  baseExit: T,
  risk: ResolvedBrainRisk,
): T {
  if (!risk.applied) return baseExit
  const takeProfitPct =
    risk.takeProfitPct != null ? risk.takeProfitPct : baseExit.takeProfitPct
  const stopLossPct =
    risk.stopLossPct != null
      ? signedStopLoss(risk.stopLossPct, baseExit.stopLossPct)
      : baseExit.stopLossPct
  const maxHoldHours =
    risk.holdHours != null ? risk.holdHours : baseExit.maxHoldHours
  return {
    ...baseExit,
    takeProfitPct,
    stopLossPct,
    maxHoldHours,
  }
}

function signedStopLoss(brainSl: number, localSl: number): number {
  if (localSl < 0 && brainSl > 0) return -brainSl
  return brainSl
}

export function stampBrainRisk(
  features: Record<string, unknown>,
  risk: ResolvedBrainRisk,
  extra?: { sizedSol?: number },
): Record<string, unknown> {
  return {
    ...features,
    brain_risk_source: risk.source,
    brain_risk_applied: risk.applied,
    brain_risk_stand_down: risk.standDown,
    brain_risk_profile_id: risk.profileId,
    ...(risk.state ? { brain_risk_state: risk.state } : {}),
    ...(risk.sizeScale != null ? { brain_size_scale: risk.sizeScale } : {}),
    ...(risk.takeProfitPct != null ? { brain_take_profit_pct: risk.takeProfitPct } : {}),
    ...(risk.stopLossPct != null ? { brain_stop_loss_pct: risk.stopLossPct } : {}),
    ...(risk.holdHours != null ? { brain_hold_hours: risk.holdHours } : {}),
    ...(risk.recipeId ? { brain_recipe_id: risk.recipeId } : {}),
    ...(extra?.sizedSol != null ? { brain_sized_sol: extra.sizedSol } : {}),
  }
}

export function frozenExitForSimOpen(
  overlayExit: ExitKnobs | null | undefined,
  brainAdjusted: ExitKnobs,
  risk: ResolvedBrainRisk,
): ExitKnobs | null {
  if (overlayExit) return overlayExit
  if (!risk.applied) return null
  return {
    stopLossPct: brainAdjusted.stopLossPct,
    takeProfitPct: brainAdjusted.takeProfitPct,
    maxHoldHours: brainAdjusted.maxHoldHours,
  }
}

async function defaultClimateState(): Promise<string | null> {
  try {
    const gate = await fetchClimate()
    return gate.state ?? null
  } catch {
    return null
  }
}

export async function resolveBrainRegimeRisk(
  params: ResolveBrainRiskParams,
): Promise<ResolvedBrainRisk> {
  if (!isMarketBrainConfigured({ baseUrl: params.baseUrl, token: params.token })) {
    warnBrainRiskUnavailableOnce('MARKET_BRAIN_TOKEN is not set')
    return localBrainRisk('MARKET_BRAIN_TOKEN is not set')
  }

  const fetchOpts: MarketBrainFetchOpts = {
    baseUrl: params.baseUrl,
    token: params.token,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  }

  let recipe = isActiveLegoRecipe(params.recipe) ? params.recipe! : null
  if (!recipe && params.recipes !== undefined) {
    recipe = pickActiveLegoRecipe(params.recipes, {
      recipeId: params.strategyId,
      domain: params.domain,
    })
  } else if (!recipe) {
    const fetched = await fetchBrainRecipes(fetchOpts)
    if (fetched.ok) {
      recipe = pickActiveLegoRecipe(fetched.data, {
        recipeId: params.strategyId,
        domain: params.domain,
      })
    }
  }

  const profileId = recipe?.profileId?.trim() || DEFAULT_BRAIN_RISK_PROFILE_ID
  const live = await fetchBrainRegimeParams(profileId, fetchOpts)
  if (live.ok) {
    return resolvedRiskFromLive(live.data, recipe)
  }

  const state =
    asBrainClimateState(params.climateState) ??
    asBrainClimateState(
      await (params.getClimateState ?? defaultClimateState)(),
    )
  const cell = riskCellFromGrid(recipe, state)
  if (cell) {
    return resolvedRiskFromCell(cell, 'riskGrid', {
      profileId,
      state,
      recipeId: recipe?.id,
      reason: live.error,
    })
  }

  warnBrainRiskUnavailableOnce(live.error)
  return localBrainRisk(live.error)
}

export type BrainRiskSession = {
  resolve(
    params: Omit<ResolveBrainRiskParams, keyof MarketBrainFetchOpts> & {
      strategyId: string
    },
  ): Promise<ResolvedBrainRisk>
}

/**
 * Cache recipes + /regime/params per profile for one sim-track / assign cycle.
 */
export function createBrainRiskSession(
  opts: MarketBrainFetchOpts & {
    climateState?: string | null
    getClimateState?: () => Promise<string | null | undefined>
  } = {},
): BrainRiskSession {
  const fetchOpts: MarketBrainFetchOpts = {
    baseUrl: opts.baseUrl,
    token: opts.token,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  }
  let recipesPromise: Promise<LegoRecipe[] | null> | null = null
  const paramsByProfile = new Map<
    string,
    Promise<{ live: RegimeParamsResolved | null; error?: string }>
  >()
  const byStrategy = new Map<string, Promise<ResolvedBrainRisk>>()

  const loadRecipes = (): Promise<LegoRecipe[] | null> => {
    if (!recipesPromise) {
      recipesPromise = fetchBrainRecipes(fetchOpts).then((row) =>
        row.ok ? row.data : null,
      )
    }
    return recipesPromise
  }

  const loadLive = (
    profileId: string,
  ): Promise<{ live: RegimeParamsResolved | null; error?: string }> => {
    const existing = paramsByProfile.get(profileId)
    if (existing) return existing
    const pending = fetchBrainRegimeParams(profileId, fetchOpts).then((row) =>
      row.ok ? { live: row.data } : { live: null, error: row.error },
    )
    paramsByProfile.set(profileId, pending)
    return pending
  }

  return {
    resolve(params) {
      const key = `${params.strategyId}:${params.domain ?? ''}`
      const cached = byStrategy.get(key)
      if (cached) return cached
      const pending = resolveWithSession(params)
      byStrategy.set(key, pending)
      return pending
    },
  }

  async function resolveWithSession(
    params: Omit<ResolveBrainRiskParams, keyof MarketBrainFetchOpts> & {
      strategyId: string
    },
  ): Promise<ResolvedBrainRisk> {
    if (!isMarketBrainConfigured({ baseUrl: opts.baseUrl, token: opts.token })) {
      warnBrainRiskUnavailableOnce('MARKET_BRAIN_TOKEN is not set')
      return localBrainRisk('MARKET_BRAIN_TOKEN is not set')
    }

    let recipe = isActiveLegoRecipe(params.recipe) ? params.recipe! : null
    if (!recipe) {
      const recipes = params.recipes ?? (await loadRecipes())
      if (recipes) {
        recipe = pickActiveLegoRecipe(recipes, {
          recipeId: params.strategyId,
          domain: params.domain,
        })
      }
    }

    const profileId = recipe?.profileId?.trim() || DEFAULT_BRAIN_RISK_PROFILE_ID
    const liveRow = await loadLive(profileId)
    if (liveRow.live) return resolvedRiskFromLive(liveRow.live, recipe)
    const liveError = liveRow.error

    const state =
      asBrainClimateState(params.climateState ?? opts.climateState) ??
      asBrainClimateState(
        await (params.getClimateState ?? opts.getClimateState ?? defaultClimateState)(),
      )
    const cell = riskCellFromGrid(recipe, state)
    if (cell) {
      return resolvedRiskFromCell(cell, 'riskGrid', {
        profileId,
        state,
        recipeId: recipe?.id,
        reason: liveError,
      })
    }

    warnBrainRiskUnavailableOnce(liveError ?? 'regime params unavailable')
    return localBrainRisk(liveError ?? 'regime params unavailable')
  }
}
