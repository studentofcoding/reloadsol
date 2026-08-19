import { NextRequest, NextResponse } from 'next/server'
import { getRhRpcUrls } from '@/utils/dlmm/rh-univ2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
}

/**
 * Server-side proxy for Robinhood Chain (4663) JSON-RPC.
 *
 * Public RH RPCs may not send CORS headers (e.g. ArrowRPC), so browser-side
 * viem public clients cannot call them directly. All reads go through this
 * route; the upstream call happens server-to-server where CORS does not
 * apply. Tries each configured endpoint in order and fails over on error.
 */
export async function POST(request: NextRequest) {
  const body = await request.text()
  const upstreams = getRhRpcUrls()

  let lastError: string | null = null
  for (const upstream of upstreams) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15_000)

      const res = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const text = await res.text()
      // Only fail over on transport/5xx errors — 4xx responses from a live
      // endpoint (e.g. bad request) should surface as-is.
      if (res.ok || res.status < 500) {
        return new NextResponse(text, {
          status: res.status,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
          },
        })
      }
      lastError = `HTTP ${res.status} from ${upstream}: ${text.slice(0, 200)}`
    } catch (err) {
      lastError = `${upstream}: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return NextResponse.json(
    {
      error: 'RH RPC request failed',
      details: lastError ?? 'All RH RPC endpoints failed',
    },
    { status: 502, headers: CORS_HEADERS },
  )
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: CORS_HEADERS })
}
