import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const tokenIn = searchParams.get('token_in_address')
  const tokenOut = searchParams.get('token_out_address')
  const inAmount = searchParams.get('in_amount')
  const fromAddress = searchParams.get('from_address')
  const slippage = searchParams.get('slippage') || '0.02'

  if (!tokenIn || !tokenOut || !inAmount || !fromAddress) {
    return NextResponse.json({ error: 'Missing required query parameters' }, { status: 400 })
  }

  const gmgnUrl = `https://gmgn.ai/defi/router/v1/sol/tx/get_swap_route?token_in_address=${tokenIn}&token_out_address=${tokenOut}&in_amount=${inAmount}&from_address=${fromAddress}&slippage=${slippage}&fee=0`

  try {
    const res = await fetch(gmgnUrl, { cache: 'no-store' })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('GMGN proxy error:', err)
    return NextResponse.json({ error: 'Failed to fetch GMGN quote' }, { status: 502 })
  }
} 