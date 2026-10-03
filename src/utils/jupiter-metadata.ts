/**
 * Jupiter Tokens v2 search — the one door for token metadata and market hints.
 *
 * Why this is a queue + cache and not a `fetch` wrapper (prod 2026-10-03/04):
 *   - `lite-api.jup.ag` is being phased out; its keyless rate limit is cut progressively and from our
 *     VPS it answered 429 on 2/2 probes. Every caller (risk assessment, entry hints, sim snapshots,
 *     token-locate, activity-poll, the UI route) fired its own single-mint request: ~38 upstream
 *     req/min, ~480 calls that exhausted every retry in 50 minutes.
 *   - `api.jup.ag` serves the same endpoint, KEYLESS at 0.5 rps (30/min) per client, in a bucket of its
 *     own — separate from the keyed org bucket that Price v3 and Swap /order already spend.
 *
 * So, in order, a lookup goes:
 *   1. L1 memory cache (per mint; TTL depends on what the caller needs — see MAX_AGE below)
 *   2. L2 Postgres cache (`jupiter_token_meta`; survives restarts) for metadata-class callers
 *   3. ONE shared queue: concurrent single-mint callers are coalesced into a single comma-separated
 *      request (<= 100 mints), in-flight de-duplicated, spaced by a global keyless token bucket
 *      (`JUPITER_META_RPS`, default 0.3 rps — under the 0.5 rps keyless ceiling, leaving headroom)
 *   4. keyless `api.jup.ag`; on 429 -> keyed `api.jup.ag` (x-api-key) through the shared keyed gate
 *      (`throttleJupiterRps('background')`), which never touches the trade-lane reserve
 *
 * Callers can tell the difference between "Jupiter has no such token" (`JupiterTokenNotFoundError`,
 * or `null`/`[]` from the raw helpers) and "Jupiter could not be asked" (`JupiterUnavailableError`).
 * A 429 is never evidence about the token.
 */
import {
  canTakeJupiterToken,
  refillJupiterTokens,
  takeJupiterToken,
  throttleJupiterRps,
  type JupiterGateConfig,
  type JupiterGateState,
} from '@/utils/jupiter-rps'
import { loadJupiterMetaRows, saveJupiterMetaRows } from '@/utils/jupiter-meta-store'

const SEARCH_URL = 'https://api.jup.ag/tokens/v2/search'
const USER_AGENT = 'ReloadSol-API/1.0'

const REQUEST_TIMEOUT_MS = 10_000 // covers headers AND body
const BATCH_WINDOW_MS = 150 // how long the first caller waits so concurrent callers share a request
const MAX_BATCH = 100 // Jupiter: "Limit to 100 mint addresses in query"
const QUEUE_MAX_WAIT_MS = 20_000 // a caller never waits longer than this behind the gate
const RETRY_DELAYS = [400, 800, 1600]
const COOLDOWN_DEFAULT_MS = 10_000 // Jupiter's limiter is a ~10s sliding window
const COOLDOWN_MIN_MS = 2_000
const COOLDOWN_MAX_MS = 30_000
const L1_MAX_ENTRIES = 3_000

/** Freshness a caller needs. Market data moves; metadata barely does; a mint's identity never does. */
export const JUPITER_MARKET_MAX_AGE_MS = 10_000
export const JUPITER_META_MAX_AGE_MS = 10 * 60_000
export const JUPITER_IMMUTABLE_MAX_AGE_MS = 7 * 24 * 60 * 60_000
/** On "Jupiter unavailable", metadata callers may be served an entry up to this old rather than nothing. */
export const JUPITER_STALE_ON_ERROR_MS = 6 * 60 * 60_000

function envNumber(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** Sustained keyless rate for the metadata queue. */
export function resolveJupiterMetaRps(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.JUPITER_META_RPS)
  return Number.isFinite(n) && n > 0 ? n : 0.3
}

function metaGateConfig(): JupiterGateConfig {
  const burst = Number(process.env.JUPITER_META_BURST)
  return {
    rps: resolveJupiterMetaRps(),
    capacity: Number.isFinite(burst) && burst >= 1 ? Math.floor(burst) : 2,
    tradeReserve: 0,
  }
}

