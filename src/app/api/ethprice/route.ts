import { NextResponse, connection } from 'next/server'
import { fetchBybitSpotLast } from '@/utils/bybit-spot'

const TTL_MS = 30_000
let cache: { price: number; at: number } | null = null
let inflight: Promise<number> | null = null

export async function GET() {
  await connection()
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) {
    return NextResponse.json(
      { price: cache.price, source: 'bybit', cached: true },
      { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=5' } },
    )
  }

  if (!inflight) {
    inflight = fetchBybitSpotLast('ETHUSDT').finally(() => {
      inflight = null
    })
  }
  const price = await inflight

  if (price > 0) {
    cache = { price, at: now }
    return NextResponse.json(
      { price, source: 'bybit', cached: false },
      { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=5' } },
    )
  }

  if (cache) {
    return NextResponse.json(
      { price: cache.price, source: 'bybit_stale', cached: true },
      { headers: { 'Cache-Control': 'public, max-age=5' } },
    )
  }

  return NextResponse.json({ price: 0, source: 'unavailable' })
}
