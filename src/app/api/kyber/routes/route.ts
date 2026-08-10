import { NextRequest, NextResponse } from 'next/server'
import { fetchKyberRoute } from '@/utils/kyber-aggregator'


export async function GET(request: NextRequest) {
  try {
    const tokenIn = request.nextUrl.searchParams.get('tokenIn')?.trim() ?? ''
    const tokenOut = request.nextUrl.searchParams.get('tokenOut')?.trim() ?? ''
    const amountIn = request.nextUrl.searchParams.get('amountIn')?.trim() ?? ''
    if (!tokenIn || !tokenOut || !amountIn) {
      return NextResponse.json(
        { success: false, error: 'tokenIn, tokenOut, amountIn required' },
        { status: 400 },
      )
    }
    const route = await fetchKyberRoute({ tokenIn, tokenOut, amountIn })
    return NextResponse.json({ success: true, route })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
