import { NextRequest, NextResponse, connection } from 'next/server'
import {
  loadEarlyEnterNoulCompareStats,
  loadEarlyEnterNoulShadowRows,
} from '@/strategies/early-enter-noul-shadow-db'
import {
  isEarlyEnterNoulShadowEnabled,
  isEarlyEnterNoulSoftActiveEnabled,
  isNoulShadowBand,
} from '@/strategies/early-enter-noul-shadow'
import { getTypeSafeApiKey } from '@/strategies/typesafe-noul'

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const hoursRaw = parseInt(searchParams.get('hours') || '24', 10)
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 168) : 24

    const limitRaw = parseInt(searchParams.get('limit') || '100', 10)
    const offsetRaw = parseInt(searchParams.get('offset') || '0', 10)
    const strategyKeyParam = searchParams.get('strategy_key')?.trim() || null
    const bandParam = searchParams.get('band')?.trim() || null
    const band = bandParam && isNoulShadowBand(bandParam) ? bandParam : null

    const [byStrategy, list] = await Promise.all([
      loadEarlyEnterNoulCompareStats(hours),
      loadEarlyEnterNoulShadowRows({
        hours,
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
        strategyKey: strategyKeyParam,
        band,
      }),
    ])
    const total = byStrategy.reduce((n, r) => n + r.total, 0)

    return NextResponse.json({
      success: true,
      hours,
      shadowEnabled: isEarlyEnterNoulShadowEnabled(),
      softActive: isEarlyEnterNoulSoftActiveEnabled(),
      hasTypeSafeCreds: Boolean(getTypeSafeApiKey()),
      total,
      byStrategy,
      rows: list.rows,
      rowsTotal: list.total,
      limit: list.limit,
      offset: list.offset,
      strategyKey: strategyKeyParam,
      band,
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
