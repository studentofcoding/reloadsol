import { NextRequest, NextResponse } from 'next/server'
import { GmgnApiError, marketTrending } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  filterAndSortGmgnTrending,
  GMGN_FILTERED_CRITERIA,
} from '@/utils/gmgn-trending-filtered'

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
    if (!isGmgnTradeChain(chain)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }

    const rank = await marketTrending({
      chain,
      interval: '1h',
      limit: 100,
      minMarketcap: GMGN_FILTERED_CRITERIA.min_mcap,
      orderBy: 'volume',
      direction: 'desc',
    })

    const { tokens, total_before_filter, total_after_filter } =
      filterAndSortGmgnTrending(rank)

    return NextResponse.json({
      tokens,
      filtered: true,
      filter_criteria: GMGN_FILTERED_CRITERIA,
      total_before_filter,
      total_after_filter,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status =
      error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
