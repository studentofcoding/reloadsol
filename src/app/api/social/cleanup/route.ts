import { NextRequest, NextResponse } from 'next/server'
import { cleanupStaleSocialData } from '@/strategies/social/db'
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

  const result = await cleanupStaleSocialData()
  return NextResponse.json({
    success: !result.error,
    ...result,
  })
}
