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
 * honours a negative cooldown, and shares the existing GMGN web rate gate. Never the
 * critical path. See docs/GMGN_INTERNAL_API.md.
 */

import { chunkGmgnWebAddresses, gmgnWebMinIntervalMs } from '@/utils/gmgn-web-multi'

const DEFAULT_HOST = 'https://gmgn.ai'
const TIMEOUT_MS = 12_000
/** A 403/429 parks every extra call for this long. */
const NEGATIVE_COOLDOWN_MS = 60_000

const gate: { chain: Promise<void>; lastAt: number } = {
  chain: Promise.resolve(),
  lastAt: 0,
}
let blockedUntil = 0

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

/** Same serial min-interval as the token-info client, so extras cannot burst past it. */
function gateWait(): Promise<void> {
  const minIntervalMs = gmgnWebMinIntervalMs()
  const next = gate.chain.then(async () => {
    const wait = Math.max(0, gate.lastAt + minIntervalMs - Date.now())
    if (wait > 0) await sleep(wait)
    gate.lastAt = Date.now()
  })
  gate.chain = next.catch(() => undefined)
  return next
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

async function callJson(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  if (Date.now() < blockedUntil) return null
  if (!gmgnWebExtrasConfigured()) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    await gateWait()
    const res = await fetch(`${webHost()}${path}`, {
      method,
      headers: webHeaders(),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (res.status === 403 || res.status === 429) {
      blockedUntil = Date.now() + NEGATIVE_COOLDOWN_MS
      return null
    }
    if (!res.ok) return null
    const json = (await res.json()) as unknown
    if (!isRecord(json)) return null
    if (json.code !== 0 && json.code !== '0') return null
    return json
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

/** OHLCV candles. `resolution` is required by the upstream (1m / 5m / 1h / …). */
export async function fetchGmgnWebCandles(
  mint: string,
  resolution: string,
): Promise<GmgnWebCandle[] | null> {
  const address = mint.trim()
  if (!address || !resolution.trim()) return null
  const json = await callJson(
    'GET',
    `/api/v1/token_mcap_candles/sol/${encodeURIComponent(address)}?resolution=${encodeURIComponent(resolution)}`,
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

/** Batch safety (`meme_quote_info`) — up to the shared web batch size per call. */
export async function fetchGmgnWebSafety(mints: string[]): Promise<GmgnWebSafety[]> {
  const unique = [...new Set(mints.map((m) => m.trim()).filter(Boolean))]
  if (unique.length === 0) return []
  const out: GmgnWebSafety[] = []
  for (const batch of chunkGmgnWebAddresses(unique)) {
    const json = await callJson('POST', '/api/v1/meme_quote_info', {
      chain: 'sol',
      addresses: batch,
    })
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

/** Test-only: clear the negative cooldown. */
export function __resetGmgnWebExtraForTests(): void {
  blockedUntil = 0
  gate.lastAt = 0
}
