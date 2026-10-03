/**
 * Dev-reputation data plumbing: resolve the creator address (GMGN info first, then
 * Jupiter), fetch GMGN created_tokens, score it, cache by creator.
 *
 * Env: DEV_REPUTATION_ENABLED (kill switch), DEV_REPUTATION_MODE=shadow|enforce,
 * DEV_REPUTATION_TTL_S. Best-effort callers must catch — a rate limit or network
 * failure returns `null` and never blocks a tick.
 */

import { createdTokens, GmgnApiError } from '@/utils/gmgn-api'
import { JUPITER_IMMUTABLE_MAX_AGE_MS, fetchJupiterV2SearchRaw } from '@/utils/jupiter-metadata'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import {
  scoreDevReputation,
  topDevTokens,
  type DevReputation,
} from '@/strategies/dev-reputation'

export type DevReputationMode = 'shadow' | 'enforce'

const DEFAULT_TTL_S = 86_400
/** After a GMGN rate limit, pause dev lookups briefly (not minutes — GMGN 429s
 * are intermittent, and a long window starves the dev half while RugCheck keeps
 * writing rows). */
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000

let gmgnRateLimitedUntil = 0

function envFlag(key: string, fallback = false): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === '1' || v === 'true'
}

function toNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function isDevReputationEnabled(): boolean {
  return envFlag('DEV_REPUTATION_ENABLED', false)
}

/** Kill switch forces shadow; `off`/`0` never happens here (use the enabled flag). */
export function devReputationMode(): DevReputationMode {
  if (envFlag('DEV_REPUTATION_KILL_SWITCH', false)) return 'shadow'
  return process.env.DEV_REPUTATION_MODE?.trim().toLowerCase() === 'enforce'
    ? 'enforce'
    : 'shadow'
}

/**
 * Creator address, in preference order:
 *   1. the GMGN token info we already have (free),
 *   2. RugCheck's `creator` (free, already fetched for the same token),
 *   3. Jupiter `dev` (last resort — rate-limited).
 */
export async function resolveCreatorAddress(params: {
  chain: string
  info: Record<string, unknown>
  mint: string
  rugcheckCreator?: string | null
}): Promise<string | null> {
  const dev = params.info?.dev
  if (dev && typeof dev === 'object') {
    const addr = (dev as Record<string, unknown>).creator_address
    if (typeof addr === 'string' && addr.trim()) return addr.trim()
  }

  const fromRugcheck = params.rugcheckCreator?.trim()
  if (fromRugcheck) return fromRugcheck

  if (params.chain !== 'sol') return null

  try {
    // a mint's creator never changes: a cached record of any age answers this
    const raw = await fetchJupiterV2SearchRaw(params.mint, { maxAgeMs: JUPITER_IMMUTABLE_MAX_AGE_MS })
    const arr = Array.isArray(raw) ? raw : [raw]
    const token =
      arr.find(
        (t) =>
          t &&
          typeof t === 'object' &&
          (t as { id?: string }).id === params.mint,
      ) ?? arr[0]
    const d = (token as { dev?: unknown } | undefined)?.dev
    if (typeof d === 'string' && d.trim()) return d.trim()
    if (d && typeof d === 'object') {
      const addr = (d as { address?: unknown }).address
      if (typeof addr === 'string' && addr.trim()) return addr.trim()
    }
  } catch {
    // fall through — no creator known
  }
  return null
}

/** Cached, scored dev reputation. Returns `null` when GMGN is unavailable. */
export async function fetchDevReputation(params: {
  chain: string
  creator: string
  mintedCount?: number | null
}): Promise<DevReputation | null> {
  const creator = params.creator.trim()
  if (!creator) return null

  const key = `devrep:${params.chain}:${creator.toLowerCase()}`
  const cached = await cacheGet<DevReputation>(key)
  if (cached && typeof cached === 'object' && 'verdict' in cached) return cached

  // GMGN is rate-limited: skip (the token still gets a RugCheck-only row) so we
  // do not burn the shared gate or extend the ban.
  if (Date.now() < gmgnRateLimitedUntil) return null

  let data: Awaited<ReturnType<typeof createdTokens>>
  try {
    data = await createdTokens({ chain: params.chain, wallet: creator })
  } catch (error) {
    if (error instanceof GmgnApiError && error.code === 'RATE_LIMIT') {
      gmgnRateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    }
    return null
  }

  const rep: DevReputation = {
    ...scoreDevReputation({
      innerCount: toNum(data.inner_count) ?? 0,
      openCount: toNum(data.open_count) ?? 0,
      athMc: toNum(data.creator_ath_info?.ath_mc),
      mintedCount: params.mintedCount ?? null,
      tokenAthMcs: (data.tokens ?? []).map((t) => toNum(t.token_ath_mc)),
    }),
    // Top 10 by ATH — persisted with the row so the UI needs no GMGN call.
    tokens: topDevTokens(
      (data.tokens ?? []) as Array<Record<string, unknown>>,
      10,
    ),
  }

  const ttl = Number(process.env.DEV_REPUTATION_TTL_S)
  void cacheSet(key, rep, Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_S)
  return rep
}
