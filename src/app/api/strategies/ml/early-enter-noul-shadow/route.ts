import { NextRequest, NextResponse, connection } from 'next/server'
import { loadEarlyEnterNoulCompareStats } from '@/strategies/early-enter-noul-shadow-db'
import {
  isEarlyEnterNoulShadowEnabled,
  isEarlyEnterNoulSoftActiveEnabled,
} from '@/strategies/early-enter-noul-shadow'
import { getTypeSafeApiKey } from '@/strategies/typesafe-noul'

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const hoursRaw = parseInt(searchParams.get('hours') || '24', 10)
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 168) : 24
    const byStrategy = await loadEarlyEnterNoulCompareStats(hours)
    const total = byStrategy.reduce((n, r) => n + r.total, 0)
    return NextResponse.json({
      success: true,
      hours,
      shadowEnabled: isEarlyEnterNoulShadowEnabled(),
      softActive: isEarlyEnterNoulSoftActiveEnabled(),
      hasTypeSafeCreds: Boolean(getTypeSafeApiKey()),
      total,
      byStrategy,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}
