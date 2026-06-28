import { NextRequest, NextResponse } from 'next/server'
import { pollTrackedWallets } from '@/utils/social/wallet-poll'
import { isSocialWalletPollAuthorized } from '@/utils/social/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const key =
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  if (!isSocialWalletPollAuthorized(key)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await pollTrackedWallets()
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
