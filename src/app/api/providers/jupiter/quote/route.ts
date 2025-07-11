import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const inputMint = searchParams.get('inputMint')
  const outputMint = searchParams.get('outputMint')
  const amount = searchParams.get('amount')
  const slippageBps = searchParams.get('slippageBps') ?? '100'

  if (!inputMint || !outputMint || !amount) {
    return NextResponse.json({ error: 'Missing required query parameters' }, { status: 400 })
  }

  const jupUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`

  try {
    const res = await fetch(jupUrl, { cache: 'no-store' })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('Jupiter proxy error:', err)
    return NextResponse.json({ error: 'Failed to fetch Jupiter quote' }, { status: 502 })
  }
} 