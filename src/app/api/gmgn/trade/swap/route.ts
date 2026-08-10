import { NextRequest, NextResponse } from 'next/server'
import { tradeSwap, GmgnApiError } from '@/utils/gmgn-api'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { resolveGmgnBoundWallets, boundAddressForChain } from '@/utils/gmgn-bound-wallets'


export async function POST(request: NextRequest) {
  try {
    if (!process.env.GMGN_API_KEY?.trim() || !process.env.GMGN_PRIVATE_KEY?.trim()) {
      return NextResponse.json(
        { success: false, error: 'GMGN_API_KEY / GMGN_PRIVATE_KEY not set' },
        { status: 503 },
      )
    }
    const body = (await request.json()) as {
      confirmed?: boolean
      chain?: string
      from?: string
      inputToken?: string
      outputToken?: string
      amount?: string
      slippage?: number
      autoSlippage?: boolean
      percent?: number
    }
    if (body.confirmed !== true) {
      return NextResponse.json(
        { success: false, error: 'confirmed: true required' },
        { status: 400 },
      )
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
    if (!from || !bound) {
      return NextResponse.json(
        { success: false, error: 'GMGN bound wallet not configured for chain' },
        { status: 400 },
      )
    }
    const fromNorm = chain === 'sol' ? from : from.toLowerCase()
    const boundNorm = chain === 'sol' ? bound : bound.toLowerCase()
    if (fromNorm !== boundNorm) {
      return NextResponse.json(
        { success: false, error: 'from must match GMGN-bound address for this chain' },
        { status: 403 },
      )
    }
    if (!body.inputToken || !body.outputToken) {
      return NextResponse.json(
        { success: false, error: 'inputToken and outputToken required' },
        { status: 400 },
      )
    }
    if (body.percent == null && !body.amount) {
      return NextResponse.json(
        { success: false, error: 'amount or percent required' },
        { status: 400 },
      )
    }
    const result = await tradeSwap({
      chain,
      from: fromNorm,
      inputToken: body.inputToken,
      outputToken: body.outputToken,
      amount: body.amount ?? '0',
      slippage: body.slippage,
      autoSlippage: body.autoSlippage,
      percent: body.percent,
    })
    return NextResponse.json({ success: true, result })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    const status = error instanceof GmgnApiError && error.code === 'RATE_LIMIT' ? 429 : 500
    return NextResponse.json({ success: false, error: msg }, { status })
  }
}
