import { NextRequest, NextResponse, connection } from 'next/server'
import { getLpTerminalIndexerBase } from '@/utils/dlmm/lp-terminal'
import type { LpTerminalPoolRaw, LpTerminalTokenMeta } from '@/utils/dlmm/lp-terminal-pools'
import {
  fetchClmmPoolFallbacks,
  mergeLpFallbackCatalog,
  type LpFallbackWant,
} from '@/utils/dlmm/lp-terminal-pools-fallback'
import {
  rhIndexerConfidence,
  rhPoolsToCatalog,
  rhPoolsUrl,
  type RhIndexerStatus,
  type RhPoolsResponse,
} from '@/utils/dlmm/rh-pools-indexer'
import { scoreRhPools } from '@/utils/dlmm/rh-lp-screen.server'

const ALLOWED_SORT = new Set(['tvl', 'vol', 'created', 'fees'])

/**
 * Goldsky-hosted Robinhood Chain UniV2 subgraph (same one the LP Terminal SPA
 * uses). Used as fallback when the public REST indexer is unavailable.
 */
const RH_UNIV2_SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn'

const QUOTE_ORDER = ['USDG', 'USDC', 'USDT', 'WETH', 'UP'] as const

/**
 * Upstream fetch for LP Terminal pools. Plain `fetch` (no `'use cache'` /
 * `cacheTag` / `cacheLife`): under Next 16.3 `cacheComponents` an API route
 * that mixes the experimental cache with live `fetch` gets prerendered to an
 * HTML shell, which HTML-leaks to clients as `<!DOCTYPE …`. The JSON response
 * already sets `Cache-Control: s-maxage=30` for proxy/CDN caching, so no
 * experimental cache machinery is needed here.
 */
