import { NextRequest, NextResponse, connection } from 'next/server'
import { locateTokenByAddress, type TokenLocateResult } from '@/strategies/token-locate'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CACHE_TTL_SECONDS = 60
const CACHE_KEY_PREFIX = 'token-locate:'

function cacheKey(address: string): string {
  return `${CACHE_KEY_PREFIX}${address}`
}

export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim()
    const refresh = searchParams.get('refresh') === 'true'

    if (!address) {
      return NextResponse.json({ success: false, error: 'address is required' }, { status: 400 })
    }

    if (!refresh) {
      const cached = await cacheGet<TokenLocateResult>(cacheKey(address))
      if (cached) {
        return NextResponse.json({ success: true, ...cached, cached: true })
      }
    }

    const result = await locateTokenByAddress(address)
    await cacheSet(cacheKey(address), result, CACHE_TTL_SECONDS)

    return NextResponse.json({ success: true, ...result, cached: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'Invalid token address') {
      return NextResponse.json({ success: false, error: message }, { status: 400 })
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
