/**
 * Thin regime-climate client for ReloadSOL DLMM (S5).
 *
 * Vendored from rh-tape-bot-cf `src/climate.ts` / `@btc/shared` interpretClimate + sizeHint
 * because this repo cannot depend on `@btc/shared`. Source of truth for the payload:
 * `GET https://terminal.reloadsol.app/api/regime/climate` (btc-sentiment-terminal CONSUMER.md).
 *
 * sizeHint: Cash=0 … Hype=1. Cascade / news veto caps sizeKind ≤ trim.
 * Kill switch + daily-loss (DLMM pause, circuit breaker, capital caps) always win —
 * this module only reduces size or blocks; it never increases risk and never unpauses.
 *
 * Default OFF (`CLIMATE_GATE=1` to enable). Paper/dry-run only unless `CLIMATE_GATE_LIVE=1`
 * (ask before enabling live). Fetch errors fail-open unless `CLIMATE_FAIL_CLOSED=1`.
 *
 * TODO(S5): wire climateGate into buy_bulk when that tree exists in this repo.
 * buy_bulk is not part of reloadsol (social-ingest posts to an external buy_bulk ingest).
 */

export const DEFAULT_CLIMATE_URL = 'https://terminal.reloadsol.app/api/regime/climate'
export const DEFAULT_CLIMATE_CACHE_MS = 30_000

export const CLIMATE_STATES = ['Hype', 'Range', 'Mixed', 'De-risk', 'Cash'] as const
export type ClimateState = (typeof CLIMATE_STATES)[number]

export const SIZE_KINDS = ['stand-down', 'trim', 'reduced', 'neutral', 'full'] as const
export type ClimateSizeKind = (typeof SIZE_KINDS)[number]

const STATE_RANK: Record<ClimateState, number> = {
  Cash: 0,
  'De-risk': 1,
  Mixed: 2,
  Range: 3,
  Hype: 4,
}

const SIZE_SCALE: Record<ClimateSizeKind, number> = {
  'stand-down': 0,
  trim: 0.25,
  reduced: 0.5,
  neutral: 0.75,
  full: 1,
}

const STATE_TO_SIZE: Record<ClimateState, ClimateSizeKind> = {
  Cash: 'stand-down',
  'De-risk': 'trim',
  Mixed: 'reduced',
  Range: 'neutral',
  Hype: 'full',
}

const SIZE_RANK: Record<ClimateSizeKind, number> = {
  'stand-down': 0,
  trim: 1,
  reduced: 2,
  neutral: 3,
  full: 4,
}

const NOT_WIRED = new Set(['e5', 'e4_depth'])

export type InterpretedClimate = {
  state: ClimateState
  h: number
  c: number
  cascadeVeto: boolean
  newsShock: boolean
  sizeKind: ClimateSizeKind
  /** Cash=0 … Hype=1 (after cascade/news cap ≤ trim). */
  scale: number
  feedAlarms: string[]
  notWired: string[]
  reason: string
}

export type ClimateGateResult = {
  ok: boolean
  fetchedAt: number
  state: ClimateState | null
  h: number | null
  c: number | null
  cascadeVeto: boolean
  newsShock: boolean
  sizeKind: ClimateSizeKind | 'unknown'
  scale: number
  feedAlarms: string[]
  notWired: string[]
  reason: string
  error?: string
}

export type ClimateOpenDecision = {
  allowed: boolean
  amount: number
  scale: number
  applied: boolean
  reason: string
  gate: ClimateGateResult | null
}

type JsonObject = Record<string, unknown>

type ClimateCache = { at: number; gate: ClimateGateResult }

let cache: ClimateCache | null = null

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function envFlag(key: string, fallback = false): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === '1' || v === 'true'
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function isState(value: unknown): value is ClimateState {
  return typeof value === 'string' && (CLIMATE_STATES as readonly string[]).includes(value)
}