const negativeTtlMs = () => envNumber('JUPITER_META_NEGATIVE_TTL_MS', 90_000, 0)
const keylessEnabled = () => process.env.JUPITER_META_KEYLESS !== '0'
const apiKey = () => process.env.JUPITER_API_KEY?.trim() || ''

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type JupiterUnavailableReason =
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'auth'
  | 'queue_timeout'

/** Jupiter could not be asked (429, timeout, 5xx, ...). Says NOTHING about the token. */
export class JupiterUnavailableError extends Error {
  readonly reason: JupiterUnavailableReason
  readonly retryAfterMs: number | null
  constructor(reason: JupiterUnavailableReason, message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'JupiterUnavailableError'
    this.reason = reason
    this.retryAfterMs = retryAfterMs
  }
}

/** Jupiter answered and has no such token. */
export class JupiterTokenNotFoundError extends Error {
  readonly mint: string
  constructor(mint: string) {
    super(`Token not found: ${mint}`)
    this.name = 'JupiterTokenNotFoundError'
    this.mint = mint
  }
}

export function isJupiterUnavailable(err: unknown): err is JupiterUnavailableError {
  return err instanceof JupiterUnavailableError
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
/** A string that could be a Solana mint. Anything else is answered "not found" without a request. */
export function isPlausibleMint(value: string): boolean {
  return MINT_RE.test(value)
}

/**
 * How long to stand down after a 429. Prefers Jupiter's `x-ratelimit-reset` (absolute epoch seconds
 * at which a slot frees), then `Retry-After` (seconds or HTTP date), else the ~10s window; clamped,
 * plus 0-20% jitter so processes do not wake in lock-step.
 */
export function jupiterRateLimitCooldownMs(
  headers: { retryAfter?: string | null; reset?: string | null },
  nowMs: number = Date.now(),
  random: () => number = Math.random,
): number {
  let ms = COOLDOWN_DEFAULT_MS
  const reset = headers.reset?.trim()
  const retryAfter = headers.retryAfter?.trim()
  const resetN = reset ? Number(reset) : NaN
  if (Number.isFinite(resetN) && resetN > 1e9) {
    ms = resetN * 1000 - nowMs
  } else if (retryAfter) {
    const n = Number(retryAfter)
    if (Number.isFinite(n) && n >= 0) ms = n * 1000
    else {
      const d = Date.parse(retryAfter)
      if (Number.isFinite(d)) ms = d - nowMs
    }
  }
  const clamped = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.ceil(ms)))
  return Math.ceil(clamped * (1 + 0.2 * random()))
}

/** Backoff for a transient (5xx / network) retry: base +-25% so concurrent callers de-synchronise. */
export function jitteredRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS[attempt] ?? 1600
  return Math.round(base * (0.75 + 0.5 * random()))
}

export type JupiterTokenMetadata = {
  decimals: number
  symbol: string
  name: string
  logoURI?: string
  graduatedPool: string | null
  bondingCurve: number | null
  organicScore: number | null
  audit?: { topHoldersPercentage: number | null }
  graduatedAt: number | null
  launchpad?: string
  dev: string | null
  devMints: number | null
}

/** Raw token object as returned by `tokens/v2/search`. */
export type JupiterRawToken = { id?: string; [key: string]: any }

/** Map a raw search record to the metadata shape every caller consumes. */
export function mapJupiterTokenToMetadata(token: JupiterRawToken): JupiterTokenMetadata {
  return {
    decimals: token.decimals,
    symbol: token.symbol,
    name: token.name,
    logoURI: token.icon,
    graduatedPool: token.graduatedPool || null,
    bondingCurve: typeof token.bondingCurve === 'number' ? token.bondingCurve : null,
    organicScore: typeof token.organicScore === 'number' ? token.organicScore : null,
    audit: token.audit
      ? {
          topHoldersPercentage:
            typeof token.audit.topHoldersPercentage === 'number' ? token.audit.topHoldersPercentage : null,
        }
      : undefined,
    graduatedAt: token.graduatedAt ? Number(token.graduatedAt) : null,
    launchpad: token.launchpad,
    // Creator wallet address (plain base58 string) + mint count. Jupiter has no coin
    // history/performance — that's GMGN created_tokens.
    dev: typeof token.dev === 'string' ? token.dev : (token.dev?.address ?? null),
    devMints: typeof token.audit?.devMints === 'number' ? token.audit.devMints : null,
  }
}

