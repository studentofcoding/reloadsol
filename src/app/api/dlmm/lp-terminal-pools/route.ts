import { NextRequest, NextResponse } from 'next/server'
import { cacheTag, cacheLife } from 'next/cache'
import { getLpTerminalIndexerBase } from '@/utils/dlmm/lp-terminal'


const ALLOWED_SORT = new Set(['tvl', 'vol', 'created'])

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

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const upstreamBase = getLpTerminalIndexerBase()
  const params = new URLSearchParams()

  const q = sp.get('q')?.trim()
  if (q) params.set('q', q)

  const proto = sp.get('proto')?.trim()
  if (proto) params.set('proto', proto)

  const minTvl = sp.get('min_tvl') ?? sp.get('minTvl')
  if (minTvl != null && minTvl !== '') params.set('min_tvl', minTvl)

  const sort = sp.get('sort')?.trim() || 'vol'
  params.set('sort', ALLOWED_SORT.has(sort) ? sort : 'vol')

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
