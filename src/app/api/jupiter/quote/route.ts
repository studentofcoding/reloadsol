import { NextRequest, NextResponse, connection } from 'next/server'
import { PublicKey } from '@solana/web3.js'
import {
  fetchJupiterSwapQuoteDirect,
  JupiterSwapQuoteError,
} from '@/utils/jupiter-swap-quote'

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const inputMint = searchParams.get('inputMint')
    const outputMint = searchParams.get('outputMint')
    const amount = searchParams.get('amount')
    const slippageBps = Number.parseInt(
      searchParams.get('slippageBps') ?? '200',
      10,
    )
    const taker = searchParams.get('taker') ?? undefined

    if (!inputMint || !outputMint || !amount) {
      return NextResponse.json(
        { error: 'inputMint, outputMint, and amount are required' },
        { status: 400 },
      )
    }

    try {
      new PublicKey(inputMint)
      new PublicKey(outputMint)
      if (taker) new PublicKey(taker)
    } catch {
      return NextResponse.json(
        { error: 'Invalid mint or wallet address' },
        { status: 400 },
      )
    }

    if (!/^\d+$/.test(amount) || Number(amount) <= 0) {
      return NextResponse.json(
        { error: 'amount must be a positive integer (smallest units)' },
        { status: 400 },
      )
    }

    const start = Date.now()
    const quote = await fetchJupiterSwapQuoteDirect({
      inputMint,
      outputMint,
      amount,
      slippageBps: Number.isFinite(slippageBps) ? slippageBps : 200,
      taker,
    })

    return NextResponse.json(
      { ...quote, latencyMs: Date.now() - start },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    console.error('Jupiter swap quote proxy error:', error)
    if (error instanceof JupiterSwapQuoteError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode ?? 502 },
      )
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 },
    )
  }
}
