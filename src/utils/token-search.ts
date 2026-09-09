import { query } from '@/utils/db'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  normalizeGmgnSearchToken,
  searchTokensForChain,
} from '@/utils/gmgn-api'

export type UniversalSearchToken = NonNullable<
  ReturnType<typeof normalizeGmgnSearchToken>
> & { chain: GmgnTradeChain }

const CHAINS: GmgnTradeChain[] = ['sol', 'robinhood']

function likeSafe(raw: string): string {
  return raw.replace(/[%_\\]/g, '').trim()
}

function toSearchToken(
  row: {
    token_address: string
    token_symbol: string | null
    current_mcap?: unknown
    chain: string
  },
): UniversalSearchToken | null {
  const chain: GmgnTradeChain =
    row.chain === 'robinhood' ? 'robinhood' : 'sol'
  const base = normalizeGmgnSearchToken({
    address: row.token_address,
    symbol: row.token_symbol,
    name: row.token_symbol,
    mcap: row.current_mcap,
  })
  return base ? { ...base, chain } : null
}

async function searchTrackedTokens(
  needle: string,
  limit: number,
  preferChain: GmgnTradeChain,
): Promise<UniversalSearchToken[]> {
  const q = likeSafe(needle).toLowerCase()
  if (q.length < 2) return []
  const like = `%${q}%`
  // token_mcap_tracking is the symbol/CA source of truth for tracked tokens.
  // (strategy_outcomes used to be scanned via features->>'token_symbol', which
  // forced a wide-row seq scan per keystroke; symbols resolve here instead.)
  const mcap = await query<{
    token_address: string
    token_symbol: string | null
    current_mcap: unknown
    chain: string
  }>(
    `SELECT token_address, token_symbol, current_mcap, chain
     FROM token_mcap_tracking
     WHERE lower(coalesce(token_symbol, '')) LIKE $1
        OR lower(token_address) LIKE $1
     ORDER BY CASE WHEN chain = $2 THEN 0 ELSE 1 END,
              last_updated_at DESC NULLS LAST
     LIMIT $3`,
    [like, preferChain, limit],
  ).catch(() => ({
    rows: [] as Array<{
      token_address: string
      token_symbol: string | null
      current_mcap: unknown
      chain: string
    }>,
  }))
  return mcap.rows
    .map((r) => toSearchToken(r))
    .filter((t): t is UniversalSearchToken => t != null)
}

export function mergeSearchResults(
  primary: UniversalSearchToken[],
  extra: UniversalSearchToken[],
  limit: number,
): UniversalSearchToken[] {
  const out: UniversalSearchToken[] = []
  const seen = new Set<string>()
  for (const t of [...primary, ...extra]) {
    const key = t.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

function withChain(
  tokens: NonNullable<ReturnType<typeof normalizeGmgnSearchToken>>[],
  chain: GmgnTradeChain,
): UniversalSearchToken[] {
  return tokens.map((t) => ({ ...t, chain }))
}

/** Name/symbol/address search: tracker + outcomes (both chains) + GMGN. */
export async function searchTokensUniversal(params: {
  chain: GmgnTradeChain
  query: string
  limit?: number
}): Promise<UniversalSearchToken[]> {
  const limit = params.limit ?? 20
  const q = params.query.trim()
  let gmgn: UniversalSearchToken[] = []
  try {
    gmgn = withChain(
      (
        await searchTokensForChain({ chain: params.chain, query: q, limit })
      ).filter((t): t is NonNullable<typeof t> => t != null),
      params.chain,
    )
  } catch {
    /* rate limit / no key — still return tracker hits */
  }
  if (!q) return gmgn
  const looksAddr =
    /^0x[a-fA-F0-9]{40}$/i.test(q) || (q.length >= 32 && q.length <= 44)
  if (looksAddr) {
    const other = CHAINS.find((c) => c !== params.chain)
    if (other && gmgn.length === 0) {
      try {
        gmgn = withChain(
          (
            await searchTokensForChain({ chain: other, query: q, limit: 1 })
          ).filter((t): t is NonNullable<typeof t> => t != null),
          other,
        )
      } catch {
        /* ignore */
      }
    }
    return gmgn
  }
  const local = await searchTrackedTokens(q, limit, params.chain)
  return mergeSearchResults(local, gmgn, limit)
}
