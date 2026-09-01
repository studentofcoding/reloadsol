import { NextRequest, NextResponse, connection } from 'next/server'
import { fetchTokenOhlc } from '@/strategies/token-map-chart'
import { isValidMintAddress } from '@/utils/jupiter'


function parseTime(raw: string | null): number | null {
  if (!raw?.trim()) return null
  const asNum = Number(raw)
  if (Number.isFinite(asNum) && asNum > 1e9) {
    // seconds if < year 2100 in ms range
    return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum)
  }
  const ms = new Date(raw).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    if (!address || !isValidMintAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }

    const timeFrom = parseTime(searchParams.get('timeFrom'))
    const timeTo = parseTime(searchParams.get('timeTo'))
    const interval = searchParams.get('interval')?.trim() || undefined
    const hoursRaw = Number(searchParams.get('hours') ?? 24)
    const hours = Number.isFinite(hoursRaw) ? hoursRaw : 24

    const { candles, source } = await fetchTokenOhlc({
      tokenAddress: address,
      hours,
      interval,
      ...(timeFrom != null ? { timeFrom } : {}),
      ...(timeTo != null ? { timeTo } : {}),
    })

    return NextResponse.json(
      {
        success: true,
        address,
        candles,
        source,
        timeFrom,
        timeTo,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        candles: [],
      },
      { status: 500 },
    )
  }
}
