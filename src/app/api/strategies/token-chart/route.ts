import { NextRequest, NextResponse, connection } from 'next/server'
import { loadTokenMapChart } from '@/strategies/token-map-chart'
import { isValidAnyChainTokenAddress } from '@/utils/gmgn-currencies'


export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    const hours = Number(searchParams.get('hours') ?? 24)

    if (!address || !isValidAnyChainTokenAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }

    const chart = await loadTokenMapChart({
      tokenAddress: address,
      hours: Number.isFinite(hours) ? hours : 24,
    })

    return NextResponse.json(
      { success: true, ...chart },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        points: [],
        outcomes: [],
        candles: [],
      },
      { status: 500 },
    )
  }
}
