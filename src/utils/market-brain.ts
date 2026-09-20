/**
 * buy_bulk client for live market-brain (lists + recipes + regime params + OHLC).
 *
 * CONNECT (read):
 * - Base: https://market-brain.yonathanevanchristy.workers.dev
 * - Health: GET /health (public)
 * - Lists (Bearer MARKET_BRAIN_TOKEN = BRAIN_READ_TOKEN): GET /bubble /jupiter /union
 * - Regime: GET /regime/params?profile=default (Bearer read)
 * - Recipes read: GET /recipes, GET /recipes/:id (Bearer read)
 * - OHLC: GET /ohlc, GET /ohlc/patterns (Bearer read)
 * - Recipes write: PUT /recipes/:id, POST /recipes,
 *   POST /recipes/:id/{activate,deactivate,dormant}
 *   (Bearer MARKET_BRAIN_ADMIN_TOKEN = BRAIN_ADMIN_TOKEN)
 *
 * Env:
 * - MARKET_BRAIN_URL — optional base override (no trailing slash required)
 * - MARKET_BRAIN_TOKEN — Bearer read token (never logged)
 * - MARKET_BRAIN_ADMIN_TOKEN — Bearer admin token for recipe writes (never logged)
 * - MARKET_BRAIN_TRENDING=1 — opt-in trending/assign universe from GET /union
 * - MARKET_BRAIN_MCAP=1 — opt-in mcap sim-track membership from GET /union
 * - MARKET_BRAIN_SIGNALS=1 — opt-in signals sim-track membership from GET /union
 * - MARKET_BRAIN_OHLC — prefer GET /ohlc (default on when a read token is set;
 *   set `0`/`false` to force today's SolanaTracker/GMGN path)
 *
 * First-cut sim opens also resolve risk from GET /regime/params (live wins) then
 * recipe.riskGrid[state], even when the universe flags above are off.
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

function domainPlugEnabled(
  flag: string,
  opts?: { baseUrl?: string; token?: string | null },
): boolean {
  return envFlag(flag, false) && isMarketBrainConfigured(opts)
}

function domainPlugSkipReason(
  flag: string,
  fallback: string,
  opts?: { baseUrl?: string; token?: string | null },
): string | null {
  if (!envFlag(flag, false)) return null
  if (isMarketBrainConfigured(opts)) return null
  return fallback
}

/**
 * Opt-in trending/assign plug: requires MARKET_BRAIN_TRENDING=1 *and* a read token.
 * Missing token keeps the existing Jupiter toptrending path.
 */
export function isMarketBrainTrendingEnabled(opts?: {
  baseUrl?: string
  token?: string | null
}): boolean {
  return domainPlugEnabled('MARKET_BRAIN_TRENDING', opts)
}

export function marketBrainTrendingSkipReason(opts?: {
  baseUrl?: string
  token?: string | null
}): string | null {
  return domainPlugSkipReason(
    'MARKET_BRAIN_TRENDING',
    'MARKET_BRAIN_TRENDING=1 but MARKET_BRAIN_TOKEN is not set; using Jupiter toptrending',
    opts,
  )
}

/**
 * Opt-in mcap sim-track plug: requires MARKET_BRAIN_MCAP=1 *and* a read token.
 * Missing token keeps the existing tracker-candidate path. Does not change live execute.
 */
export function isMarketBrainMcapEnabled(opts?: {
  baseUrl?: string
  token?: string | null
}): boolean {
  return domainPlugEnabled('MARKET_BRAIN_MCAP', opts)
}

export function marketBrainMcapSkipReason(opts?: {
  baseUrl?: string
  token?: string | null
}): string | null {
  return domainPlugSkipReason(
    'MARKET_BRAIN_MCAP',
    'MARKET_BRAIN_MCAP=1 but MARKET_BRAIN_TOKEN is not set; using mcap tracker candidates',
    opts,
  )
}

/**
 * Opt-in signals sim-track plug: requires MARKET_BRAIN_SIGNALS=1 *and* a read token.
 * Missing token keeps the existing scored-candidate path.
 */
export function isMarketBrainSignalsEnabled(opts?: {
  baseUrl?: string
  token?: string | null
}): boolean {
  return domainPlugEnabled('MARKET_BRAIN_SIGNALS', opts)
}

export function marketBrainSignalsSkipReason(opts?: {
  baseUrl?: string
  token?: string | null
}): string | null {
  return domainPlugSkipReason(
    'MARKET_BRAIN_SIGNALS',
    'MARKET_BRAIN_SIGNALS=1 but MARKET_BRAIN_TOKEN is not set; using signals tracker candidates',
    opts,
  )
}

export const BRAIN_OHLC_INTERVALS = ['1m', '5m', '15m', '1h'] as const
export type BrainOhlcInterval = (typeof BRAIN_OHLC_INTERVALS)[number]
export type BrainOhlcChain = 'sol' | 'robinhood'

/**
 * Prefer brain GET /ohlc when a read token is set. Default ON when configured
 * (unlike TRENDING/MCAP/SIGNALS, which stay opt-in). Set MARKET_BRAIN_OHLC=0
 * to keep today's SolanaTracker/GMGN path.
 */
