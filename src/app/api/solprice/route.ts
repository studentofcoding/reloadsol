import { NextResponse } from 'next/server'

// Cache structure for SOL price data
interface PriceCache {
  price: number;
  timestamp: number;
  expiresAt: number;
}

// Default SOL price in case API fails
const DEFAULT_SOL_PRICE_USD = 145;

// In-memory cache with 30-second expiry
let priceCache: PriceCache = {
  price: DEFAULT_SOL_PRICE_USD,
  timestamp: 0,
  expiresAt: 0
};

// Cache TTL in milliseconds (30 seconds)
const CACHE_TTL_MS = 30 * 1000;

export async function GET() {
  try {
    const currentTime = Date.now();
    
    // Return cached data if it's still valid
    if (currentTime < priceCache.expiresAt) {
      console.log('Using cached SOL price, expires in', Math.round((priceCache.expiresAt - currentTime) / 1000), 'seconds');
      return NextResponse.json(
        { 
          price: priceCache.price,
          cached: true,
          cache_age: Math.round((currentTime - priceCache.timestamp) / 1000),
          expires_in: Math.round((priceCache.expiresAt - currentTime) / 1000)
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, max-age=30, stale-while-revalidate=5'
          }
        }
      )
    }
    
    console.log('Fetching fresh SOL price data');
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
      next: { revalidate: 0 } // Force fresh data from API
    });

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract the SOL price from the response
    const solPrice = data?.solana?.usd || DEFAULT_SOL_PRICE_USD;
    
    // Update the cache
    priceCache = {
      price: solPrice,
      timestamp: currentTime,
      expiresAt: currentTime + CACHE_TTL_MS
    };
    
    return NextResponse.json(
      { 
        price: solPrice,
        cached: false,
        timestamp: currentTime,
        expires_in: CACHE_TTL_MS / 1000
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=30, stale-while-revalidate=5'
        }
      }
    )
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    
    // If cache exists but is expired, use it anyway during error
    if (priceCache.price) {
      return NextResponse.json(
        { 
          price: priceCache.price, 
          cached: true,
          error: 'Failed to fetch fresh price data, using expired cache',
          cache_age: Math.round((Date.now() - priceCache.timestamp) / 1000)
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
        price: DEFAULT_SOL_PRICE_USD, 
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