function capState(state: ClimateState, max: ClimateState): ClimateState {
  return STATE_RANK[state] <= STATE_RANK[max] ? state : max
}

function capSize(kind: ClimateSizeKind, max: ClimateSizeKind): ClimateSizeKind {
  return SIZE_RANK[kind] <= SIZE_RANK[max] ? kind : max
}

export function isClimateGateEnabled(): boolean {
  return envFlag('CLIMATE_GATE', false)
}

export function isClimateGateLiveEnabled(): boolean {
  return envFlag('CLIMATE_GATE_LIVE', false)
}

export function isClimateFailClosed(): boolean {
  return envFlag('CLIMATE_FAIL_CLOSED', false)
}

export function climateUrl(): string {
  const url = process.env.CLIMATE_URL?.trim()
  return url || DEFAULT_CLIMATE_URL
}

/** sizeHint: Cash=0 … Hype=1 after veto caps. */
export function sizeHint(parsed: Pick<InterpretedClimate, 'scale'>): number {
  return parsed.scale
}

export function interpretClimate(data: unknown): InterpretedClimate {
  const o = asObject(data)
  if (!o) throw new Error('climate JSON not object')
  if (typeof o.h !== 'number' || typeof o.c !== 'number' || !isState(o.state)) {
    throw new Error('climate JSON missing h/c/state')
  }

  const cascade = asObject(o.cascade)
  const news = asObject(o.news)
  const cascadeVeto = cascade?.veto === true
  const newsShock =
    o.newsShock === true || news?.shock === true || news?.veto === true

  let state = o.state
  if (cascadeVeto || newsShock) state = capState(state, 'De-risk')

  let kind = STATE_TO_SIZE[state]
  if (cascadeVeto || newsShock) kind = capSize(kind, 'trim')

  const missing = Array.isArray(o.missing)
    ? o.missing.filter((x): x is string => typeof x === 'string')
    : []
  const pyth = asObject(o.pyth)
  const notWired: string[] = []
  const feedAlarms: string[] = []
  for (const key of missing) {
    if (NOT_WIRED.has(key) || (key === 'pyth' && pyth?.configured !== true)) {
      notWired.push(key)
    } else {
      feedAlarms.push(key)
    }
  }

  const reasons = [`state ${state} → ${kind}`]
  if (cascadeVeto) reasons.push('cascade.veto caps ≤ trim')
  if (newsShock) reasons.push('news shock caps ≤ trim')

  return {
    state,
    h: o.h,
    c: o.c,
    cascadeVeto,
    newsShock,
    sizeKind: kind,
    scale: SIZE_SCALE[kind],
    feedAlarms,
    notWired,
    reason: reasons.join('; '),
  }
}

export function logClimateGate(event: Record<string, unknown>): void {
  console.info('[climate_gate]', JSON.stringify(event))
}

export function resetClimateCache(): void {
  cache = null
}

export type FetchClimateOpts = {
  url?: string
  failClosed?: boolean
  fetchImpl?: typeof fetch
  now?: number
  cacheMs?: number
}

export async function fetchClimate(opts: FetchClimateOpts = {}): Promise<ClimateGateResult> {
  const now = opts.now ?? Date.now()
  const cacheMs = opts.cacheMs ?? envInt('CLIMATE_CACHE_MS', DEFAULT_CLIMATE_CACHE_MS)
  if (cache && now - cache.at < cacheMs) return cache.gate

  const url = (opts.url || climateUrl()).trim()
  const failClosed = opts.failClosed ?? isClimateFailClosed()
  const fetchImpl = opts.fetchImpl ?? fetch

  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'reloadsol-dlmm-climate/1.0',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json: unknown = await res.json()
    const parsed = interpretClimate(json)
    const gate: ClimateGateResult = { ok: true, fetchedAt: now, ...parsed }
    cache = { at: now, gate }
    return gate
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const gate: ClimateGateResult = {
      ok: false,
      state: null,
      h: null,
      c: null,
      cascadeVeto: false,
      newsShock: false,
      sizeKind: 'unknown',
      scale: failClosed ? 0 : 1,
      feedAlarms: [],
      notWired: [],
      reason: failClosed
        ? `climate fetch failed (fail-closed): ${msg}`
        : `climate fetch failed (fail-open): ${msg}`,
      fetchedAt: now,
      error: msg,
    }
    cache = { at: now, gate }
    return gate
  }
}

