/**
 * buy_bulk client for live market-brain (lists + recipes + regime params).
 *
 * CONNECT (read):
 * - Base: https://market-brain.yonathanevanchristy.workers.dev
 * - Health: GET /health (public)
 * - Lists (Bearer MARKET_BRAIN_TOKEN = BRAIN_READ_TOKEN): GET /bubble /jupiter /union
 * - Regime: GET /regime/params?profile=default (Bearer read)
 * - Recipes read: GET /recipes, GET /recipes/:id (Bearer read)
 * - Recipes write: PUT /recipes/:id, POST /recipes,
 *   POST /recipes/:id/{activate,deactivate,dormant}
 *   (Bearer MARKET_BRAIN_ADMIN_TOKEN = BRAIN_ADMIN_TOKEN)
 *
 * Env:
 * - MARKET_BRAIN_URL — optional base override (no trailing slash required)
 * - MARKET_BRAIN_TOKEN — Bearer read token (never logged)
 * - MARKET_BRAIN_ADMIN_TOKEN — Bearer admin token for recipe writes (never logged)
 * - MARKET_BRAIN_TRENDING=1 — opt-in trending/assign universe from GET /union
 *
 * Fail soft: fetchers return `{ ok: false, error }` instead of throwing.
 * Missing admin token: log once; do not throw (promote stays local).
 * Do not log secrets. Do not change live execute from this module.
 */

export const DEFAULT_MARKET_BRAIN_URL =
  'https://market-brain.yonathanevanchristy.workers.dev'

export const BRAIN_LIST_NAMES = ['bubble', 'jupiter', 'union'] as const
export type BrainListName = (typeof BRAIN_LIST_NAMES)[number]

export const LEGO_DOMAINS = ['mcap', 'trending', 'signals'] as const
export type LegoDomain = (typeof LEGO_DOMAINS)[number]

export const BRAIN_CLIMATE_STATES = ['Hype', 'Range', 'Mixed', 'De-risk', 'Cash'] as const
export type BrainClimateState = (typeof BRAIN_CLIMATE_STATES)[number]

export type BrainResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; status?: number; path?: string }

export type BrainListToken = {
  mint: string
  symbol: string | null
  name: string | null
  marketCap: number | null
  liquidity: number | null
  score100: number | null
  freshWalletsPct: number | null
  top10AdjustedPct: number | null
  raw: Record<string, unknown>
}

export type BrainListPayload = {
  list: BrainListName
  generatedAt: string | null
  tokens: BrainListToken[]
  mints: string[]
}

export type RegimeParamsResolved = {
  profileId: string
  state: BrainClimateState | null
  sizeScale: number
  takeProfitPct: number | null
  stopLossPct: number | null
  holdHours: number | null
  climateFetchedAt: string | null
  reason?: string
  raw: Record<string, unknown>
}

export type RegimeRiskCell = {
  sizeScale: number
  takeProfitPct: number | null
  stopLossPct: number | null
  holdHours: number | null
}

export type LegoRecipeSoftHints = {
  maxConcurrent?: number
  sortKey?: string
}

export type BrainGateKind =
  | 'membership'
  | 'mcap'
  | 'liquidity'
  | 'climateSafe'
  | 'bmScore'
  | 'bmFresh'
  | 'bmTop10'

export type BrainGateWrite = {
  kind: BrainGateKind
  enabled?: boolean
  n?: number
}

export type LegoRecipeWrite = {
  id: string
  active: boolean
  dormant?: boolean
  domain: LegoDomain
  universe: BrainListName[]
  gates: BrainGateWrite[]
  profileId: string
  softHints?: LegoRecipeSoftHints
  riskGrid: Record<BrainClimateState, RegimeRiskCell | null>
}

export type LegoRecipe = {
  id: string
  active: boolean
  dormant?: boolean
  domain: LegoDomain | string
  universe: BrainListName[]
  gates: unknown
  profileId: string
  softHints?: LegoRecipeSoftHints
  riskGrid?: Partial<Record<BrainClimateState, RegimeRiskCell | null>>
  raw: Record<string, unknown>
}

