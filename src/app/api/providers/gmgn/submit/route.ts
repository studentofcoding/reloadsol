import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    if (!body || !body.signed_tx) {
      return NextResponse.json({ error: 'signed_tx missing' }, { status: 400 })
    }

    // GMGN expects { chain: 'sol', signedTx: <base64> }
    const gmgnUrl = 'https://gmgn.ai/txproxy/v1/send_transaction'
    const gmgnPayload = {
      chain: 'sol',
      signedTx: body.signed_tx
    }
    const gmgnResp = await fetch(gmgnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gmgnPayload),
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
      // Log full error details for debugging
      console.error('[GMGN SUBMIT ERROR]', {
        status: gmgnResp.status,
        statusText: gmgnResp.statusText,
        headers: Object.fromEntries(gmgnResp.headers.entries()),
        body: rawBody,
        request: body
      })
      return NextResponse.json({ error: 'GMGN submit failed', details: payload, status: gmgnResp.status, statusText: gmgnResp.statusText, headers: Object.fromEntries(gmgnResp.headers.entries()), body: rawBody }, { status: gmgnResp.status })
    }

    return NextResponse.json(payload, { status: gmgnResp.status })
  } catch (err) {
    console.error('GMGN submit proxy error:', err)
    return NextResponse.json({ error: 'Failed to submit GMGN tx' }, { status: 502 })
  }
} 