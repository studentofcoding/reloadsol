import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    if (!body || !body.signed_tx) {
      return NextResponse.json({ error: 'signed_tx missing' }, { status: 400 })
    }

    // GMGN accepts signed swap transaction at this endpoint
    const gmgnUrl = 'https://gmgn.ai/defi/router/v1/sol/tx/submit_signed_transaction'
    const gmgnResp = await fetch(gmgnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    })

    const rawBody = await gmgnResp.text()
    let payload: any
    try {
      payload = JSON.parse(rawBody)
    } catch (_) {
      payload = { raw: rawBody }
    }

    if (!gmgnResp.ok) {
      return NextResponse.json({ error: 'GMGN submit failed', details: payload }, { status: gmgnResp.status })
    }

    return NextResponse.json(payload, { status: gmgnResp.status })
  } catch (err) {
    console.error('GMGN submit proxy error:', err)
    return NextResponse.json({ error: 'Failed to submit GMGN tx' }, { status: 502 })
  }
} 