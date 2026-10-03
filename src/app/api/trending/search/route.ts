import { NextResponse, connection } from 'next/server'
import { normalizeAssetSearchQuery, searchJupiterAssets } from '@/utils/jupiter-asset-search'

export async function GET(request: Request) {
  await connection()
  const { searchParams } = new URL(request.url)
  const query = normalizeAssetSearchQuery(searchParams.get('query') ?? '')

  if (!query) {
    return NextResponse.json({ error: 'Query parameter is required' }, { status: 400 })
  }

  const result = await searchJupiterAssets(query)
  if (result.ok) {
    return NextResponse.json(result.data, {
      headers: { 'X-Cache': result.cache, 'Cache-Control': 'private, max-age=15' },
    })
  }
  if (result.status === 429) {
    return NextResponse.json(
      { error: 'Rate limited by Jupiter; retry shortly' },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterS) } },
    )
  }
  return NextResponse.json({ error: 'Failed to fetch token data' }, { status: 500 })
}
