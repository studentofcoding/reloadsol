import { NextRequest, NextResponse, connection } from 'next/server'
import { cacheTag, cacheLife } from 'next/cache'
import { getLpTerminalIndexerBase } from '@/utils/dlmm/lp-terminal'
import type { LpTerminalPoolRaw, LpTerminalTokenMeta } from '@/utils/dlmm/lp-terminal-pools'

const ALLOWED_SORT = new Set(['tvl', 'vol', 'created'])

/**
 * Goldsky-hosted Robinhood Chain UniV2 subgraph (same one the LP Terminal SPA
 * uses). Used as fallback when the public REST indexer is unavailable.
 */
const RH_UNIV2_SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn'

const QUOTE_ORDER = ['USDG', 'USDC', 'USDT', 'WETH', 'UP'] as const

/**
 * Cached upstream fetch for LP Terminal pools. `'use cache'` (Next 16.3 Cache
 * Components) makes the response reusable across requests for the same params
 * and invalidatable via `updateTag('lp-terminal-pools')`.
 */
async function fetchLpPoolsCached(url: string): Promise<string> {
  'use cache'
  cacheTag('lp-terminal-pools')
  cacheLife('minutes')
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Indexer HTTP ${res.status}`)
  }
  return text
}

type SubgraphPair = {
  id: string
  createdAtTimestamp?: string | null
  reserve0?: string | null
  reserve1?: string | null
  totalSupply?: string | null
  reserveUSD?: string | null
  volumeUSD?: string | null
  token0: { id: string; symbol?: string | null; decimals?: string | null }
  token1: { id: string; symbol?: string | null; decimals?: string | null }
}

/** Normalize to lowercase 0x address for token-map keys. */
function normAddr(a: string): string {
  return a.trim().toLowerCase()
}

/** Escape a GraphQL string literal. */
function gqlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Fetch UniV2 pools from the Goldsky RH subgraph and shape them into the same
 * LpTerminalPoolRaw contract the frontend expects. Only used when the primary
 * indexer is unreachable (public indexer retired → HTTP 410).
 */
async function fetchRhUniv2FromSubgraph(opts: {
  q?: string
  sort: 'tvl' | 'vol' | 'created'
  limit: number
  offset: number
  minTvl?: string
}): Promise<{ pools: LpTerminalPoolRaw[]; tokens: Record<string, LpTerminalTokenMeta>; count: number }> {
  const orderBy =
    opts.sort === 'vol' ? 'volumeUSD' : opts.sort === 'created' ? 'createdAtTimestamp' : 'reserveUSD'

  const whereParts: string[] = []
  if (opts.minTvl) {
    const min = Number(opts.minTvl)
    if (Number.isFinite(min) && min > 0) whereParts.push(`reserveUSD_gte: "${gqlStr(String(min))}"`)
  }
  if (opts.q) {
    const q = opts.q.trim().toLowerCase()
    whereParts.push(
      `token0_: { or: [{ id_contains: "${gqlStr(q)}" }, { symbol_contains_nocase: "${gqlStr(q)}" }] }`,
    )
    whereParts.push(
      `token1_: { or: [{ id_contains: "${gqlStr(q)}" }, { symbol_contains_nocase: "${gqlStr(q)}" }] }`,
    )
  }

  const whereClause = whereParts.length > 0 ? `where: { ${whereParts.join(' ')} }` : ''
  const first = Math.min(500, Math.max(1, opts.limit))
  const skip = Math.min(20_000, Math.max(0, opts.offset))

  const query = `{
    pairs(
      first: ${first},
      skip: ${skip},
      orderBy: ${orderBy},
      orderDirection: desc,
      ${whereClause}
    ) {
      id
      createdAtTimestamp
      reserve0
      reserve1
      totalSupply
      reserveUSD
      volumeUSD
      token0 { id symbol decimals }
      token1 { id symbol decimals }
    }
  }`

  const res = await fetch(RH_UNIV2_SUBGRAPH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`RH subgraph HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { pairs?: SubgraphPair[] }; errors?: unknown }
  if (json.errors || !json.data) {
    throw new Error('RH subgraph query failed')
  }

  const pairs = json.data.pairs ?? []
  const tokens: Record<string, LpTerminalTokenMeta> = {}
  for (const p of pairs) {
    const t0 = normAddr(p.token0.id)
    const t1 = normAddr(p.token1.id)
    tokens[t0] = {
      address: t0,
      symbol: p.token0.symbol ?? undefined,
      decimals: p.token0.decimals != null ? Number(p.token0.decimals) : undefined,
    }
    tokens[t1] = {
      address: t1,
      symbol: p.token1.symbol ?? undefined,
      decimals: p.token1.decimals != null ? Number(p.token1.decimals) : undefined,
    }
  }

  // Sort in JS when the q filter forces OR semantics that skip ordering.
  let sorted = pairs
  if (opts.q) {
    sorted = [...pairs].sort((a, b) => {
      const ka = opts.sort === 'vol' ? Number(b.volumeUSD ?? 0) - Number(a.volumeUSD ?? 0)
        : opts.sort === 'created' ? Number(b.createdAtTimestamp ?? 0) - Number(a.createdAtTimestamp ?? 0)
        : Number(b.reserveUSD ?? 0) - Number(a.reserveUSD ?? 0)
      return ka
    })
  }

  const pools: LpTerminalPoolRaw[] = sorted.map((p) => ({
    proto: 'univ2',
    address: normAddr(p.id),
    token0: normAddr(p.token0.id),
    token1: normAddr(p.token1.id),
    reserve0: p.reserve0 ?? null,
    reserve1: p.reserve1 ?? null,
    tvlUsd: Number(p.reserveUSD) || 0,
    vol24hUsd: Number(p.volumeUSD) || 0,
    tvlApprox: false,
  }))

  return { pools, tokens, count: pairs.length }
}

