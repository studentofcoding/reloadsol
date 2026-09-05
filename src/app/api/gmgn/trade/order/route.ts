import { NextRequest, NextResponse, connection } from 'next/server'
import { tradeOrderGet, GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'


export async function GET(request: NextRequest) {
  await connection()
  try {
    if (!process.env.GMGN_API_KEY?.trim() || !process.env.GMGN_PRIVATE_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN_API_KEY / GMGN_PRIVATE_KEY not set' },
        { status: 503 },
      )
    }
    const chain = request.nextUrl.searchParams.get('chain')?.trim() ?? ''
    const orderId = request.nextUrl.searchParams.get('orderId')?.trim() ?? ''
    if (!isGmgnTradeChain(chain) || !orderId) {
      return NextResponse.json(
        { success: false, error: 'chain and orderId required' },
        { status: 400 },
      )
    }
    const order = await tradeOrderGet({ chain, orderId })
    return NextResponse.json({ success: true, order })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ success: false, error: msg }, { status })
  }
}