export type BrainRecipeAction = 'activate' | 'deactivate' | 'dormant'

export type MarketBrainFetchOpts = {
  baseUrl?: string
  token?: string | null
  /** Admin write token; never log. Overrides MARKET_BRAIN_ADMIN_TOKEN when passed. */
  adminToken?: string | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Extra query string (already encoded), e.g. `profile=default`. */
  query?: string
}

const DEFAULT_TIMEOUT_MS = 8_000
const MISSING_ADMIN_TOKEN_ERROR = 'MARKET_BRAIN_ADMIN_TOKEN is not set'

let missingAdminTokenLogged = false

/** Test-only: allow the missing-admin log-once latch to fire again. */
export function resetMarketBrainAdminWarnForTests(): void {
  missingAdminTokenLogged = false
}

export function warnMissingBrainAdminTokenOnce(context: string): void {
  if (missingAdminTokenLogged) return
  missingAdminTokenLogged = true
  console.warn(
    `[market-brain] ${MISSING_ADMIN_TOKEN_ERROR}; skipping recipe write (${context})`,
  )
}

function envFlag(key: string, fallback = false): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === '1' || v === 'true'
}

export function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function trimString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = trimString(obj[key])
    if (found) return found
  }
  return null
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = asFiniteNumber(obj[key])
    if (n != null) return n
  }
  return null
}

export function marketBrainUrl(override?: string): string {
  const raw = (override ?? process.env.MARKET_BRAIN_URL ?? '').trim()
  const base = raw || DEFAULT_MARKET_BRAIN_URL
  return base.replace(/\/+$/, '')
}

/** Read token; never log the return value. */
export function marketBrainToken(override?: string | null): string | null {
  if (override !== undefined) {
    const trimmed = override?.trim() ?? ''
    return trimmed ? trimmed : null
  }
  const env = process.env.MARKET_BRAIN_TOKEN?.trim() ?? ''
  return env ? env : null
}

/** Admin write token; never log the return value. */
export function marketBrainAdminToken(override?: string | null): string | null {
  if (override !== undefined) {
    const trimmed = override?.trim() ?? ''
    return trimmed ? trimmed : null
  }
  const env = process.env.MARKET_BRAIN_ADMIN_TOKEN?.trim() ?? ''
  return env ? env : null
}

export function isMarketBrainConfigured(opts?: {
  baseUrl?: string
  token?: string | null
}): boolean {
  return Boolean(marketBrainUrl(opts?.baseUrl) && marketBrainToken(opts?.token))
}

export function isMarketBrainAdminConfigured(opts?: {
  baseUrl?: string
  adminToken?: string | null
}): boolean {
  return Boolean(marketBrainUrl(opts?.baseUrl) && marketBrainAdminToken(opts?.adminToken))
}

/**
 * Opt-in trending/assign plug: requires MARKET_BRAIN_TRENDING=1 *and* a read token.
 * Missing token keeps the existing Jupiter toptrending path.
 */
export function isMarketBrainTrendingEnabled(opts?: {
  baseUrl?: string
  token?: string | null
}): boolean {
  return envFlag('MARKET_BRAIN_TRENDING', false) && isMarketBrainConfigured(opts)
}

export function marketBrainTrendingSkipReason(opts?: {
  baseUrl?: string
  token?: string | null
}): string | null {
  if (!envFlag('MARKET_BRAIN_TRENDING', false)) return null
  if (isMarketBrainConfigured(opts)) return null
  return 'MARKET_BRAIN_TRENDING=1 but MARKET_BRAIN_TOKEN is not set; using Jupiter toptrending'
}

export function isBrainListName(value: unknown): value is BrainListName {
  return typeof value === 'string' && (BRAIN_LIST_NAMES as readonly string[]).includes(value)
}

function nestedBaseAsset(obj: Record<string, unknown>): Record<string, unknown> | null {
  return asObject(obj.baseAsset) ?? asObject(obj.base_asset)
}

