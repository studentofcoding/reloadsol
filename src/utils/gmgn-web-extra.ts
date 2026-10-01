/**
 * GMGN internal web endpoints — the extra ones (candles, batch safety, token stat).
 *
 * Evidence (live, 2026-09-30): gmgn.ai blocks every path with Cloudflare 403 to any
 * non-browser client, from this machine and from the VPS. A real Chrome passes, and
 * the token page fires ~31 internal APIs. Through **our `gmgn-web-proxy` Cloudflare
 * Worker** (allow-list `/mrwapi/`, `/api/v1/`, `/vas/api/`) these three work
 * **server-side with no browser** — verified 200:
 *
 *   GET  /api/v1/token_mcap_candles/sol/{mint}?resolution=1m|5m|1h   → OHLCV candles
 *   POST /api/v1/meme_quote_info   {chain, addresses[]}            → liquidity, is_honeypot, is_safe
 *   GET  /api/v1/token_stat/sol/{mint}                             → rat/bundler/entrapment/… %
 *
 * `POST /vas/api/v1/batch_handler` answers `403 Endpoint not allowed` for us (browser-only),
 * and `/defi/...` + `/pf/...` are not on the Worker allow-list.
 *
 * Posture: unofficial + Cloudflare-tunnelled, so every call is **fail-soft** (null/[]),
 * honours a negative cooldown, and paces on one of two lanes (live at `GMGN_WEB_MAX_POST_PER_SEC`,
 * bulk copy at `METRICS_COPY_RPS`) that share a single 403/429 park. Never the critical path.
 * See docs/GMGN_INTERNAL_API.md and docs/GMGN_RATE_BUDGET.md.
 */

import { chunkGmgnWebAddresses, gmgnWebMinIntervalMs } from '@/utils/gmgn-web-multi'

const DEFAULT_HOST = 'https://gmgn.ai'
const TIMEOUT_MS = 12_000
/** A 403/429 parks every extra call for this long. */
const NEGATIVE_COOLDOWN_MS = 60_000
/**
 * Bulk copy lane (the metrics copier) — paced deliberately low.
 *
 * The earlier "48 rps = 80% of the measured ceiling" came from probing `token_stat` (~600 B) and
 * was then applied to **candles** (~18 KB, ~90x the payload). A real sweep at 8 rps (~240 calls in
 * ~30 s) tripped a 429 on the *whole* Worker path — so the limit looks tunnel-wide, shared with the
 * live chart/risk lanes. Re-measured on the candle endpoint: 96 requests / 2.6 MB clean at ~1.1 rps
 * sustained. Default 2, with margin, on its own lane; `GMGN_WEB_MAX_POST_PER_SEC` is untouched.
 * See docs/GMGN_RATE_BUDGET.md.
 */
const DEFAULT_COPY_RPS = 2
const MAX_COPY_RPS = 100
/** The upstream accepts 501 bars of the requested resolution per call. */
const CANDLE_LIMIT_MAX = 501
/** Cloudflare's challenge is transient and per-request — retry it instead of parking. */
const CHALLENGE_RETRIES = 2
const CHALLENGE_BACKOFF_MS = 400
/** The bulk copy lane's own endpoints. A park on any other endpoint must not cancel its sweep. */
const COPY_LANE_ENDPOINTS = ['token_mcap_candles', 'meme_quote_info']

/**
 * Two independent pacing lanes, one park **per endpoint**.
 *
 * The live lane paces at `GMGN_WEB_MAX_POST_PER_SEC` and serves charts + risk chips; the copy
 * lane paces at `METRICS_COPY_RPS` and serves the metrics copier. Separate lanes mean a bulk
 * sweep runs at full budget without speeding up — or being slowed by — the live path.
 *
 * The park used to be one global flag. That cost the copier whole sweeps: observed live, a
 * `token_mcap_candles` sweep fetched **240/240 cleanly** in the same window that
 * `mutil_window_token_info` was being challenged, and the copier still reported `fetched 0`
 * because the unrelated 429 had armed the shared flag. `gmgn-web-multi.ts` already keys its
 * cooldown by pathname for exactly this reason, so this mirrors that shape.
 */