export function isMarketBrainOhlcEnabled(opts?: {
  baseUrl?: string
  token?: string | null
}): boolean {
  if (!isMarketBrainConfigured(opts)) return false
  const v = process.env.MARKET_BRAIN_OHLC
  if (v === undefined || v === '') return true
  if (v === '0' || v === 'false') return false
  return v === '1' || v === 'true'
}

export function marketBrainOhlcSkipReason(opts?: {
  baseUrl?: string
  token?: string | null
}): string | null {
  return domainPlugSkipReason(
    'MARKET_BRAIN_OHLC',
    'MARKET_BRAIN_OHLC=1 but MARKET_BRAIN_TOKEN is not set; using SolanaTracker/GMGN',
    opts,
  )
}

export type BrainOhlcBar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type BrainOhlcRugHit = {
  id: string
  label: string
  value: number | null
  threshold: number
  passed: boolean
}

export type BrainOhlcRugFeatures = {
  n: number
  dumpPct: number | null
  avgUpperWick: number | null
  wickTripBars: number
  volDeathRatio: number | null
}

export type BrainOhlcPatternSummary = {
  rug: {
    trip: boolean
    features: BrainOhlcRugFeatures
    hits: BrainOhlcRugHit[]
  }
  tags?: string[]
}

export type BrainOhlcResponse = {
  mint: string
  chain: BrainOhlcChain | string
  interval: string
  from: number
  to: number
  source: string
  candles: BrainOhlcBar[]
  generatedAt: string | null
  etag?: string
  patterns?: BrainOhlcPatternSummary
}

export type BrainOhlcQuery = {
  mint: string
  chain?: BrainOhlcChain | string
  interval?: string
  hours?: number
  from?: number
  to?: number
  includePatterns?: boolean
}

/** Prefix so Freeview/source labels can tell brain-served bars from direct ST/GMGN. */
export function brainOhlcSourceLabel(source: string | null | undefined): string {
  const trimmed = source?.trim() ?? ''
  if (!trimmed) return 'brain'
  return trimmed.startsWith('brain') ? trimmed : `brain:${trimmed}`
}

export function inferBrainOhlcChain(
  mint: string,
  chain?: string | null,
): BrainOhlcChain {
  if (chain === 'robinhood' || chain === 'sol') return chain
  return /^0x[a-fA-F0-9]{40}$/i.test(mint) ? 'robinhood' : 'sol'
}

function toUnixBarTime(v: number): number {
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
}

export function parseBrainOhlcBar(value: unknown): BrainOhlcBar | null {
  const obj = asObject(value)
  if (!obj) return null
  const timeRaw = firstNumber(obj, ['time', 'timestamp', 't'])
  const open = firstNumber(obj, ['open', 'o'])
  const high = firstNumber(obj, ['high', 'h'])
  const low = firstNumber(obj, ['low', 'l'])
  const close = firstNumber(obj, ['close', 'c'])
  if (
    timeRaw == null ||
    open == null ||
    high == null ||
    low == null ||
    close == null
  ) {
    return null
  }
  const volume = firstNumber(obj, ['volume', 'v'])
  return {
    time: toUnixBarTime(timeRaw),
    open,
    high,
    low,
    close,
    ...(volume != null ? { volume } : {}),
  }
}

function collectOhlcBars(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  const obj = asObject(body)
  if (!obj) return []
  for (const key of ['candles', 'ohlcv', 'oclhv', 'list', 'bars', 'kline']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[]
  }
  const nested = asObject(obj.data)
  if (nested) {
    for (const key of ['candles', 'ohlcv', 'oclhv', 'list', 'bars']) {
      if (Array.isArray(nested[key])) return nested[key] as unknown[]
    }
  }
  return []
}

function parseBrainOhlcRugHit(value: unknown): BrainOhlcRugHit | null {
  const obj = asObject(value)
  if (!obj) return null
  const id = firstString(obj, ['id'])
  const label = firstString(obj, ['label'])
  if (!id || !label) return null
  return {
    id,
    label,
    value: asFiniteNumber(obj.value),
    threshold: asFiniteNumber(obj.threshold) ?? 0,
    passed: obj.passed === true,
  }
}

