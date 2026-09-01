import { NextRequest, connection } from 'next/server'
import {
  OPEN_PRICES_CHANNEL,
  type OpenPriceEvent,
} from '@/utils/open-position-prices'
import { subscribeJson } from '@/utils/redis-cache'

function isOpenPriceEvent(v: unknown): v is OpenPriceEvent {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.mint === 'string' &&
    typeof o.price === 'number' &&
    Number.isFinite(o.price) &&
    o.price > 0
  )
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  await connection()
  const mintFilter = new Set(
    (request.nextUrl.searchParams.get('mints') || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  )

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }

      send(`: connected\n\n`)

      heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`)
      }, 15_000)

      unsubscribe = await subscribeJson(OPEN_PRICES_CHANNEL, (payload) => {
        if (!isOpenPriceEvent(payload)) return
        if (mintFilter.size > 0 && !mintFilter.has(payload.mint)) return
        send(`data: ${JSON.stringify(payload)}\n\n`)
      })

      request.signal.addEventListener('abort', () => {
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe?.()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
