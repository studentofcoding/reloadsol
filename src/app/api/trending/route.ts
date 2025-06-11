import { NextResponse } from 'next/server'

interface JupiterBaseAsset {
  id: string
  name: string
  symbol: string
  icon: string
  decimals: number
  usdPrice: number
  stats1h: {
    priceChange: number
    numNetBuyers: number
    buyVolume: number
  }
  stats5m: {
    priceChange: number
  }
}

interface JupiterPool {
  id: string
  baseAsset: JupiterBaseAsset
  volume24h: number
}

interface JupiterResponse {
  pools: JupiterPool[]
}

interface TransformedToken {
  token_symbol: string
  token_address: string
  price: number
  change_1h: number
  change_5m: number
  volume_1h: number
  logo_url?: string
}

export async function GET() {
  try {
    const response = await fetch('https://datapi.jup.ag/v1/pools/toptrending/1h?minNumNetBuyers1h=1000', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
      // Ensure we're not using a stale response from the browser cache
      next: { revalidate: 300 } // 5 minutes in seconds
    })

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`)
    }

    const data = await response.json() as JupiterResponse
    
    // Transform the data to match our component's expected format
    const transformedTokens = data.pools.map((pool): TransformedToken => ({
      token_symbol: pool.baseAsset.symbol,
      token_address: pool.baseAsset.id,
      price: pool.baseAsset.usdPrice,
      change_1h: pool.baseAsset.stats1h.priceChange / 100, // Convert percentage to decimal
      change_5m: pool.baseAsset.stats5m.priceChange / 100, // Convert percentage to decimal
      volume_1h: pool.baseAsset.stats1h.buyVolume, // Using buyVolume as volume_1h
      logo_url: pool.baseAsset.icon
    }))
    
    // Filter out tokens with extreme negative price movement (less than -40%)
    const filteredTokens = transformedTokens.filter(token => token.change_5m > -0.4)
    
    // Deduplicate tokens by token_address
    const tokenMap = new Map<string, TransformedToken>()
    filteredTokens.forEach(token => {
      if (!tokenMap.has(token.token_address)) {
        tokenMap.set(token.token_address, token)
      }
    })
    
    const uniqueTokens = Array.from(tokenMap.values())
    
    return NextResponse.json(
      { tokens: uniqueTokens },
      {
        status: 200,
        headers: {
          // Set cache control to 5 minutes (300 seconds)
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
        }
      }
    )
  } catch (error) {
    console.error('Error fetching trending tokens:', error)
    return NextResponse.json(
      { error: 'Failed to fetch trending tokens', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
} 