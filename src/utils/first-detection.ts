import { query } from '@/utils/db'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { normalizeLookupAddress } from '@/strategies/token-locate'

export type FirstDetection = {
  firstSeenAt: string
  firstMcap: number | null
}

function toIso(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString()
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

function toMcap(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Bulk first-sighting from token_mcap_tracking (our ingest, not pool create). */
export async function lookupFirstDetections(
  addresses: string[],
  chain?: GmgnTradeChain,
): Promise<Map<string, FirstDetection>> {
  const keys = [
    ...new Set(
      addresses.map((a) => normalizeLookupAddress(a.trim())).filter(Boolean),
    ),
  ]
  const out = new Map<string, FirstDetection>()
  if (keys.length === 0) return out

  try {
    const { rows } = await query<{
      token_address: string
      first_seen_at: unknown
      first_mcap: unknown
    }>(
      chain
        ? `SELECT token_address, first_seen_at, first_mcap
           FROM token_mcap_tracking
           WHERE chain = $1 AND lower(token_address) = ANY($2::text[])`
        : `SELECT token_address, first_seen_at, first_mcap
           FROM token_mcap_tracking
           WHERE lower(token_address) = ANY($1::text[])`,
      chain
        ? [chain, keys.map((k) => k.toLowerCase())]
        : [keys.map((k) => k.toLowerCase())],
    )
    for (const row of rows) {
      const seen = toIso(row.first_seen_at)
      if (!seen) continue
      out.set(normalizeLookupAddress(row.token_address).toLowerCase(), {
        firstSeenAt: seen,
        firstMcap: toMcap(row.first_mcap),
      })
    }
  } catch {
    /* table missing / db down — UI just omits the line */
  }
  return out
}

export function mergeFirstDetection<T extends { address?: string; token_address?: string }>(
  token: T,
  map: Map<string, FirstDetection>,
): T & { first_seen_at?: string; first_mcap?: number } {
  const raw = token.address ?? token.token_address ?? ''
  const hit = map.get(normalizeLookupAddress(raw).toLowerCase())
  if (!hit) return token
  return {
    ...token,
    first_seen_at: hit.firstSeenAt,
    ...(hit.firstMcap != null ? { first_mcap: hit.firstMcap } : {}),
  }
}

export async function attachFirstDetections<
  T extends { address?: string; token_address?: string },
>(tokens: T[], chain?: GmgnTradeChain): Promise<(T & { first_seen_at?: string; first_mcap?: number })[]> {
  const map = await lookupFirstDetections(
    tokens.map((t) => t.address ?? t.token_address ?? ''),
    chain,
  )
  return tokens.map((t) => mergeFirstDetection(t, map))
}
