import { NextRequest, NextResponse } from 'next/server'
import { refreshSocialRollups } from '@/strategies/social/db'
import { refreshMcapSocialPatterns24h } from '@/strategies/social/mcap-patterns-24h'
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

  const result = await refreshSocialRollups()
  if (!result.error) {
    refreshMcapSocialPatterns24h().catch((err) => {
      console.warn('[social/rollup] mcap patterns refresh failed:', err)
    })
  }
  const status = result.error ? 503 : 200
  return NextResponse.json(
    {
      success: !result.error,
      ...result,
    },
    { status },
  )
}