async function fetchLpPoolsRaw(url: string): Promise<string> {
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

/**
 * Parse the LP Terminal indexer body. Throws when the body isn't JSON — e.g. an
 * HTML error/redirect page from a retired endpoint — so callers can fall back
 * to the subgraph instead of returning a bogus 502.
 */
export function parseLpIndexerBody(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('<')) {
    throw new Error('Indexer returned non-JSON (likely HTML)')
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new Error('Indexer returned invalid JSON')
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
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
 * Build the `where` clause for the Robinhood UniV2 subgraph. Subgraph ids are
 * lowercase 0x strings, so `q` is lowercased first. A single top-level `or`
 * matches the pool `id` exactly (pool-address lookup), or the `token0`/`token1`
 * string ids exactly (token search). No nested relation/`or` objects — the
 * Goldsky subgraph rejects those. When both `minTvl` and `q` are present they
 * are combined with an `and`.
 */
export function buildSubgraphPairsWhere(opts: {
  q?: string
  minTvl?: string
}): string {
  const filters: string[] = []
  if (opts.minTvl) {
    const min = Number(opts.minTvl)
    if (Number.isFinite(min) && min > 0) {
      filters.push(`reserveUSD_gte: "${gqlStr(String(min))}"`)
    }
  }
  if (opts.q) {
    const q = opts.q.trim().toLowerCase()
    filters.push(
      `or: [{ id: "${gqlStr(q)}" }, { token0: "${gqlStr(q)}" }, { token1: "${gqlStr(q)}" }]`,
    )
  }
  if (filters.length === 0) return ''
  return filters.length === 1
    ? `where: { ${filters[0]} }`
    : `where: { and: [${filters.map((f) => `{ ${f} }`).join(', ')}] }`
}

/**
 * Fetch UniV2 pools from the Goldsky RH subgraph and shape them into the same
 * LpTerminalPoolRaw contract the frontend expects. Only used when the primary
 * indexer is unreachable (primary indexer retired → HTTP 410).
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

  const whereClause = buildSubgraphPairsWhere({ q: opts.q, minTvl: opts.minTvl })
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

function wantFromQuery(proto?: string): LpFallbackWant {
  return proto === 'univ2' || proto === 'univ3' || proto === 'univ4' ? proto : ''
}

export async function GET(req: NextRequest) {
  // Dynamic GET route (reads search params, does live fetch): calling
  // `await connection()` bails the route out of the cacheComponents static
  // shell. Explicitly NOT setting `force-dynamic`, which is incompatible with
  // cacheComponents. The route's old `'use cache'`/`cacheTag`/`cacheLife`
  // wrapper was removed because it caused this route to be prerendered into an
  // HTML shell that HTML-leaked to clients as a `<!DOCTYPE …` page.
  await connection()
  const sp = req.nextUrl.searchParams
  const upstreamBase = getLpTerminalIndexerBase()

  const q = sp.get('q')?.trim() || undefined
  const proto = sp.get('proto')?.trim() || undefined
  const minTvl = sp.get('min_tvl') ?? sp.get('minTvl') ?? undefined

  const sortRaw = sp.get('sort')?.trim() || 'fees'
  const sort = ALLOWED_SORT.has(sortRaw)
    ? (sortRaw as 'tvl' | 'vol' | 'created' | 'fees')
    : 'fees'

  const limitRaw = Number(sp.get('limit') ?? 100)
  const limit = Number.isFinite(limitRaw)
    ? Math.min(500, Math.max(1, Math.floor(limitRaw)))
    : 100

  const offsetRaw = Number(sp.get('offset') ?? 0)
  const offset = Number.isFinite(offsetRaw)
    ? Math.min(20_000, Math.max(0, Math.floor(offsetRaw)))
    : 0

  const url = rhPoolsUrl(upstreamBase, { sort, limit, offset, q, proto })

  try {
    const [text, statusText] = await Promise.all([
      fetchLpPoolsRaw(url),
      fetchLpPoolsRaw(`${upstreamBase}/api/lp/status`).catch(() => ''),
    ])
    const body = parseLpIndexerBody(text) as RhPoolsResponse | null
    if (!body || !Array.isArray(body.rows)) {
      throw new Error('Indexer body missing rows')
    }
    let status: RhIndexerStatus | null = null
    try {
      status = parseLpIndexerBody(statusText) as RhIndexerStatus | null
    } catch {
      status = null
    }
    const confidence = rhIndexerConfidence(status)
    const catalog = rhPoolsToCatalog(body)
    // min_tvl only drops pools whose TVL is *known* — singleton v4 pools report
    // tvl_usd=null (manager balance ≠ TVL) and must stay visible with a risk chip.
    const minTvlNum = minTvl != null && minTvl !== '' ? Number(minTvl) : 0
    const filtered =
      Number.isFinite(minTvlNum) && minTvlNum > 0
        ? catalog.pools.filter((p) => p.tvlApprox || (Number(p.tvlUsd) || 0) >= minTvlNum)
        : catalog.pools
    const pools = (await scoreRhPools(filtered, confidence.score)).map(({ pool, score }) => ({
      ...pool,
      score: score.score,
      scoreReasons: score.reasons,
      demandUsd: score.features.demandUsd,
    }))
    return NextResponse.json(
      {
        success: true,
        upstream: upstreamBase,
        ready: true,
        asof: body.as_of,
        pools,
        tokens: catalog.tokens,
        count: catalog.count,
        totals: catalog.totals,
        indexer: {
          lag_s: confidence.lagS,
          confidence: confidence.score,
          no_trade: confidence.noTrade,
          reasons: confidence.reasons,
        },
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
        },
      },
    )
  } catch (error) {
    // Primary indexer unreachable OR returned non-JSON/HTML. Merge Goldsky
    // UniV2 + Dexscreener UniV3 + Dexscreener/Explore UniV4 so proto chips work.
    const want: LpFallbackWant = wantFromQuery(proto)
    const minTvlNum = minTvl != null && minTvl !== '' ? Number(minTvl) : undefined

    try {
      const [v2, clmm] = await Promise.all([
        want === 'univ3' || want === 'univ4'
          ? Promise.resolve({ pools: [] as LpTerminalPoolRaw[], tokens: {} as Record<string, LpTerminalTokenMeta>, count: 0 })
          : fetchRhUniv2FromSubgraph({
              q,
              sort: sort === 'fees' ? 'vol' : sort,
              limit,
              offset,
              minTvl,
            }),
        want === 'univ2'
          ? Promise.resolve({ univ3: [] as LpTerminalPoolRaw[], univ4: [] as LpTerminalPoolRaw[], tokens: {} as Record<string, LpTerminalTokenMeta> })
          : fetchClmmPoolFallbacks(q),
      ])
      const tokens = { ...v2.tokens, ...clmm.tokens }
      const merged = mergeLpFallbackCatalog({
        want,
        univ2: v2.pools,
        univ3: clmm.univ3,
        univ4: clmm.univ4,
        tokens,
        minTvl: Number.isFinite(minTvlNum) ? minTvlNum : undefined,
      })
      return NextResponse.json(
        {
          success: true,
          upstream: `${upstreamBase} (subgraph+dex fallback)`,
          ready: true,
          pools: merged.pools,
          tokens: merged.tokens,
          count: merged.count,
          totals: merged.totals,
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
          error: errorMessage(
            fallbackErr,
            errorMessage(error, 'Failed to reach LP Terminal indexer'),
          ),
          upstream: upstreamBase,
        },
        { status: 502 },
      )
    }
  }
}