type Lane = { chain: Promise<void>; lastAt: number }
const liveGate: Lane = { chain: Promise.resolve(), lastAt: 0 }
const copyGate: Lane = { chain: Promise.resolve(), lastAt: 0 }
/** Parked-until per endpoint key. See `gmgnWebEndpointKey`. */
const parkedUntil = new Map<string, number>()
/** Adverse upstream events (403/429, including challenges) since the last `takeGmgnWebBlockCount()`. */
let blockCount = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function webHost(): string {
  return (process.env.GMGN_WEB_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '')
}

function webHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://gmgn.ai',
    Referer: 'https://gmgn.ai/',
  }
  const secret = process.env.GMGN_WEB_PROXY_SECRET?.trim()
  if (secret) headers['X-Gmgn-Proxy-Secret'] = secret
  return headers
}

/** /1000 rps → ms spacing. A nonsense value falls back to the live pace rather than hammering. */
function minIntervalFor(rps: number | null | undefined): number {
  if (rps == null || !Number.isFinite(rps) || rps <= 0) return gmgnWebMinIntervalMs()
  return Math.ceil(1000 / Math.min(rps, MAX_COPY_RPS))
}

/** Serial min-interval on one lane, so that lane cannot burst past its own budget. */
function paceWait(lane: Lane, rps?: number | null): Promise<void> {
  const minIntervalMs = minIntervalFor(rps)
  const next = lane.chain.then(async () => {
    const wait = Math.max(0, lane.lastAt + minIntervalMs - Date.now())
    if (wait > 0) await sleep(wait)
    lane.lastAt = Date.now()
  })
  lane.chain = next.catch(() => undefined)
  return next
}