function climateLogFields(gate: ClimateGateResult): Record<string, unknown> {
  return {
    ok: gate.ok,
    state: gate.state,
    h: gate.h,
    c: gate.c,
    cascadeVeto: gate.cascadeVeto,
    newsShock: gate.newsShock,
    sizeKind: gate.sizeKind,
    scale: gate.scale,
    reason: gate.reason,
    error: gate.error,
    feedAlarms: gate.feedAlarms,
    notWired: gate.notWired,
  }
}

/**
 * DLMM new-risk policy (opens / size-up only; closes are never gated).
 * Stand-down (Cash) or cascade/news veto → block new risk.
 * Otherwise scale amount by sizeHint. Scale is clamped to [0, 1] so climate
 * cannot override kill / daily-loss / capital caps by increasing size.
 */
export async function applyClimateToNewRisk(opts: {
  amount: number
  paper: boolean
  source: string
  fetchImpl?: typeof fetch
}): Promise<ClimateOpenDecision> {
  const amountIn = Number.isFinite(opts.amount) && opts.amount > 0 ? opts.amount : 0

  if (!isClimateGateEnabled()) {
    return {
      allowed: true,
      amount: amountIn,
      scale: 1,
      applied: false,
      reason: 'CLIMATE_GATE off',
      gate: null,
    }
  }

  if (!opts.paper && !isClimateGateLiveEnabled()) {
    logClimateGate({
      source: opts.source,
      action: 'skipped_live',
      reason: 'ask-before-live: set CLIMATE_GATE_LIVE=1 after confirmation',
    })
    return {
      allowed: true,
      amount: amountIn,
      scale: 1,
      applied: false,
      reason: 'climate gate skipped (live; set CLIMATE_GATE_LIVE=1 after asking)',
      gate: null,
    }
  }

  const gate = await fetchClimate({ fetchImpl: opts.fetchImpl })
  const scale = Math.min(1, Math.max(0, gate.scale))
  logClimateGate({
    source: opts.source,
    action: 'evaluate',
    paper: opts.paper,
    amountIn,
    ...climateLogFields({ ...gate, scale }),
  })

  const standDown = scale <= 0 || gate.sizeKind === 'stand-down'
  const cascadeBlock = gate.cascadeVeto || gate.newsShock
  if (standDown || cascadeBlock) {
    const action = standDown ? 'climate_stand_down' : 'climate_cascade'
    logClimateGate({
      source: opts.source,
      ...climateLogFields({ ...gate, scale }),
      action: 'blocked',
      reason: action,
      climateReason: gate.reason,
    })
    return {
      allowed: false,
      amount: 0,
      scale,
      applied: true,
      reason: `climate_gate blocked (${action}): ${gate.reason}`,
      gate,
    }
  }

  const amount = Math.round(amountIn * scale * 1e9) / 1e9
  if (!(amount > 0)) {
    logClimateGate({
      source: opts.source,
      ...climateLogFields({ ...gate, scale }),
      action: 'blocked',
      reason: 'climate_size_zero',
      climateReason: gate.reason,
    })
    return {
      allowed: false,
      amount: 0,
      scale,
      applied: true,
      reason: `climate_gate blocked (climate_size_zero): ${gate.reason}`,
      gate,
    }
  }

  return {
    allowed: true,
    amount,
    scale,
    applied: true,
    reason: gate.reason,
    gate,
  }
}
