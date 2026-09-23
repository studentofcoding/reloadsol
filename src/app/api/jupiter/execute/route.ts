import { NextRequest, NextResponse } from 'next/server'
import {
  executeJupiterSwapDirect,
  JupiterSwapQuoteError,
} from '@/utils/jupiter-swap-quote'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      signedTransaction?: unknown
      requestId?: unknown
    }

    if (
      typeof body.signedTransaction !== 'string' ||
      body.signedTransaction.length === 0 ||
      typeof body.requestId !== 'string' ||
      body.requestId.length === 0
    ) {
      return NextResponse.json(
        { error: 'signedTransaction and requestId are required' },
        { status: 400 },
      )
    }

    const start = Date.now()
    const result = await executeJupiterSwapDirect({
      signedTransaction: body.signedTransaction,
      requestId: body.requestId,
    })

    return NextResponse.json(
      { ...result, status: 'Success', latencyMs: Date.now() - start },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    console.error('Jupiter swap execute proxy error:', error)
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
