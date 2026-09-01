import { NextRequest, NextResponse, connection } from 'next/server'
import { fetchTokenMapActivity } from '@/strategies/token-map-activity'
import { isGmgnTradeChain, isValidAnyChainTokenAddress } from '@/utils/gmgn-currencies'


export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    const hours = Number(searchParams.get('hours') ?? 24)
    const limit = Number(searchParams.get('limit') ?? 80)
    const chainRaw = searchParams.get('chain')?.trim() || 'sol'
    if (!isGmgnTradeChain(chainRaw)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }

    if (!address || !isValidAnyChainTokenAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }

    const activities = await fetchTokenMapActivity({
      tokenAddress: address,
      chain: chainRaw,
      hours: Number.isFinite(hours) ? hours : 24,
      limit: Number.isFinite(limit) ? limit : 80,
    })

    return NextResponse.json(
      {
        success: true,
        tokenAddress: address,
        activities,
        fetchedAt: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        activities: [],
      },
      { status: 500 },
    )
  }
}
