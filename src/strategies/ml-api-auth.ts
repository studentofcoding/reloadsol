import { NextRequest, NextResponse } from 'next/server'
import { requireDevSession } from '@/utils/api-auth'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

export function getMlSecret(): string {
  return (
    process.env.MCAP_TRACKER_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

export function isMlRouteAuthorized(request: NextRequest): NextResponse | null {
  const key = request.nextUrl.searchParams.get('key')
  if (process.env.NODE_ENV === 'development' && !key) {
    return null
  }
  if (isAuthorizedRequest(key, getMlSecret())) {
    return null
  }
  const devAuth = requireDevSession(request)
  if (devAuth instanceof NextResponse) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
