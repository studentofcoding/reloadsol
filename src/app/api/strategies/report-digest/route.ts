import { NextRequest, NextResponse } from 'next/server'
import { sendStrategyReportDigest } from '@/strategies/report-notify'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

export const dynamic = 'force-dynamic'

function getReportSecret(): string {
  return (
    process.env.STRATEGY_REPORT_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getReportSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = request.nextUrl
    const from = searchParams.get('from') ?? undefined
    const to = searchParams.get('to') ?? undefined
    const result = await sendStrategyReportDigest({ from, to })
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
