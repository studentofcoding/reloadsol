import { NextRequest, NextResponse, connection } from 'next/server'
import { walletHoldings, GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { resolveGmgnBoundWallets, boundAddressForChain } from '@/utils/gmgn-bound-wallets'


export async function GET(request: NextRequest) {
  await connection()
  try {
    if (!process.env.GMGN_API_KEY?.trim() || !process.env.GMGN_PRIVATE_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN keys not set' },
        { status: 503 },
      )
    }
    const chain = request.nextUrl.searchParams.get('chain')?.trim() ?? ''
    if (!isGmgnTradeChain(chain)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }
    const bound = boundAddressForChain(await resolveGmgnBoundWallets(), chain)
    const wallet =
      request.nextUrl.searchParams.get('wallet')?.trim() || bound || ''
    if (!wallet) {
      return NextResponse.json(
        { success: false, error: 'wallet / GMGN_BOUND_* required' },
        { status: 400 },
      )
    }
    const holdings = await walletHoldings({ chain, wallet, limit: 100 })
    return NextResponse.json({ success: true, holdings, wallet })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ success: false, error: msg }, { status })
  }
}