export function extractMint(value: unknown): string | null {
  if (typeof value === 'string') return trimString(value)
  const obj = asObject(value)
  if (!obj) return null
  const direct = firstString(obj, [
    'mint',
    'id',
    'address',
    'token_address',
    'tokenAddress',
    'tokenMint',
  ])
  if (direct) return direct
  const base = nestedBaseAsset(obj)
  if (base) return firstString(base, ['id', 'mint', 'address'])
  return null
}

export function parseBrainListToken(value: unknown): BrainListToken | null {
  const mint = extractMint(value)
  if (!mint) return null
  const obj = asObject(value) ?? { mint }
  const base = nestedBaseAsset(obj)
  const merged: Record<string, unknown> = { ...obj, ...(base ?? {}) }
  return {
    mint,
    symbol: firstString(merged, ['symbol', 'token_symbol', 'tokenSymbol']),
    name: firstString(merged, ['name', 'token_name', 'tokenName']),
    marketCap: firstNumber(merged, ['marketCap', 'market_cap', 'mcap', 'fdv']),
    liquidity: firstNumber(merged, ['liquidity', 'liq', 'liquidityUsd', 'liquidity_usd']),
    score100: firstNumber(merged, ['score100', 'score_100', 'bmScore', 'bm_score']),
    freshWalletsPct: firstNumber(merged, [
      'freshWalletsPct',
      'fresh_wallets_pct',
      'freshPct',
    ]),
    top10AdjustedPct: firstNumber(merged, [
      'top10AdjustedPct',
      'top10_adjusted_pct',
      'top10Pct',
      'topHoldersPercentage',
    ]),
    raw: obj,
  }
}

function collectTokenValues(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  const obj = asObject(body)
  if (!obj) return []
  for (const key of ['tokens', 'items', 'rows', 'list', 'data', 'mints', 'pools']) {
    const value = obj[key]
    if (Array.isArray(value)) return value
    const nested = asObject(value)
    if (nested) {
      for (const inner of ['tokens', 'items', 'rows', 'mints']) {
        if (Array.isArray(nested[inner])) return nested[inner] as unknown[]
      }
    }
  }
  return []
}

export function parseBrainListPayload(
  list: BrainListName,
  body: unknown,
): BrainListPayload {
  const obj = asObject(body)
  const tokens: BrainListToken[] = []
  const seen = new Set<string>()
  for (const row of collectTokenValues(body)) {
    const token = parseBrainListToken(row)
    if (!token || seen.has(token.mint)) continue
    seen.add(token.mint)
    tokens.push(token)
  }
  return {
    list,
    generatedAt:
      firstString(obj ?? {}, ['generatedAt', 'generated_at', 'fetchedAt', 'updatedAt']) ??
      null,
    tokens,
    mints: tokens.map((t) => t.mint),
  }
}

function parseClimateState(value: unknown): BrainClimateState | null {
  return typeof value === 'string' &&
    (BRAIN_CLIMATE_STATES as readonly string[]).includes(value)
    ? (value as BrainClimateState)
    : null
}

export function parseRegimeParams(body: unknown): RegimeParamsResolved | null {
  const obj = asObject(body)
  if (!obj) return null
  const inner = asObject(obj.params) ?? asObject(obj.data) ?? obj
  const sizeScale = asFiniteNumber(inner.sizeScale ?? inner.size_scale)
  if (sizeScale == null) return null
  return {
    profileId: firstString(inner, ['profileId', 'profile_id', 'profile']) ?? 'default',
    state: parseClimateState(inner.state),
    sizeScale,
    takeProfitPct: asFiniteNumber(inner.takeProfitPct ?? inner.take_profit_pct),
    stopLossPct: asFiniteNumber(inner.stopLossPct ?? inner.stop_loss_pct),
    holdHours: asFiniteNumber(inner.holdHours ?? inner.hold_hours),
    climateFetchedAt: firstString(inner, [
      'climateFetchedAt',
      'climate_fetched_at',
      'fetchedAt',
    ]),
    reason: firstString(inner, ['reason']) ?? undefined,
    raw: inner,
  }
}

