import { NextResponse } from 'next/server'
import { fetchFilteredTrendingPools } from '@/utils/jupiter-api'

export async function GET() {
  try {
    const pools = await fetchFilteredTrendingPools({
      minBuyers: 1000,
      minMcap: 300000,
      maxMcap: 2000000,
      minOrganicScore: 70.0,
      maxPriceChange5m: -0.4
    })
    
    // Extract and process token prices
    const tokenPrices = pools.map(pool => ({
      token_address: pool.baseAsset.id,
      token_symbol: pool.baseAsset.symbol,
      price_usd: pool.baseAsset.usdPrice,
      change_1h: pool.baseAsset.stats1h.priceChange / 100,
      change_5m: pool.baseAsset.stats5m.priceChange / 100,
      volume_1h: pool.baseAsset.stats1h.buyVolume,
      mcap: pool.baseAsset.mcap,
      organic_score: pool.baseAsset.organicScore,
      logo_url: pool.baseAsset.icon,
      net_buyers_1h: pool.baseAsset.stats1h.numNetBuyers
    }))

    // Remove duplicates based on token_address
    const uniquePrices = tokenPrices.reduce((acc, current) => {
      const existing = acc.find(item => item.token_address === current.token_address)
      if (!existing) {
        acc.push(current)
      }
      return acc
    }, [] as typeof tokenPrices)

    return NextResponse.json({
      success: true,
      data: uniquePrices,
      count: uniquePrices.length,
      filters_applied: {
        min_buyers: 1000,
        min_mcap: 300000,
        max_mcap: 2000000,
        min_organic_score: 70.0,
        max_price_change_5m: -40
      },
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=30'
      }
    })
  } catch (error) {
    console.error('Error fetching trending tokens with 1000+ buyers:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch trending tokens with 1000+ buyers',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}