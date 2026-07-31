import { NextRequest, NextResponse } from 'next/server'
import {
  patternRules,
  refreshMcapSocialPatterns24hAllChains,
} from '@/strategies/social/mcap-patterns-24h'
import { isSocialRollupAuthorized } from '@/utils/social/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: NextRequest) {
  const key =
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  if (!isSocialRollupAuthorized(key)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { sol, robinhood } = await refreshMcapSocialPatterns24hAllChains()
    const error = sol.error || robinhood.error
    const status = error ? 503 : 200
    return NextResponse.json(
      {
        success: !error,
        rules: patternRules(),
        chains: {
          sol: {
            builtAt: sol.builtAt,
            winners: sol.winners.length,
            losers: sol.losers.length,
            neutralCount: sol.neutralCount,
            tokenCount: sol.tokenCount,
            upserted: sol.upserted,
            skippedNeutral: sol.skippedNeutral,
            error: sol.error,
          },
          robinhood: {
            builtAt: robinhood.builtAt,
            winners: robinhood.winners.length,
            losers: robinhood.losers.length,
            neutralCount: robinhood.neutralCount,
            tokenCount: robinhood.tokenCount,
            upserted: robinhood.upserted,
            skippedNeutral: robinhood.skippedNeutral,
            error: robinhood.error,
          },
        },
        error,
      },
      { status },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
