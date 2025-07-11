import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const fromAmount = searchParams.get('fromAmount')
  const slippage = searchParams.get('slippage') ?? '5'
  const payer = searchParams.get('payer') ?? ''

  if (!from || !to || !fromAmount) {
    return NextResponse.json({ error: 'Missing query params' }, { status: 400 })
  }

  const url = `https://swap-v2.solanatracker.io/swap?from=${from}&to=${to}&fromAmount=${fromAmount}&slippage=${slippage}&payer=${payer}`

  try {
    const res = await fetch(url, { cache: 'no-store' })
    const raw = await res.text()
    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = { raw }
    }
    return NextResponse.json(payload, { status: res.status })
  } catch (err) {
    console.error('SolanaTracker proxy error:', err)
    return NextResponse.json({ error: 'Failed to fetch SolanaTracker quote' }, { status: 502 })
  }
} 