// ---------------------------------------------------------------------------------------------
// Process state (on globalThis: Next can instantiate a module once per route chunk)
// ---------------------------------------------------------------------------------------------

type Lane = 'keyless' | 'keyed'
type Priority = 'market' | 'meta'

type CacheEntry = { token: JupiterRawToken | null; at: number }

type Pending = {
  mint: string
  priority: Priority
  enqueuedAt: number
  inFlight: boolean
  promise: Promise<JupiterRawToken | null>
  resolve: (t: JupiterRawToken | null) => void
  reject: (e: unknown) => void
}

type Counters = {
  l1Hits: number
  l2Hits: number
  negativeHits: number
  staleServed: number
  requests: Record<Lane, number>
  rateLimited: Record<Lane, number>
  failures: number
  mintsRequested: number
}

type MetaState = {
  cache: Map<string, CacheEntry>
  pending: Map<string, Pending>
  flushing: boolean
  kickTimer: ReturnType<typeof setTimeout> | null
  keylessGate: JupiterGateState
  cooldownUntil: Record<Lane, number>
  counters: Counters
  statsSince: number
}

const newCounters = (): Counters => ({
  l1Hits: 0,
  l2Hits: 0,
  negativeHits: 0,
  staleServed: 0,
  requests: { keyless: 0, keyed: 0 },
  rateLimited: { keyless: 0, keyed: 0 },
  failures: 0,
  mintsRequested: 0,
})

function newState(): MetaState {
  return {
    cache: new Map(),
    pending: new Map(),
    flushing: false,
    kickTimer: null,
    keylessGate: { tokens: metaGateConfig().capacity, updatedAt: 0, tradeWaiting: 0 },
    cooldownUntil: { keyless: 0, keyed: 0 },
    counters: newCounters(),
    statsSince: Date.now(),
  }
}

const G = globalThis as typeof globalThis & { __reloadsolJupiterMeta?: MetaState }
function state(): MetaState {
  return (G.__reloadsolJupiterMeta ??= newState())
}

export function __resetJupiterMetadataForTests(): void {
  const s = G.__reloadsolJupiterMeta
  if (s?.kickTimer) clearTimeout(s.kickTimer)
  G.__reloadsolJupiterMeta = undefined
}

/** Milliseconds until a request could be attempted on at least one lane (0 = a lane is open). */
export function jupiterMetadataCooldownRemainingMs(nowMs: number = Date.now()): number {
  const s = state()
  const waits: number[] = []
  if (keylessEnabled()) waits.push(Math.max(0, s.cooldownUntil.keyless - nowMs))
  if (apiKey()) waits.push(Math.max(0, s.cooldownUntil.keyed - nowMs))
  return waits.length === 0 ? 0 : Math.min(...waits)
}

/** Counters since the last stats line; exposed for tests and ad-hoc inspection. */
export function getJupiterMetadataStats(): Counters & { queued: number; cacheSize: number } {
  const s = state()
  return { ...s.counters, queued: s.pending.size, cacheSize: s.cache.size }
}

/** One log line per 10 minutes — this is what the before/after Jupiter numbers are read from. */
function maybeLogStats(): void {
  const s = state()
  const now = Date.now()
  if (now - s.statsSince < 10 * 60_000) return
  const c = s.counters
  const total = c.l1Hits + c.l2Hits + c.negativeHits + c.mintsRequested
  // console.warn on purpose: next.config removeConsole strips console.log/info in production builds
  console.warn(
    `[jupiter-metadata] stats ${Math.round((now - s.statsSince) / 60_000)}m: ` +
      `lookups=${total} l1=${c.l1Hits} l2=${c.l2Hits} neg=${c.negativeHits} stale=${c.staleServed} ` +
      `upstream_mints=${c.mintsRequested} keyless_req=${c.requests.keyless} keyed_req=${c.requests.keyed} ` +
      `429_keyless=${c.rateLimited.keyless} 429_keyed=${c.rateLimited.keyed} failed_batches=${c.failures}`,
  )
  Object.assign(s.counters, newCounters()) // in place: in-flight lookups hold a reference
  s.statsSince = now
}

