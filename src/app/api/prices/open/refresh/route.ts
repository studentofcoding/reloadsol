import { NextRequest, NextResponse } from 'next/server'
import { parseDbChain } from '@/utils/app-network-db'
import { getOpenPositionPrices } from '@/utils/open-position-prices'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { mints?: unknown; chain?: unknown }
    const chain = parseDbChain(
      typeof body.chain === 'string' ? body.chain : undefined,
    )
    const mints = Array.isArray(body.mints)
      ? body.mints.filter((m): m is string => typeof m === 'string' && m.length > 0)
      : []

    if (mints.length === 0) {
      return NextResponse.json({ success: true, prices: {} })
    }

    // Cap batch size — open positions only
    const capped = mints.slice(0, 100)
    const prices = await getOpenPositionPrices(capped, chain)
    return NextResponse.json({ success: true, prices })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
