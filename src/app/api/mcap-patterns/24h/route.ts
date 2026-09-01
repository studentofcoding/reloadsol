import { NextRequest, NextResponse, connection } from 'next/server'
import {
  listMcapSocialPatterns24h,
  patternRules,
  refreshMcapSocialPatterns24h,
} from '@/strategies/social/mcap-patterns-24h'
import { parseDbChain } from '@/utils/app-network-db'

export const maxDuration = 120

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const chain = parseDbChain(request.nextUrl.searchParams.get('chain'))
    const refresh = request.nextUrl.searchParams.get('refresh') === 'true'
    const result = refresh
      ? await refreshMcapSocialPatterns24h(new Date(), chain)
      : await listMcapSocialPatterns24h(chain)

    if (result.error && result.winners.length === 0 && result.losers.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          rules: patternRules(),
          builtAt: result.builtAt,
          winners: [],
          losers: [],
          neutralCount: result.neutralCount,
        },
        { status: result.error.includes('missing') ? 503 : 500 },
      )
    }

    return NextResponse.json({
      success: true,
      rules: patternRules(),
      builtAt: result.builtAt,
      winners: result.winners,
      losers: result.losers,
      neutralCount: result.neutralCount,
      tokenCount: result.tokenCount,
      refreshed: refresh,
      chain,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