// ---------------------------------------------------------------------------------------------
// L1 cache
// ---------------------------------------------------------------------------------------------

type CacheRead = { hit: true; token: JupiterRawToken | null } | { hit: false }

function readCache(mint: string, maxAgeMs: number, now: number): CacheRead {
  const e = state().cache.get(mint)
  if (!e) return { hit: false }
  if (e.token === null) return now - e.at <= negativeTtlMs() ? { hit: true, token: null } : { hit: false }
  return now - e.at <= maxAgeMs ? { hit: true, token: e.token } : { hit: false }
}

function readStale(mint: string, now: number): JupiterRawToken | null {
  const e = state().cache.get(mint)
  return e?.token && now - e.at <= JUPITER_STALE_ON_ERROR_MS ? e.token : null
}

function writeCache(mint: string, token: JupiterRawToken | null, now: number): void {
  const { cache } = state()
  cache.delete(mint) // re-insert so Map order == recency
  cache.set(mint, { token, at: now })
  while (cache.size > L1_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

// ---------------------------------------------------------------------------------------------
// Gate + lanes
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Wait for a keyless token. Global (one bucket per process) so N callers cannot multiply the rate. */
async function acquireKeyless(): Promise<void> {
  const s = state()
  const cfg = metaGateConfig()
  for (;;) {
    refillJupiterTokens(s.keylessGate, Date.now(), cfg)
    const { ok, waitMs } = canTakeJupiterToken(s.keylessGate, 'trade', cfg)
    if (ok) {
      takeJupiterToken(s.keylessGate)
      return
    }
    await sleep(Math.max(25, waitMs))
  }
}

async function acquire(lane: Lane): Promise<void> {
  if (lane === 'keyless') return acquireKeyless()
  // Shared keyed bucket (price v3, swap /order): background lane never dips into the trade reserve.
  return throttleJupiterRps('background')
}

function availableLanes(now: number): Lane[] {
  const s = state()
  const lanes: Lane[] = []
  if (keylessEnabled() && s.cooldownUntil.keyless <= now) lanes.push('keyless')
  if (apiKey() && s.cooldownUntil.keyed <= now) lanes.push('keyed')
  return lanes
}

function openCooldown(lane: Lane, ms: number): void {
  const s = state()
  const was = s.cooldownUntil[lane] > Date.now()
  s.cooldownUntil[lane] = Math.max(s.cooldownUntil[lane], Date.now() + ms)
  s.counters.rateLimited[lane] += 1
  if (!was) {
    console.warn(`[jupiter-metadata] 429 on ${lane} api.jup.ag; standing down ${Math.ceil(ms / 1000)}s`)
  }
}

// ---------------------------------------------------------------------------------------------
// Upstream request
// ---------------------------------------------------------------------------------------------

async function requestOnce(lane: Lane, mints: string[]): Promise<Map<string, JupiterRawToken>> {
  const s = state()
  s.counters.requests[lane] += 1
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (lane === 'keyed') headers['x-api-key'] = apiKey()

  // One timer for the whole exchange: it must outlive `response.json()` or a stalled body hangs forever.
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(mints.join(','))}`, {
        signal: controller.signal,
        headers,
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new JupiterUnavailableError('timeout', 'Request timeout after 10 seconds')
      }
      throw new JupiterUnavailableError('network', `Network error: ${fetchError}`)
    }

    if (response.status === 429) {
      const cooldown = jupiterRateLimitCooldownMs({
        retryAfter: response.headers.get('retry-after'),
        reset: response.headers.get('x-ratelimit-reset'),
      })
      openCooldown(lane, cooldown)
      throw new JupiterUnavailableError(
        'rate_limited',
        `Rate limited by Jupiter (HTTP 429) on ${lane}; cooling down ${Math.ceil(cooldown / 1000)}s`,
        cooldown,
      )
    }
    if (response.status === 401 || response.status === 403) {
      if (lane === 'keyed') {
        openCooldown('keyed', 5 * 60_000)
        throw new JupiterUnavailableError('auth', `Jupiter rejected the API key (HTTP ${response.status})`, 5 * 60_000)
      }
      throw new JupiterUnavailableError('auth', `Jupiter refused keyless access (HTTP ${response.status})`)
    }
    if (response.status >= 500) {
      throw new JupiterUnavailableError('upstream_5xx', `Jupiter HTTP ${response.status}`)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    let body: unknown
    try {
      body = await response.json()
    } catch (bodyError) {
      if (bodyError instanceof Error && bodyError.name === 'AbortError') {
        throw new JupiterUnavailableError('timeout', 'Request timeout after 10 seconds')
      }
      throw new JupiterUnavailableError('upstream_5xx', 'Jupiter returned an unreadable body')
    }
    if (!Array.isArray(body)) throw new JupiterUnavailableError('upstream_5xx', 'Jupiter returned a non-array body')

    const found = new Map<string, JupiterRawToken>()
    for (const t of body) {
      if (t && typeof t === 'object' && typeof (t as JupiterRawToken).id === 'string') {
        found.set((t as JupiterRawToken).id as string, t as JupiterRawToken)
      }
    }
    return found
  } finally {
    clearTimeout(timeoutId)
  }
}

/** One lane, with a single jittered retry for transient failures (never for a 429). */
async function requestLane(lane: Lane, mints: string[]): Promise<Map<string, JupiterRawToken>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(lane, mints)
    } catch (e) {
      const transient =
        e instanceof JupiterUnavailableError &&
        (e.reason === 'timeout' || e.reason === 'network' || e.reason === 'upstream_5xx')
      if (!transient || attempt >= 1) throw e
      await sleep(jitteredRetryDelayMs(attempt))
      await acquire(lane)
    }
  }
}

async function fetchBatch(
  mints: string[],
  lanes: Lane[],
  firstLaneAcquired: boolean,
): Promise<Map<string, JupiterRawToken>> {
  let lastErr: unknown = null
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]
    if (i > 0) {
      if (state().cooldownUntil[lane] > Date.now()) continue
      await acquire(lane)
    } else if (!firstLaneAcquired) {
      await acquire(lane)
    }
    try {
      return await requestLane(lane, mints)
    } catch (e) {
      lastErr = e
      if (e instanceof JupiterUnavailableError) continue // fall through to the next lane
      throw e
    }
  }
  throw lastErr ?? new JupiterUnavailableError('rate_limited', 'Jupiter metadata has no usable lane')
}

// ---------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------

function enqueue(mint: string, priority: Priority): Promise<JupiterRawToken | null> {
  const s = state()
  const existing = s.pending.get(mint)
  if (existing) {
    if (priority === 'market') existing.priority = 'market'
    return existing.promise
  }
  let resolve!: (t: JupiterRawToken | null) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<JupiterRawToken | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  s.pending.set(mint, { mint, priority, enqueuedAt: Date.now(), inFlight: false, promise, resolve, reject })
  kick()
  return promise
}

function kick(): void {
  const s = state()
  if (s.flushing || s.kickTimer) return
  s.kickTimer = setTimeout(() => {
    s.kickTimer = null
    void flushLoop()
  }, BATCH_WINDOW_MS)
}

function settle(p: Pending, outcome: { token: JupiterRawToken | null } | { error: unknown }): void {
  state().pending.delete(p.mint)
  if ('error' in outcome) p.reject(outcome.error)
  else p.resolve(outcome.token)
}

function rejectWaiting(error: unknown): void {
  for (const p of [...state().pending.values()]) if (!p.inFlight) settle(p, { error })
}

function takeBatch(): Pending[] {
  const waiting = [...state().pending.values()].filter((p) => !p.inFlight)
  // market-data callers (sim opens, live mcap) go first; FIFO within a priority
  waiting.sort((a, b) => (a.priority === b.priority ? a.enqueuedAt - b.enqueuedAt : a.priority === 'market' ? -1 : 1))
  const batch = waiting.slice(0, MAX_BATCH)
  for (const p of batch) p.inFlight = true
  return batch
}

async function runOneBatch(): Promise<void> {
  const s = state()
  const now = Date.now()
  for (const p of [...s.pending.values()]) {
    if (!p.inFlight && now - p.enqueuedAt > QUEUE_MAX_WAIT_MS) {
      settle(p, { error: new JupiterUnavailableError('queue_timeout', 'Jupiter metadata queue wait exceeded 20s') })
    }
  }
  if ([...s.pending.values()].every((p) => p.inFlight)) return

  const lanes = availableLanes(now)
  if (lanes.length === 0) {
    const wait = jupiterMetadataCooldownRemainingMs(now)
    rejectWaiting(
      new JupiterUnavailableError(
        'rate_limited',
        `Rate limited: Jupiter metadata in 429 cooldown (${Math.ceil(wait / 1000)}s left)`,
        wait,
      ),
    )
    return
  }

  await acquire(lanes[0])
  const batch = takeBatch()
  if (batch.length === 0) return
  const mints = batch.map((p) => p.mint)
  s.counters.mintsRequested += mints.length
  try {
    const found = await fetchBatch(mints, lanes, true)
    const at = Date.now()
    for (const p of batch) {
      const token = found.get(p.mint) ?? null
      writeCache(p.mint, token, at)
      settle(p, { token })
    }
    persist(found)
  } catch (e) {
    s.counters.failures += 1
    for (const p of batch) settle(p, { error: e })
  }
  maybeLogStats()
}

async function flushLoop(): Promise<void> {
  const s = state()
  if (s.flushing) return
  s.flushing = true
  try {
    while (s.pending.size > 0) {
      try {
        await runOneBatch()
      } catch (e) {
        for (const p of [...s.pending.values()]) settle(p, { error: e })
      }
      // everything left is in flight elsewhere or empty -> stop; otherwise loop (gate paces us)
      if ([...s.pending.values()].every((p) => p.inFlight)) break
    }
  } finally {
    s.flushing = false
    if ([...s.pending.values()].some((p) => !p.inFlight)) kick()
  }
}

function persist(found: Map<string, JupiterRawToken>): void {
  const rows: Array<{ mint: string; meta: Record<string, unknown> }> = []
  for (const [mint, token] of found) {
    const meta = mapJupiterTokenToMetadata(token)
    if (typeof meta.symbol === 'string' && typeof meta.decimals === 'number') {
      rows.push({ mint, meta: meta as unknown as Record<string, unknown> })
    }
  }
  void saveJupiterMetaRows(rows).catch(() => {})
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

type LookupOpts = { maxAgeMs: number; priority: Priority }

/** One raw record. `null` = Jupiter answered and has no such token. Throws JupiterUnavailableError. */
async function lookupToken(mint: string, opts: LookupOpts): Promise<JupiterRawToken | null> {
  if (!isPlausibleMint(mint)) return null
  const hit = readCache(mint, opts.maxAgeMs, Date.now())
  if (hit.hit) {
    const c = state().counters
    if (hit.token === null) c.negativeHits += 1
    else c.l1Hits += 1
    return hit.token
  }
  return enqueue(mint, opts.priority)
}

export type JupiterMetadataLookup = {
  found: Record<string, JupiterTokenMetadata>
  notFound: string[]
  unavailable: Array<{ mint: string; error: JupiterUnavailableError }>
}

/**
 * Metadata for many mints: L1 -> L2 -> shared queue. `maxAgeMs` is how old an answer may be
 * (default 10 min; pass JUPITER_IMMUTABLE_MAX_AGE_MS when only symbol/decimals/logo matter).
 * Unavailable mints are served stale (<= 6h) when we have one, otherwise reported — never as "not found".
 */
export async function lookupJupiterMetadata(
  mints: string[],
  opts: { maxAgeMs?: number } = {},
): Promise<JupiterMetadataLookup> {
  const maxAgeMs = opts.maxAgeMs ?? JUPITER_META_MAX_AGE_MS
  const result: JupiterMetadataLookup = { found: {}, notFound: [], unavailable: [] }
  const counters = state().counters
  const now = Date.now()
  const unique = Array.from(new Set(mints.filter((m) => typeof m === 'string' && m.length > 0)))

  let remaining: string[] = []
  for (const mint of unique) {
    if (!isPlausibleMint(mint)) {
      result.notFound.push(mint)
      continue
    }
    const hit = readCache(mint, maxAgeMs, now)
    if (hit.hit && hit.token) {
      counters.l1Hits += 1
      result.found[mint] = mapJupiterTokenToMetadata(hit.token)
    } else if (hit.hit) {
      counters.negativeHits += 1
      result.notFound.push(mint)
    } else {
      remaining.push(mint)
    }
  }

  // L2: persisted rows (also the source of stale-on-error answers)
  const l2 = new Map<string, { meta: Record<string, unknown>; fetchedAtMs: number }>()
  if (remaining.length > 0) {
    const rows = await loadJupiterMetaRows(remaining, now - Math.max(maxAgeMs, JUPITER_STALE_ON_ERROR_MS))
    for (const [mint, row] of rows) l2.set(mint, row)
    const stillMissing: string[] = []
    for (const mint of remaining) {
      const row = l2.get(mint)
      if (row && now - row.fetchedAtMs <= maxAgeMs) {
        counters.l2Hits += 1
        result.found[mint] = row.meta as unknown as JupiterTokenMetadata
      } else {
        stillMissing.push(mint)
      }
    }
    remaining = stillMissing
  }

  if (remaining.length > 0) {
    const settled = await Promise.allSettled(
      remaining.map((mint) => lookupToken(mint, { maxAgeMs, priority: 'meta' })),
    )
    settled.forEach((r, i) => {
      const mint = remaining[i]
      if (r.status === 'fulfilled') {
        if (r.value) result.found[mint] = mapJupiterTokenToMetadata(r.value)
        else result.notFound.push(mint)
        return
      }
      const err = r.reason
      if (!(err instanceof JupiterUnavailableError)) throw err
      const staleL1 = readStale(mint, Date.now())
      const staleL2 = l2.get(mint)
      if (staleL1) {
        counters.staleServed += 1
        result.found[mint] = mapJupiterTokenToMetadata(staleL1)
      } else if (staleL2) {
        counters.staleServed += 1
        result.found[mint] = staleL2.meta as unknown as JupiterTokenMetadata
      } else {
        result.unavailable.push({ mint, error: err })
      }
    })
  }
  return result
}

/** Batch metadata keyed by mint. Throws JupiterUnavailableError if any mint could not be resolved. */
export async function fetchTokensFromJupiterV2(
  mintAddresses: string[],
  _retryCount = 0,
): Promise<Record<string, any>> {
  void _retryCount
  if (mintAddresses.length === 0) return {}
  const res = await lookupJupiterMetadata(mintAddresses)
  if (res.unavailable.length > 0) throw res.unavailable[0].error
  return res.found
}

/**
 * Metadata for one mint. Throws `JupiterTokenNotFoundError` when Jupiter has no such token and
 * `JupiterUnavailableError` when Jupiter could not be asked — callers must not conflate the two.
 */
export async function fetchTokenMetadataFromJupiter(
  mintAddress: string,
  opts: number | { maxAgeMs?: number } = {},
): Promise<any> {
  const maxAgeMs = typeof opts === 'object' ? opts.maxAgeMs : undefined
  const res = await lookupJupiterMetadata([mintAddress], { maxAgeMs })
  if (res.unavailable.length > 0) throw res.unavailable[0].error
  const data = res.found[mintAddress]
  if (!data) throw new JupiterTokenNotFoundError(mintAddress)
  return data
}

export type JupiterVolumeWindow = '5m' | '1h' | '6h' | '24h'

export type JupiterMarketHints = {
  usdPrice: number | null
  volume5m: number | null
  mcap: number | null
  /** Which Jupiter stats window supplied volume5m (may be longer than 5m). */
  volumeWindow: JupiterVolumeWindow | null
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function volumeFromStats(stats: Record<string, unknown> | null): number | null {
  if (!stats) return null
  const buy = finiteOrNull(stats.buyVolume)
  const sell = finiteOrNull(stats.sellVolume)
  if (buy == null && sell == null) return null
  return (buy ?? 0) + (sell ?? 0)
}

/**
 * Parse usdPrice + volume + mcap from lite-api v2 search JSON.
 * Volume waterfall: stats5m → stats1h → stats6h → stats24h (buy+sell).
 */
export function parseJupiterV2MarketHints(
  raw: unknown,
  mintAddress?: string,
): JupiterMarketHints | null {
  let token: Record<string, unknown> | null = null

  if (Array.isArray(raw)) {
    const match = mintAddress
      ? raw.find(
          (t) =>
            t &&
            typeof t === 'object' &&
            (t as { id?: string }).id === mintAddress,
        )
      : raw[0]
    token =
      match && typeof match === 'object'
        ? (match as Record<string, unknown>)
        : null
  } else if (raw && typeof raw === 'object') {
    token = raw as Record<string, unknown>
  }

  if (!token) return null

  const usdPrice = finiteOrNull(token.usdPrice)
  const mcap = finiteOrNull(token.mcap) ?? finiteOrNull(token.fdv)

  const windows: { key: JupiterVolumeWindow; field: string }[] = [
    { key: '5m', field: 'stats5m' },
    { key: '1h', field: 'stats1h' },
    { key: '6h', field: 'stats6h' },
    { key: '24h', field: 'stats24h' },
  ]

  let volume5m: number | null = null
  let volumeWindow: JupiterVolumeWindow | null = null
  for (const w of windows) {
    const stats =
      token[w.field] && typeof token[w.field] === 'object'
        ? (token[w.field] as Record<string, unknown>)
        : null
    const vol = volumeFromStats(stats)
    if (vol != null) {
      volume5m = vol
      volumeWindow = w.key
      break
    }
  }

  if (usdPrice == null && volume5m == null && mcap == null) return null

  return { usdPrice, volume5m, mcap, volumeWindow }
}

/**
 * Price + 5m volume + mcap for monitor/entry enrichment. Shares the metadata cache/queue (a record
 * fetched for risk assessment a few seconds ago serves this too) but only accepts a <=10s-old record.
 * `null` covers both "no data" and "Jupiter unavailable"; use `fetchJupiterV2SearchRaw` /
 * `isJupiterUnavailable` where the difference matters.
 */
export async function fetchJupiterMarketHints(
  mintAddress: string,
): Promise<JupiterMarketHints | null> {
  try {
    const token = await lookupToken(mintAddress, {
      maxAgeMs: JUPITER_MARKET_MAX_AGE_MS,
      priority: 'market',
    })
    return token ? parseJupiterV2MarketHints([token], mintAddress) : null
  } catch {
    return null
  }
}

/**
 * Raw v2 search record(s) for a single mint: `[token]`, or `[]` when Jupiter has no such token.
 * Throws `JupiterUnavailableError` when Jupiter could not be asked. `maxAgeMs` defaults to the
 * market freshness; creator/identity readers pass a longer one.
 */
export async function fetchJupiterV2SearchRaw(
  mintAddress: string,
  opts: number | { maxAgeMs?: number } = {},
): Promise<unknown> {
  const maxAgeMs =
    typeof opts === 'object' && opts.maxAgeMs != null ? opts.maxAgeMs : JUPITER_MARKET_MAX_AGE_MS
  const token = await lookupToken(mintAddress, { maxAgeMs, priority: 'meta' })
  return token ? [token] : []
}

/** datapi.jup.ag assets search — raw JSON for token locate. */
export async function fetchJupiterDatapiSearchRaw(mintAddress: string): Promise<unknown> {
  const response = await fetch(
    `https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(mintAddress)}`,
    {
      headers: {
        accept: 'application/json',
        referer: 'https://jup.ag/',
        'user-agent': 'ReloadSol-API/1.0',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`datapi HTTP ${response.status}`)
  }
  return response.json()
}