export function parseBrainOhlcPatterns(
  value: unknown,
): BrainOhlcPatternSummary | undefined {
  const obj = asObject(value)
  if (!obj) return undefined
  const rugObj = asObject(obj.rug)
  if (!rugObj) return undefined
  const featuresObj = asObject(rugObj.features) ?? {}
  const hitsRaw = Array.isArray(rugObj.hits) ? rugObj.hits : []
  const hits: BrainOhlcRugHit[] = []
  for (const row of hitsRaw) {
    const hit = parseBrainOhlcRugHit(row)
    if (hit) hits.push(hit)
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : undefined
  return {
    rug: {
      trip: rugObj.trip === true,
      features: {
        n: asFiniteNumber(featuresObj.n) ?? 0,
        dumpPct: asFiniteNumber(featuresObj.dumpPct ?? featuresObj.dump_pct),
        avgUpperWick: asFiniteNumber(
          featuresObj.avgUpperWick ?? featuresObj.avg_upper_wick,
        ),
        wickTripBars: asFiniteNumber(
          featuresObj.wickTripBars ?? featuresObj.wick_trip_bars,
        ) ?? 0,
        volDeathRatio: asFiniteNumber(
          featuresObj.volDeathRatio ?? featuresObj.vol_death_ratio,
        ),
      },
      hits,
    },
    ...(tags && tags.length > 0 ? { tags } : {}),
  }
}

export function parseBrainOhlcResponse(
  body: unknown,
  fallbackMint?: string,
): BrainOhlcResponse | null {
  const obj = asObject(body)
  const inner = asObject(obj?.data) ?? obj
  if (!inner) return null
  const mint =
    firstString(inner, ['mint', 'tokenAddress', 'token_address', 'address']) ??
    fallbackMint?.trim() ??
    null
  if (!mint) return null
  const candles: BrainOhlcBar[] = []
  for (const row of collectOhlcBars(inner)) {
    const bar = parseBrainOhlcBar(row)
    if (bar) candles.push(bar)
  }
  candles.sort((a, b) => a.time - b.time)
  const from = firstNumber(inner, ['from', 'timeFrom', 'time_from']) ?? 0
  const to = firstNumber(inner, ['to', 'timeTo', 'time_to']) ?? 0
  const patterns = parseBrainOhlcPatterns(inner.patterns)
  const etag = firstString(inner, ['etag', 'ETag']) ?? undefined
  return {
    mint,
    chain: inferBrainOhlcChain(
      mint,
      firstString(inner, ['chain']) ?? undefined,
    ),
    interval: firstString(inner, ['interval', 'type', 'resolution']) ?? '',
    from,
    to,
    source: firstString(inner, ['source']) ?? 'brain',
    candles,
    generatedAt: firstString(inner, ['generatedAt', 'generated_at']) ?? null,
    ...(etag ? { etag } : {}),
    ...(patterns ? { patterns } : {}),
  }
}

export function buildBrainOhlcQuery(query: BrainOhlcQuery): string {
  const p = new URLSearchParams()
  p.set('mint', query.mint.trim())
  const chain = query.chain?.trim()
  if (chain) p.set('chain', chain)
  const interval = query.interval?.trim()
  if (interval) p.set('interval', interval)
  if (query.hours != null && Number.isFinite(query.hours)) {
    p.set('hours', String(Math.min(Math.max(Math.round(query.hours), 1), 168)))
  }
  if (query.from != null && Number.isFinite(query.from)) {
    p.set('from', String(Math.floor(query.from)))
  }
  if (query.to != null && Number.isFinite(query.to)) {
    p.set('to', String(Math.floor(query.to)))
  }
  if (query.includePatterns) p.set('include', 'patterns')
  return p.toString()
}

/** Fallback on any brain miss (5xx/timeout/4xx/empty) so Freeview does not blank. */
export function shouldFallbackBrainOhlc(
  result: BrainResult<{ candles: unknown[] }>,
): boolean {
  if (!result.ok) return true
  return result.data.candles.length === 0
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

export async function fetchBrainOhlc(
  query: BrainOhlcQuery,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<BrainOhlcResponse>> {
  const mint = query.mint.trim()
  if (!mint) {
    return fail('market-brain /ohlc: mint is required', { path: '/ohlc' })
  }
  const raw = await fetchBrainJson('/ohlc', {
    ...opts,
    query: buildBrainOhlcQuery({ ...query, mint }),
  })
  if (!raw.ok) return raw
  const parsed = parseBrainOhlcResponse(raw.data, mint)
  if (!parsed) {
    return fail('market-brain /ohlc: invalid payload', {
      status: raw.status,
      path: '/ohlc',
    })
  }
  return { ok: true, status: raw.status, data: parsed }
}

export async function fetchBrainOhlcPatterns(
  query: BrainOhlcQuery,
  opts: MarketBrainFetchOpts = {},
): Promise<BrainResult<BrainOhlcPatternSummary>> {
  const mint = query.mint.trim()
  if (!mint) {
    return fail('market-brain /ohlc/patterns: mint is required', {
      path: '/ohlc/patterns',
    })
  }
  const raw = await fetchBrainJson('/ohlc/patterns', {
    ...opts,
    query: buildBrainOhlcQuery({ ...query, mint, includePatterns: false }),
  })
  if (!raw.ok) return raw
  const obj = asObject(raw.data)
  const parsed =
    parseBrainOhlcPatterns(obj) ??
    parseBrainOhlcPatterns(asObject(obj?.data)) ??
    parseBrainOhlcResponse(raw.data, mint)?.patterns ??
    null
  if (!parsed) {
    return fail('market-brain /ohlc/patterns: invalid payload', {
      status: raw.status,
      path: '/ohlc/patterns',
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
 * Mcap sim-track facts from a brain list row (membership + default mcap/liq gates).
 * Live execute is unchanged; callers opt in via MARKET_BRAIN_MCAP=1.
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
 * Signals sim-track facts from a brain list row. score100 is for recipe opt-in
 * bmScore only — default gates do not use it.
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
