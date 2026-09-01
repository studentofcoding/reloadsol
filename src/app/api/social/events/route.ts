import { NextRequest, NextResponse, connection } from 'next/server'
import { fetchRecentSocialEventsFeed } from '@/strategies/social/db'


export async function GET(request: NextRequest) {
  await connection()
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 50)
  const hours = Number(request.nextUrl.searchParams.get('hours') ?? 24)
  const telegramOnly = request.nextUrl.searchParams.get('telegram_only') !== 'false'

  const events = await fetchRecentSocialEventsFeed({
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
    hours: Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 168) : 24,
    telegramOnly,
  })

  return NextResponse.json({
    success: true,
    events,
    filters: { limit, hours, telegram_only: telegramOnly },
  })
}
