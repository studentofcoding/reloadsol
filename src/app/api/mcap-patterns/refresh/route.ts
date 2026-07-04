import { NextRequest, NextResponse } from 'next/server'
import { refreshMcapSocialPatterns24h, patternRules } from '@/strategies/social/mcap-patterns-24h'
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
    const result = await refreshMcapSocialPatterns24h()
    const status = result.error ? 503 : 200
    return NextResponse.json(
      {
        success: !result.error,
        rules: patternRules(),
        builtAt: result.builtAt,
        winners: result.winners,
        losers: result.losers,
        neutralCount: result.neutralCount,
        tokenCount: result.tokenCount,
        upserted: result.upserted,
        skippedNeutral: result.skippedNeutral,
        error: result.error,
      },
      { status },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
