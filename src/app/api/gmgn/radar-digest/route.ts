import { NextRequest, NextResponse } from 'next/server'
import { publishRadarDigest } from '@/strategies/gmgn-radar-digest'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { log } from '@/utils/unified-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function getDigestSecret(): string {
  return (
    process.env.GMGN_RADAR_DIGEST_SECRET ||
    process.env.GMGN_ACTIVITY_POLL_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getDigestSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await publishRadarDigest()
    log.info('api_request', 'Strategy PnL digest published', result)
    return NextResponse.json({ success: result.ok, ...result })
  } catch (error) {
    log.error('error_handling', 'Radar digest failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
