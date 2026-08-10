import { NextRequest, NextResponse } from 'next/server'
import { GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { GMGN_FILTERED_CRITERIA } from '@/utils/gmgn-trending-filtered'
import { getFilteredGmgnTrending } from '@/utils/gmgn-trending-feed'


export async function GET(request: NextRequest) {
  try {
    if (!process.env.GMGN_API_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN_API_KEY is not set' },
        { status: 503 },
      )
    }
    const chain = request.nextUrl.searchParams.get('chain')?.trim() ?? ''
    if (!isGmgnTradeChain(chain)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }

    const feed = await getFilteredGmgnTrending(chain)

    return NextResponse.json({
      ...feed,
      filtered: true,
      filter_criteria: GMGN_FILTERED_CRITERIA,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status =
      error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
