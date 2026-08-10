import { NextRequest, NextResponse } from 'next/server'
import {
  buildKyberRoute,
  type KyberRouteSummary,
} from '@/utils/kyber-aggregator'


export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      routeSummary?: KyberRouteSummary
      sender?: string
      recipient?: string
      slippageTolerance?: number
    }
    if (!body.routeSummary || !body.sender || !body.recipient) {
      return NextResponse.json(
        {
          success: false,
          error: 'routeSummary, sender, recipient required',
        },
        { status: 400 },
      )
    }
    const build = await buildKyberRoute({
      routeSummary: body.routeSummary,
      sender: body.sender.trim(),
      recipient: body.recipient.trim(),
      slippageTolerance: body.slippageTolerance ?? 100,
    })
    return NextResponse.json({
      success: true,
      build: {
        data: build.data,
        routerAddress: build.routerAddress,
        amountIn: build.amountIn,
        amountOut: build.amountOut,
        valueWei: build.valueWei.toString(),
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
