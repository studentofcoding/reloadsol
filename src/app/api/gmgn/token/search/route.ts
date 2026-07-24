import { NextRequest, NextResponse } from 'next/server'
import { searchTokensForChain, GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    if (!process.env.GMGN_API_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN_API_KEY is not set' },
        { status: 503 },
      )
    }
    const chain = request.nextUrl.searchParams.get('chain')?.trim() ?? ''
    const query = request.nextUrl.searchParams.get('query')?.trim() ?? ''
    if (!isGmgnTradeChain(chain)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }
    const tokens = await searchTokensForChain({ chain, query, limit: 20 })
    // Array shape matches BulkTokenBuyer expectations (Jupiter search used `id`).
    return NextResponse.json(tokens)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
