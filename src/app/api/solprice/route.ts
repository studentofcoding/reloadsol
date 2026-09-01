import { NextResponse, connection } from 'next/server'
import { getSolPriceUSDCore, getCachedPriceInfo, warmSolPriceCacheFromRedis } from '../../../utils/sol-price-core'

// Request deduplication for concurrent requests
let ongoingRequest: Promise<{ price: number; source: string }> | null = null

export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    await connection()
    await warmSolPriceCacheFromRedis()
    const cachedInfo = getCachedPriceInfo();

    // Return cached data if it's still valid
    if (cachedInfo.cached && cachedInfo.expires_in > 0) {
      console.log(`Using cached SOL price from ${cachedInfo.source}, expires in ${cachedInfo.expires_in} seconds`);
      return NextResponse.json(
        cachedInfo,
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=30, stale-while-revalidate=5'
          }
        }
      )
    }

    // Deduplicate concurrent requests
    if (ongoingRequest) {
      console.log('Deduplicating concurrent SOL price request');
      const result = await ongoingRequest;
      return NextResponse.json({
        price: result.price,
        source: result.source,
        cached: false,
        deduplicated: true
      });
    }

    console.log('Cache expired, fetching fresh SOL price data');
    ongoingRequest = getSolPriceUSDCore();

    try {
      const result = await ongoingRequest;

      console.log(`Updated SOL price cache: $${result.price} from ${result.source}`);

      const updatedCachedInfo = getCachedPriceInfo();

      return NextResponse.json(
        {
          ...updatedCachedInfo,
          cached: false,
          cache_age: 0
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=30, stale-while-revalidate=5',
            'X-Price-Source': result.source
          }
        }
      );
    } finally {
      ongoingRequest = null;
    }
  } catch (error) {
    console.error('Error in SOL price endpoint:', error);

    // If cache exists but is expired, use it anyway during error
    const cachedInfo = getCachedPriceInfo();
    if (cachedInfo.price && cachedInfo.price !== 145) {
      return NextResponse.json(
        {
          ...cachedInfo,
          source: `emergency_${cachedInfo.source}`,
          cached: true,
          error: 'Failed to fetch fresh price data, using emergency cache'
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=5'
          }
        }
      )
    }

    // Fallback to default price if no cache is available
    return NextResponse.json(
      {
        price: 145,
        source: 'emergency_default',
        error: 'Failed to fetch SOL price',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=5'
        }
      }
    )
  }
}