function parseUniverse(value: unknown): BrainListName[] {
  if (typeof value === 'string' && isBrainListName(value)) return [value]
  if (!Array.isArray(value)) return []
  const out: BrainListName[] = []
  for (const item of value) {
    if (isBrainListName(item) && !out.includes(item)) out.push(item)
  }
  return out
}

function parseRiskCell(value: unknown): RegimeRiskCell | null {
  if (value === null) return null
  const obj = asObject(value)
  if (!obj) return null
  const sizeScale = asFiniteNumber(obj.sizeScale ?? obj.size_scale)
  if (sizeScale == null) return null
  return {
    sizeScale,
    takeProfitPct: asFiniteNumber(obj.takeProfitPct ?? obj.take_profit_pct),
    stopLossPct: asFiniteNumber(obj.stopLossPct ?? obj.stop_loss_pct),
    holdHours: asFiniteNumber(obj.holdHours ?? obj.hold_hours),
  }
}

export function parseLegoRecipe(value: unknown): LegoRecipe | null {
  const obj = asObject(value)
  if (!obj) return null
  const id = firstString(obj, ['id', 'recipeId', 'recipe_id'])
  if (!id) return null
  const domain = firstString(obj, ['domain']) ?? 'trending'
  const profileId = firstString(obj, ['profileId', 'profile_id']) ?? 'default'
  const riskGridRaw = asObject(obj.riskGrid) ?? asObject(obj.risk_grid)
  const riskGrid: LegoRecipe['riskGrid'] = {}
  if (riskGridRaw) {
    for (const state of BRAIN_CLIMATE_STATES) {
      if (state in riskGridRaw) {
        riskGrid[state] = parseRiskCell(riskGridRaw[state])
      }
    }
  }
  const hintsObj = asObject(obj.softHints) ?? asObject(obj.soft_hints)
  return {
    id,
    active: obj.active === true,
    dormant: obj.dormant === true ? true : undefined,
    domain,
    universe: parseUniverse(obj.universe),
    gates: obj.gates ?? [],
    profileId,
    softHints: hintsObj
      ? {
          maxConcurrent:
            asFiniteNumber(hintsObj.maxConcurrent ?? hintsObj.max_concurrent) ??
            undefined,
          sortKey: firstString(hintsObj, ['sortKey', 'sort_key']) ?? undefined,
        }
      : undefined,
    riskGrid: Object.keys(riskGrid).length > 0 ? riskGrid : undefined,
    raw: obj,
  }
}

function collectRecipeValues(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  const obj = asObject(body)
  if (!obj) return []
  const nestedRecipe = asObject(obj.recipe)
  if (nestedRecipe && firstString(nestedRecipe, ['id', 'recipeId', 'recipe_id'])) {
    return [nestedRecipe]
  }
  for (const key of ['recipes', 'items', 'data']) {
    const value = obj[key]
    if (Array.isArray(value)) return value
    const nested = asObject(value)
    if (nested && Array.isArray(nested.recipes)) return nested.recipes
  }
  if (firstString(obj, ['id', 'recipeId', 'recipe_id'])) return [obj]
  return []
}

export function parseLegoRecipeFromWriteBody(body: unknown): LegoRecipe | null {
  return parseLegoRecipe(asObject(body)?.recipe) ?? parseLegoRecipes(body)[0] ?? null
}

export function parseLegoRecipes(body: unknown): LegoRecipe[] {
  const out: LegoRecipe[] = []
  const seen = new Set<string>()
  for (const row of collectRecipeValues(body)) {
    const recipe = parseLegoRecipe(row)
    if (!recipe || seen.has(recipe.id)) continue
    seen.add(recipe.id)
    out.push(recipe)
  }
  return out
}

export function brainListMints(payload: BrainListPayload): Set<string> {
  return new Set(payload.mints)
}

function fail<T>(error: string, extra?: { status?: number; path?: string }): BrainResult<T> {
  return { ok: false, error, ...extra }
}

