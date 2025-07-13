import { NextResponse } from 'next/server'
import { fetchTrendingPools } from '@/utils/jupiter-api'

export async function GET() {
  try {
    const data = await fetchTrendingPools()
    
    // Extract and process token prices
    const tokenPrices = data.pools.map(pool => ({
      token_address: pool.baseAsset.id,
      token_symbol: pool.baseAsset.symbol,
      price_usd: pool.baseAsset.usdPrice,
      change_1h: pool.baseAsset.stats1h.priceChange / 100,
      change_5m: pool.baseAsset.stats5m.priceChange / 100,
      volume_1h: pool.baseAsset.stats1h.buyVolume,
      mcap: pool.baseAsset.mcap,
      organic_score: pool.baseAsset.organicScore,
      logo_url: pool.baseAsset.icon
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
      timestamp: new Date().toISOString()
    }, {
      headers: {
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=30'
      }
    })
  } catch (error) {
    console.error('Error fetching trending token prices:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: 'Failed to fetch trending token prices',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}