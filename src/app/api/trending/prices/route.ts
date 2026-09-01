import { NextResponse, connection } from 'next/server'
import { cacheTag, cacheLife } from 'next/cache'
import { JupiterBaseAsset, JupiterPool, JupiterResponse } from '@/types'

interface TokenPrice {
  token_address: string
  price: number
  change_5m: number
}

/**
 * Cached upstream fetch + transform for Jupiter trending prices. `'use cache'`
 * (Next 16.3 Cache Components) makes the result reusable across requests and
 * invalidatable via `updateTag('trending-prices')`.
 */
async function getTrendingPricesCached(): Promise<TokenPrice[]> {
  'use cache'
  cacheTag('trending-prices')
  cacheLife('seconds')

  const TRENDING_URLS = [
    'https://datapi.jup.ag/v1/pools/toptrending/1h',
    // 'https://api.jup.ag/v1/pools/toptrending/1h',
  ]

  let response: Response | null = null

  for (const url of TRENDING_URLS) {
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
          'user-agent': 'reloadsol-bot/1.0 (+https://reloadsol.xyz)'
        }
      })

      if (response.ok) break

      if (response.status === 403 || response.status === 429) {
        // brief pause then try the next url
        await new Promise(res => setTimeout(res, 300))
        continue
      }

      throw new Error(`API responded with status: ${response.status}`)
    } catch (err) {
      // log and move to next url
      console.error(`Trending price fetch error from ${url}:`, err)
    }
  }

  if (!response || !response.ok) {
    throw new Error('All Jupiter trending API endpoints failed')
  }

  const data = await response.json() as JupiterResponse

  // Only extract the price information to keep the payload small
  const tokenPrices = data.pools.map((pool): TokenPrice => ({
    token_address: pool.baseAsset.id,
    price: pool.baseAsset.usdPrice,
    change_5m: pool.baseAsset.stats5m?.priceChange ? pool.baseAsset.stats5m.priceChange / 100 : 0, // Convert percentage to decimal if exists
  }))

  // Filter out tokens with extreme negative price movement (less than -40%)
  const filteredPrices = tokenPrices.filter(token => token.change_5m > -0.4)

  // Deduplicate tokens by token_address
  const priceMap = new Map<string, TokenPrice>()
  filteredPrices.forEach(token => {
    if (!priceMap.has(token.token_address)) {
      priceMap.set(token.token_address, token)
    }
  })

  return Array.from(priceMap.values())
}

export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    await connection()
    const uniquePrices = await getTrendingPricesCached()

    return NextResponse.json(
      { prices: uniquePrices },
      {
        status: 200,
        headers: {
          // Short cache time for price updates
          'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=5'
        }
      }
    )
  } catch (error) {
    console.error('Error fetching token prices:', error)
    return NextResponse.json(
      { error: 'Failed to fetch token prices', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
} 