export async function fetchBrainJson<T = unknown>(
  path: string,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<T>> {
  const base = marketBrainUrl(opts.baseUrl)
  const token = marketBrainToken(opts.token)
  const suffix = path.startsWith('/') ? path : `/${path}`
  const query = opts.query?.replace(/^\?/, '')
  const url = `${base}${suffix}${query ? `?${query}` : ''}`
  if (!token) {
    return fail('MARKET_BRAIN_TOKEN is not set', { path: suffix })
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'reloadsol-buybulk-brain/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = res.status
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return fail(`market-brain ${suffix}: invalid JSON (HTTP ${status})`, {
        status,
        path: suffix,
      })
    }
    if (!res.ok) {
      const obj = asObject(json)
      const msg =
        trimString(obj?.error) ||
        trimString(obj?.message) ||
        `HTTP ${status}`
      return fail(`market-brain ${suffix}: ${msg}`, { status, path: suffix })
    }
    return { ok: true, data: json as T, status }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return fail(`market-brain ${suffix}: ${msg}`, { path: suffix })
  }
}

export async function fetchBrainHealth(
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<Record<string, unknown>>> {
  const base = marketBrainUrl(opts.baseUrl)
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const res = await fetchImpl(`${base}/health`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'reloadsol-buybulk-brain/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      return fail(`market-brain /health: HTTP ${res.status}`, {
        status: res.status,
        path: '/health',
      })
    }
    const obj = asObject(json) ?? {}
    return { ok: true, data: obj, status: res.status }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return fail(`market-brain /health: ${msg}`, { path: '/health' })
  }
}

