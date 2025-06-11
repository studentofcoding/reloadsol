import { NextResponse } from 'next/server'

interface JupiterBaseAsset {
  id: string
  usdPrice: number
  stats5m: {
    priceChange: number
  }
}

interface JupiterPool {
  id: string
  baseAsset: JupiterBaseAsset
}

interface JupiterResponse {
  pools: JupiterPool[]
}

interface TokenPrice {
  token_address: string
  price: number
  change_5m: number
}

export async function GET() {
  try {
    const response = await fetch('https://datapi.jup.ag/v1/pools/toptrending/1h?minNumNetBuyers1h=1000', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
      // Short revalidation time for price updates
      next: { revalidate: 10 } // 10 seconds
    })

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`)
    }

    const data = await response.json() as JupiterResponse
    
    // Only extract the price information to keep the payload small
    const tokenPrices = data.pools.map((pool): TokenPrice => ({
      token_address: pool.baseAsset.id,
      price: pool.baseAsset.usdPrice,
      change_5m: pool.baseAsset.stats5m.priceChange / 100, // Convert percentage to decimal
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
    
    const uniquePrices = Array.from(priceMap.values())
    
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