export async function GET(req: NextRequest) {
  await connection()
  const sp = req.nextUrl.searchParams
  const upstreamBase = getLpTerminalIndexerBase()
  const params = new URLSearchParams()

  const q = sp.get('q')?.trim()
  if (q) params.set('q', q)

  const proto = sp.get('proto')?.trim()
  if (proto) params.set('proto', proto)

  const minTvl = sp.get('min_tvl') ?? sp.get('minTvl')
  if (minTvl != null && minTvl !== '') params.set('min_tvl', minTvl)

  const sortRaw = sp.get('sort')?.trim() || 'vol'
  const sort = ALLOWED_SORT.has(sortRaw) ? sortRaw : 'vol'
  params.set('sort', sort)

  const limitRaw = Number(sp.get('limit') ?? 100)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
    : 100
  params.set('limit', String(limit))

  const offsetRaw = Number(sp.get('offset') ?? 0)
  const offset = Number.isFinite(offsetRaw)
    ? Math.min(20_000, Math.max(0, Math.floor(offsetRaw)))
    : 0
  params.set('offset', String(offset))

  const url = `${upstreamBase}/api/pools?${params.toString()}`

  try {
    const text = await fetchLpPoolsCached(url)
    let body: unknown = null
    try {
      body = text.trim() ? JSON.parse(text) : null
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid JSON from indexer (${'unknown status'})`,
          upstream: upstreamBase,
        },
        { status: 502 },
      )
    }

    return NextResponse.json(
      { success: true, upstream: upstreamBase, ...(body as object) },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
    )
  } catch (error) {
    // Primary indexer unreachable (e.g. public LP Terminal indexer retired
    // with HTTP 410). Fall back to the Goldsky RH UniV2 subgraph so the RH
    // DLMM pools table keeps working.
    if (proto && proto !== 'univ2') {
      return NextResponse.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to reach LP Terminal indexer',
          upstream: upstreamBase,
        },
        { status: 502 },
      )
    }

    try {
      const fallback = await fetchRhUniv2FromSubgraph({
        q,
        sort,
        limit,
        offset,
        minTvl: minTvl ?? undefined,
      })
      return NextResponse.json(
        {
          success: true,
          upstream: `${upstreamBase} (subgraph fallback)`,
          ready: true,
          pools: fallback.pools,
          tokens: fallback.tokens,
          count: fallback.count,
          totals: { univ2: fallback.count, univ3: 0 },
        },
        {
          headers: {
            'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
          },
        },
      )
    } catch (fallbackErr) {
      return NextResponse.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : 'Failed to reach LP Terminal indexer',
          upstream: upstreamBase,
        },
        { status: 502 },
      )
    }
  }
}