export async function fetchBrainList(
  list: BrainListName,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<BrainListPayload>> {
  const raw = await fetchBrainJson(`/${list}`, opts)
  if (!raw.ok) return raw
  return {
    ok: true,
    status: raw.status,
    data: parseBrainListPayload(list, raw.data),
  }
}

export async function fetchBrainBubble(opts: MarketBrainFetchOpts = {}) {
  return fetchBrainList('bubble', opts)
}

export async function fetchBrainJupiter(opts: MarketBrainFetchOpts = {}) {
  return fetchBrainList('jupiter', opts)
}

export async function fetchBrainUnion(opts: MarketBrainFetchOpts = {}) {
  return fetchBrainList('union', opts)
}

export async function fetchBrainRegimeParams(
  profile = 'default',
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<RegimeParamsResolved>> {
  const raw = await fetchBrainJson('/regime/params', {
    ...opts,
    query: `profile=${encodeURIComponent(profile)}`,
  })
  if (!raw.ok) return raw
  const parsed = parseRegimeParams(raw.data)
  if (!parsed) {
    return fail('market-brain /regime/params: missing sizeScale', {
      status: raw.status,
      path: '/regime/params',
    })
  }
  return { ok: true, status: raw.status, data: parsed }
}

export async function fetchBrainRecipes(
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe[]>> {
  const raw = await fetchBrainJson('/recipes', opts)
  if (!raw.ok) return raw
  return { ok: true, status: raw.status, data: parseLegoRecipes(raw.data) }
}

export async function fetchBrainRecipe(
  id: string,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  const encoded = encodeURIComponent(id)
  const raw = await fetchBrainJson(`/recipes/${encoded}`, opts)
  if (!raw.ok) return raw
  const parsed = parseLegoRecipe(raw.data) ?? parseLegoRecipes(raw.data)[0] ?? null
  if (!parsed) {
    return fail(`market-brain /recipes/${encoded}: missing recipe id`, {
      status: raw.status,
      path: `/recipes/${encoded}`,
    })
  }
  return { ok: true, status: raw.status, data: parsed }
}

export type MarketBrainWriteOpts = MarketBrainFetchOpts & {
  method: 'POST' | 'PUT'
  body?: unknown
}

/**
 * Admin write fetch (PUT/POST). Fail-soft when MARKET_BRAIN_ADMIN_TOKEN is missing.
 * Never logs the token.
 */
export async function fetchBrainAdminJson<T = unknown>(
  path: string,
  opts: MarketBrainWriteOpts,
): Promise<BrainResult<T>> {
  const base = marketBrainUrl(opts.baseUrl)
  const token = marketBrainAdminToken(opts.adminToken)
  const suffix = path.startsWith('/') ? path : `/${path}`
  const query = opts.query?.replace(/^\?/, '')
  const url = `${base}${suffix}${query ? `?${query}` : ''}`
  if (!token) {
    return fail(MISSING_ADMIN_TOKEN_ERROR, { path: suffix })
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'reloadsol-buybulk-brain/1.0',
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  try {
    const res = await fetchImpl(url, {
      method: opts.method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = res.status
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return fail(`market-brain ${suffix}: invalid JSON (HTTP ${status})`, {
        status,
        path: suffix,
      })
    }
    if (!res.ok) {
      const obj = asObject(json)
      const msg =
        trimString(obj?.error) ||
        trimString(obj?.message) ||
        `HTTP ${status}`
      return fail(`market-brain ${suffix}: ${msg}`, { status, path: suffix })
    }
    return { ok: true, data: json as T, status }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return fail(`market-brain ${suffix}: ${msg}`, { path: suffix })
  }
}

function recipeWriteResult(
  raw: BrainResult<unknown>,
  path: string,
): BrainResult<LegoRecipe> {
  if (!raw.ok) return raw
  const parsed = parseLegoRecipeFromWriteBody(raw.data)
  if (!parsed) {
    return fail(`market-brain ${path}: missing recipe id`, {
      status: raw.status,
      path,
    })
  }
  return { ok: true, status: raw.status, data: parsed }
}

/** Idempotent upsert (brain PUT /recipes/:id). */
export async function putBrainRecipe(
  recipe: LegoRecipeWrite,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  const encoded = encodeURIComponent(recipe.id)
  const path = `/recipes/${encoded}`
  const raw = await fetchBrainAdminJson(path, {
    ...opts,
    method: 'PUT',
    body: recipe,
  })
  return recipeWriteResult(raw, path)
}

/** Create-only (brain POST /recipes). 409 if the id already exists. */
export async function postBrainRecipe(
  recipe: LegoRecipeWrite,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  const raw = await fetchBrainAdminJson('/recipes', {
    ...opts,
    method: 'POST',
    body: recipe,
  })
  return recipeWriteResult(raw, '/recipes')
}

export async function postBrainRecipeAction(
  id: string,
  action: BrainRecipeAction,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  const encoded = encodeURIComponent(id)
  const path = `/recipes/${encoded}/${action}`
  const raw = await fetchBrainAdminJson(path, {
    ...opts,
    method: 'POST',
  })
  return recipeWriteResult(raw, path)
}

export async function activateBrainRecipe(
  id: string,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  return postBrainRecipeAction(id, 'activate', opts)
}

export async function deactivateBrainRecipe(
  id: string,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  return postBrainRecipeAction(id, 'deactivate', opts)
}

export async function dormantBrainRecipe(
  id: string,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<LegoRecipe>> {
  return postBrainRecipeAction(id, 'dormant', opts)
}

/**
 * TODO(lego mcap): plug mcap tracker candidates through fetchBrainList + evaluateRecipeGates.
 * Helper only this slice — do not change mcap live/sim execute.
 */
export function mcapFactsFromBrainToken(token: BrainListToken): {
  mint: string
  marketCap: number | null
  liquidity: number | null
} {
  return {
    mint: token.mint,
    marketCap: token.marketCap,
    liquidity: token.liquidity,
  }
}

/**
 * TODO(lego signals): plug signals candidates through brain lists + evaluateRecipeGates.
 * Helper only this slice — do not change signals execute.
 */
export function signalsFactsFromBrainToken(token: BrainListToken): {
  mint: string
  marketCap: number | null
  liquidity: number | null
  score100: number | null
} {
  return {
    mint: token.mint,
    marketCap: token.marketCap,
    liquidity: token.liquidity,
    score100: token.score100,
  }
}
