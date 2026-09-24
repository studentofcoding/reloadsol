import { NextRequest, NextResponse, connection } from 'next/server'
import {
  loadEarlyEnterNoulCompareStats,
  loadEarlyEnterNoulFlipReadiness,
  loadEarlyEnterNoulShadowRows,
  loadEarlyEnterNoulShadowTokenPeaks,
} from '@/strategies/early-enter-noul-shadow-db'
import {
  isEarlyEnterNoulShadowEnabled,
  isEarlyEnterNoulSoftActiveEnabled,
  isNoulShadowBand,
  parseEarlyEnterNoulTokenPeakSort,
  type FlipArmFamily,
} from '@/strategies/early-enter-noul-shadow'
import { getTypeSafeApiKey } from '@/strategies/typesafe-noul'

function parseArm(raw: string | null): FlipArmFamily | null {
  if (raw === 'first_seen' || raw === 'at_80') return raw
  return null
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const hoursRaw = parseInt(searchParams.get('hours') || '24', 10)
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 168) : 24

    const limitRaw = parseInt(searchParams.get('limit') || '100', 10)
    const offsetRaw = parseInt(searchParams.get('offset') || '0', 10)
    const strategyKeyParam = searchParams.get('strategy_key')?.trim() || null
    const arm = parseArm(searchParams.get('arm')?.trim() || null)
    const bandParam = searchParams.get('band')?.trim() || null
    const band = bandParam && isNoulShadowBand(bandParam) ? bandParam : null
    const tokenLimitRaw = parseInt(searchParams.get('token_limit') || '100', 10)
    const tokenOffsetRaw = parseInt(searchParams.get('token_offset') || '0', 10)
    const tokenSort = parseEarlyEnterNoulTokenPeakSort(searchParams.get('token_sort'))

    const [byStrategy, list, flipReadiness, tokenPeaks] = await Promise.all([
      loadEarlyEnterNoulCompareStats(hours),
      loadEarlyEnterNoulShadowRows({
        hours,
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        offset: Number.isFinite(offsetRaw) ? offsetRaw : 0,
        strategyKey: strategyKeyParam,
        arm,
        band,
      }),
      loadEarlyEnterNoulFlipReadiness(),
      loadEarlyEnterNoulShadowTokenPeaks({
        limit: Number.isFinite(tokenLimitRaw) ? tokenLimitRaw : 100,
        offset: Number.isFinite(tokenOffsetRaw) ? tokenOffsetRaw : 0,
        sort: tokenSort,
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
      flipReadiness,
      rows: list.rows,
      rowsTotal: list.total,
      limit: list.limit,
      offset: list.offset,
      strategyKey: strategyKeyParam,
      arm,
      band,
      tokenPeaks,
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
