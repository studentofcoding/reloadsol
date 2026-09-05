import { NextRequest, NextResponse, connection } from 'next/server'
import {
  locateTokenByAddress,
  normalizeLookupAddress,
  type TokenLocateResult,
} from '@/strategies/token-locate'
import { isGmgnTradeChain } from '@/utils/gmgn-currencies'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const CACHE_TTL_SECONDS = 60
const CACHE_KEY_PREFIX = 'token-locate:'

function cacheKey(address: string, chain: string): string {
  return `${CACHE_KEY_PREFIX}${chain}:${normalizeLookupAddress(address)}`
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim()
    const refresh = searchParams.get('refresh') === 'true'
    const chainRaw = searchParams.get('chain')?.trim() || 'sol'
    if (!isGmgnTradeChain(chainRaw)) {
      return NextResponse.json(
        { success: false, error: 'chain must be sol or robinhood' },
        { status: 400 },
      )
    }
    const chain = chainRaw

    if (!address) {
      return NextResponse.json({ success: false, error: 'address is required' }, { status: 400 })
    }

    const cacheKeyValue = cacheKey(address, chain)
    if (!refresh) {
      const cached = await cacheGet<TokenLocateResult>(cacheKeyValue)
      if (cached) {
        return NextResponse.json({ success: true, ...cached, cached: true })
      }
    }

    const result = await locateTokenByAddress(address, { chain })
    await cacheSet(cacheKeyValue, result, CACHE_TTL_SECONDS)

    return NextResponse.json({ success: true, ...result, cached: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'Invalid token address') {
      return NextResponse.json({ success: false, error: message }, { status: 400 })
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