/** Copy-lane pace from env (default 48 = 80% of the measured clean ceiling). */
export function gmgnWebCopyRps(): number {
  const raw = Number(process.env.METRICS_COPY_RPS ?? DEFAULT_COPY_RPS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_COPY_RPS
  return Math.min(raw, MAX_COPY_RPS)
}

/**
 * Endpoint identity for parking: the route, without the mint or the query string.
 * `/api/v1/token_mcap_candles/sol/<mint>?resolution=1m` → `token_mcap_candles`.
 */
export function gmgnWebEndpointKey(path: string): string {
  const noQuery = path.split('?')[0]
  const match = noQuery.match(/^\/(?:api\/v1|mrwapi\/v1|vas\/api)\/([^/]+)/)
  return match ? match[1] : noQuery
}

function isParked(endpoint: string): boolean {
  return Date.now() < (parkedUntil.get(endpoint) ?? 0)
}

function isAnyParked(): boolean {
  const now = Date.now()
  for (const until of parkedUntil.values()) if (now < until) return true
  return false
}

/** True while a 403/429 park is active on **any** endpoint — the conservative question. */
export function gmgnWebIsBlocked(): boolean {
  return isAnyParked()
}

/**
 * True while the bulk copy lane's **own** endpoints are parked.
 *
 * The copier asks this rather than `gmgnWebIsBlocked()`: because the park is keyed per endpoint,
 * a challenge or rate limit on the snapshot endpoint can no longer discard a whole candle sweep.
 */
export function gmgnWebCopyLaneBlocked(): boolean {
  return COPY_LANE_ENDPOINTS.some((endpoint) => isParked(endpoint))
}

/** Read-and-reset the 403/429 count, for the copier's coverage line. */
export function takeGmgnWebBlockCount(): number {
  const n = blockCount
  blockCount = 0
  return n
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * These endpoints are Cloudflare-403 unless tunnelled. Without `GMGN_WEB_HOST`
 * the request would only burn a call and arm the cooldown, so stay inert.
 */
export function gmgnWebExtrasConfigured(): boolean {
  return Boolean(process.env.GMGN_WEB_HOST?.trim())
}

/** GMGN rates are 0–1 (some already percent) — same rule as gmgn-token-snapshot. */
function asPercent(rate: number | null): number | null {
  if (rate == null) return null
  return rate > 1 && rate <= 100 ? rate : rate * 100
}

/**
 * Is this 403/429 a Cloudflare **managed challenge** rather than a rate limit?
 *
 * Cloudflare answers with an HTML interstitial (`Just a moment…`), so the content type is the
 * cheap discriminator and the body is sniffed only when the header is absent or unhelpful. The
 * distinction matters operationally: a rate limit means "stop and wait", a challenge means
 * "this request lost a coin toss" — retrying helps, and a 60 s park just discards the pass.
 */
async function isChallengeResponse(res: Response): Promise<boolean> {
  const type = res.headers?.get?.('content-type')?.toLowerCase() ?? ''
  if (type.includes('json')) return false
  if (type.includes('html')) return true
  try {
    const text = (await res.text()).slice(0, 512).toLowerCase()
    return (
      text.includes('just a moment') ||
      text.includes('cf-chl') ||
      text.includes('<!doctype html')
    )
  } catch {
    return false
  }
}

async function callJson(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts?: { rps?: number | null },
): Promise<Record<string, unknown> | null> {
  const endpoint = gmgnWebEndpointKey(path)
  if (isParked(endpoint)) return null
  if (!gmgnWebExtrasConfigured()) return null
  const onCopyLane = opts?.rps != null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    for (let attempt = 0; ; attempt++) {
      await paceWait(onCopyLane ? copyGate : liveGate, opts?.rps)
      const res = await fetch(`${webHost()}${path}`, {
        method,
        headers: webHeaders(),
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (res.status === 403 || res.status === 429) {
        blockCount++
        if (await isChallengeResponse(res)) {
          // Transient and per-request: retry, but never park the endpoint for it.
          if (attempt < CHALLENGE_RETRIES) {
            await sleep(CHALLENGE_BACKOFF_MS * (attempt + 1))
            continue
          }
          return null
        }
        parkedUntil.set(endpoint, Date.now() + NEGATIVE_COOLDOWN_MS)
        return null
      }
      if (!res.ok) return null
      const json = (await res.json()) as unknown
      if (!isRecord(json)) return null
      if (json.code !== 0 && json.code !== '0') return null
      return json
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type GmgnWebCandle = {
  /** seconds (the app sends ms; normalised here) */
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

/** Resolutions the endpoint accepts (verified live). */
const SUPPORTED_RESOLUTIONS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
/** Window-derived values that are NOT supported → nearest supported bar. */
const RESOLUTION_ALIASES: Record<string, string> = {
  '2h': '1h',
  '3h': '1h',
  '6h': '1h',
  '8h': '4h',
  '12h': '4h',
  '24h': '1d',
  '48h': '1d',
  '7d': '1d',
  '1w': '1d',
}

/** Map a requested resolution to one the endpoint accepts, or null to skip. */
export function normalizeGmgnWebResolution(resolution: string): string | null {
  const r = resolution.trim().toLowerCase()
  if (SUPPORTED_RESOLUTIONS.has(r)) return r
  return RESOLUTION_ALIASES[r] ?? null
}

/** OHLCV candles. `resolution` is required by the upstream (1m / 5m / 1h / 4h / 1d / …). */
export async function fetchGmgnWebCandles(
  mint: string,
  resolution: string,
): Promise<GmgnWebCandle[] | null> {
  return fetchCandles(mint, resolution)
}

/**
 * Same endpoint on the bulk copy lane, with an explicit bar count.
 *
 * One call returns up to `limit` bars of `resolution` — so at 1m/501 a single call covers
 * ~8.35 h of minutes. The metrics copier relies on that: slot completeness comes from the
 * series, not from the sweep cadence (which only governs snapshot freshness). The cadence
 * must stay below `limit x resolution`, or the gap leaves minutes the vendor will never
 * re-serve — see `assertCadenceCoversWindow`.
 */
export async function fetchGmgnWebCandlesPaced(
  mint: string,
  opts: { resolution: string; limit?: number; rps?: number | null },
): Promise<GmgnWebCandle[] | null> {
  return fetchCandles(mint, opts.resolution, { limit: opts.limit, rps: opts.rps })
}

async function fetchCandles(
  mint: string,
  resolution: string,
  opts?: { limit?: number; rps?: number | null },
): Promise<GmgnWebCandle[] | null> {
  const address = mint.trim()
  const res = normalizeGmgnWebResolution(resolution)
  if (!address || !res) return null
  const limit =
    opts?.limit != null && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), CANDLE_LIMIT_MAX)
      : null
  const query = `resolution=${encodeURIComponent(res)}${limit != null ? `&limit=${limit}` : ''}`
  const json = await callJson(
    'GET',
    `/api/v1/token_mcap_candles/sol/${encodeURIComponent(address)}?${query}`,
    undefined,
    { rps: opts?.rps },
  )
  if (!json || !isRecord(json.data)) return null
  const list = json.data.list
  if (!Array.isArray(list)) return null
  const out: GmgnWebCandle[] = []
  for (const row of list) {
    if (!isRecord(row)) continue
    const rawT = num(row.time)
    const o = num(row.open)
    const h = num(row.high)
    const l = num(row.low)
    const c = num(row.close)
    if (rawT == null || o == null || h == null || l == null || c == null) continue
    const v = num(row.volume)
    out.push({
      t: rawT > 1e12 ? Math.floor(rawT / 1000) : Math.floor(rawT),
      o,
      h,
      l,
      c,
      ...(v != null ? { v } : {}),
    })
  }
  return out.length > 0 ? out : null
}

export type GmgnWebSafety = {
  address: string
  liquidityUsd: number | null
  isHoneypot: boolean | null
  isSafe: boolean | null
}

function yesNo(value: unknown): boolean | null {
  if (value === 'yes' || value === true || value === 1) return true
  if (value === 'no' || value === false || value === 0) return false
  return null
}

/**
 * Batch safety (`meme_quote_info`) — up to the shared web batch size per call.
 *
 * `rps` puts the call on the bulk copy lane instead of the live one, so a sweep that needs
 * liquidity for the whole watch set cannot pace the chart/risk lane.
 */
export async function fetchGmgnWebSafety(
  mints: string[],
  opts?: { rps?: number | null },
): Promise<GmgnWebSafety[]> {
  const unique = [...new Set(mints.map((m) => m.trim()).filter(Boolean))]
  if (unique.length === 0) return []
  const out: GmgnWebSafety[] = []
  for (const batch of chunkGmgnWebAddresses(unique)) {
    const json = await callJson(
      'POST',
      '/api/v1/meme_quote_info',
      {
        chain: 'sol',
        addresses: batch,
      },
      { rps: opts?.rps },
    )
    if (!json || !isRecord(json.data)) continue
    const list = json.data.list
    if (!Array.isArray(list)) continue
    for (const row of list) {
      if (!isRecord(row)) continue
      const address = typeof row.token_address === 'string' ? row.token_address : null
      if (!address) continue
      out.push({
        address,
        liquidityUsd: num(row.liquidity),
        isHoneypot: yesNo(row.is_honeypot),
        isSafe: yesNo(row.is_safe),
      })
    }
  }
  return out
}

export type GmgnWebStat = {
  bundlerPct: number | null
  ratPct: number | null
  entrapmentPct: number | null
  botDegenPct: number | null
  privateVaultPct: number | null
  top10Pct: number | null
  /** Creator's lifetime token count (GMGN's own aggregate). */
  creatorCreatedCount: number | null
}

/** Per-token risk percentages (`token_stat`). */
export async function fetchGmgnWebTokenStat(mint: string): Promise<GmgnWebStat | null> {
  const address = mint.trim()
  if (!address) return null
  const json = await callJson('GET', `/api/v1/token_stat/sol/${encodeURIComponent(address)}`)
  if (!json || !isRecord(json.data)) return null
  const d = json.data
  return {
    bundlerPct: asPercent(num(d.top_bundler_trader_percentage)),
    ratPct: asPercent(num(d.top_rat_trader_percentage)),
    entrapmentPct: asPercent(num(d.top_entrapment_trader_percentage)),
    botDegenPct: asPercent(num(d.top_bot_degen_percentage)),
    privateVaultPct: asPercent(num(d.private_vault_hold_rate)),
    top10Pct: asPercent(num(d.top_10_holder_rate)),
    creatorCreatedCount: num(d.creator_created_count),
  }
}

/** Test-only: clear the negative cooldown and both lanes. */
export function __resetGmgnWebExtraForTests(): void {
  parkedUntil.clear()
  blockCount = 0
  liveGate.lastAt = 0
  copyGate.lastAt = 0
}
