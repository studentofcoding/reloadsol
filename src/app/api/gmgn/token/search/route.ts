import { NextRequest, NextResponse, connection } from 'next/server'
import { searchTokensUniversal } from '@/utils/token-search'
import { GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import { attachFirstDetections } from '@/utils/first-detection'


const SEARCH_TTL_S = 30

export async function GET(request: NextRequest) {
  await connection()
  try {
    const chain = request.nextUrl.searchParams.get('chain')?.trim() ?? ''
    const query = request.nextUrl.searchParams.get('query')?.trim() ?? ''
    if (!isGmgnTradeChain(chain)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }
    const cacheKey = `gmgn:search:${chain}:${query.toLowerCase()}`
    const cached = await cacheGet<{ address?: string }[]>(cacheKey)
    if (cached) {
      return NextResponse.json(await attachFirstDetections(cached))
    }
    const tokens = await searchTokensUniversal({ chain, query, limit: 20 })
    void cacheSet(cacheKey, tokens, SEARCH_TTL_S)
    // Array shape matches BulkTokenBuyer expectations (Jupiter search used `id`).
    return NextResponse.json(await attachFirstDetections(tokens))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
