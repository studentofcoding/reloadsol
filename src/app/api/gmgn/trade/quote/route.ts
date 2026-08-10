import { NextRequest, NextResponse } from 'next/server'
import { tradeQuote, GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { resolveGmgnBoundWallets, boundAddressForChain } from '@/utils/gmgn-bound-wallets'


export async function POST(request: NextRequest) {
  try {
    if (!process.env.GMGN_API_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN_API_KEY is not set' },
        { status: 503 },
      )
    }
    const body = (await request.json()) as {
      chain?: string
      from?: string
      inputToken?: string
      outputToken?: string
      amount?: string
      slippage?: number
    }
    const chain = body.chain?.trim() ?? ''
    if (!isGmgnTradeChain(chain)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }
    const bound = boundAddressForChain(await resolveGmgnBoundWallets(), chain)
    const from = (body.from?.trim() || bound || '').trim()
    if (!from) {
      return NextResponse.json(
        { success: false, error: 'from address required (or set GMGN_BOUND_* env)' },
        { status: 400 },
      )
    }
    if (!body.inputToken || !body.outputToken || !body.amount) {
      return NextResponse.json(
        { success: false, error: 'inputToken, outputToken, amount required' },
        { status: 400 },
      )
    }
    const quote = await tradeQuote({
      chain,
      from,
      inputToken: body.inputToken,
      outputToken: body.outputToken,
      amount: body.amount,
      slippage: body.slippage ?? 1,
    })
    return NextResponse.json({ success: true, quote, from })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ success: false, error: msg }, { status })
  }
}
