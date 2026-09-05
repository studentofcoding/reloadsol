import { NextRequest, NextResponse, connection } from 'next/server'
import { marketTrending } from '@/utils/gmgn-cli'
import {
  applyRobinhoodLpFilters,
  ROBINHOOD_LP_DEFAULTS,
} from '@/utils/dlmm/robinhood-screen'

export async function GET(req: NextRequest) {
  await connection()
  try {
    const sp = req.nextUrl.searchParams
    const minMcap = Number(sp.get('minMcap') ?? ROBINHOOD_LP_DEFAULTS.minMcap)
    const minVolume = Number(sp.get('minVolume') ?? ROBINHOOD_LP_DEFAULTS.minVolume)
    const limit = Number(sp.get('limit') ?? ROBINHOOD_LP_DEFAULTS.limit)

    const filters = {
      chain: ROBINHOOD_LP_DEFAULTS.chain,
      interval: ROBINHOOD_LP_DEFAULTS.interval,
      minMcap: Number.isFinite(minMcap) ? minMcap : ROBINHOOD_LP_DEFAULTS.minMcap,
      minVolume: Number.isFinite(minVolume) ? minVolume : ROBINHOOD_LP_DEFAULTS.minVolume,
      limit: Number.isFinite(limit)
        ? Math.min(100, Math.max(1, Math.floor(limit)))
        : ROBINHOOD_LP_DEFAULTS.limit,
    }

    const rank = await marketTrending({
      chain: filters.chain,
      interval: filters.interval,
      minMarketcap: filters.minMcap,
      minVolume: filters.minVolume,
      limit: filters.limit,
    })

    const tokens = applyRobinhoodLpFilters(rank, {
      minMcap: filters.minMcap,
      minVolume: filters.minVolume,
    })

    return NextResponse.json({
      success: true,
      tokens,
      fetchedAt: new Date().toISOString(),
      filters,
      rawCount: rank.length,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to screen Robinhood tokens',
      },
      { status: 500 },
    )
  }
}
