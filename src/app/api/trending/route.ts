import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'

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
  mcap: number
  organicScore: number
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
  mcap: number
  logo_url?: string
  organic_score: number
  last_updated?: number
  price_change?: number // Price change since last update
}

// Cache structure to store tokens with a timestamp
interface TokenCache {
  tokens: Map<string, TransformedToken>; // Using Map for O(1) lookups by token_address
  timestamp: number;
  expiresAt: number;
  lastFullRefresh: number;
}

// In-memory cache with 5-minute expiry
let tokenCache: TokenCache = {
  tokens: new Map<string, TransformedToken>(),
  timestamp: 0,
  expiresAt: 0,
  lastFullRefresh: 0
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
const FULL_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

export async function GET(request: NextRequest) {
  try {
    const currentTime = Date.now();
    
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const skipCache = searchParams.get('nocache') === 'true';
    
    const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS || forceRefresh;
    
    // Return cached data if it's still valid and doesn't need a full refresh
    if (tokenCache.tokens.size > 0 && currentTime < tokenCache.expiresAt && !needsFullRefresh && !skipCache) {
      console.log('Using cached token data, expires in', Math.round((tokenCache.expiresAt - currentTime) / 1000), 'seconds');
      return NextResponse.json(
        { 
          tokens: Array.from(tokenCache.tokens.values()),
          cached: true,
          cache_age: Math.round((currentTime - tokenCache.timestamp) / 1000),
          expires_in: Math.round((tokenCache.expiresAt - currentTime) / 1000)
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
          }
        }
      )
    }
    
    console.log(needsFullRefresh ? 'Performing full refresh' : 'Updating token cache');
    const response = await fetch('https://datapi.jup.ag/v1/pools/toptrending/1h', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
      // Ensure we're not using a stale response from the browser cache
      next: { revalidate: 0 } // Force fresh data from API
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
      change_1h: (pool.baseAsset.stats1h?.priceChange ?? 0) / 100, // Convert percentage to decimal, default to 0 if missing
      change_5m: (pool.baseAsset.stats5m?.priceChange ?? 0) / 100, // Convert percentage to decimal, default to 0 if missing
      volume_1h: pool.baseAsset.stats1h.buyVolume, // Using buyVolume as volume_1h
      mcap: pool.baseAsset.mcap,
      logo_url: pool.baseAsset.icon,
      organic_score: pool.baseAsset.organicScore,
      last_updated: currentTime
    }))
    
    // Filter out tokens with extreme negative price movement (less than -40%) and low organic score
    const filteredTokens = transformedTokens.filter(token => 
      token.change_5m > -0.4 && 
      token.organic_score >= 70.0 &&
      token.mcap > 300000 &&
      token.mcap < 2000000
    )
    
    // If doing a full refresh, reset the cache
    if (needsFullRefresh) {
      tokenCache.tokens = new Map<string, TransformedToken>();
      tokenCache.lastFullRefresh = currentTime;
      console.log('Cache fully refreshed');
    }
    
    // Track changes for reporting
    const stats = {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      price_increased: 0,
      price_decreased: 0
    };
    
    // Create a set of current token addresses for comparison
    const currentTokenAddresses = new Set<string>();
    filteredTokens.forEach(token => {
      currentTokenAddresses.add(token.token_address);
      
      const existingToken = tokenCache.tokens.get(token.token_address);
      if (!existingToken) {
        // New token, add to cache
        tokenCache.tokens.set(token.token_address, token);
        stats.added++;
      } else {
        // Compare relevant fields to see if an update is needed
        if (
          token.price !== existingToken.price ||
          token.change_1h !== existingToken.change_1h ||
          token.change_5m !== existingToken.change_5m ||
          token.volume_1h !== existingToken.volume_1h ||
          token.mcap !== existingToken.mcap ||
          token.organic_score !== existingToken.organic_score
        ) {
          // Calculate price change percentage for tracking
          const priceChange = existingToken.price > 0 
            ? (token.price - existingToken.price) / existingToken.price 
            : 0;
          
          // Track price movement direction
          if (token.price > existingToken.price) {
            stats.price_increased++;
          } else if (token.price < existingToken.price) {
            stats.price_decreased++;
          }
          
          // Update only the changed token
          tokenCache.tokens.set(token.token_address, {
            ...existingToken,
            price: token.price,
            change_1h: token.change_1h,
            change_5m: token.change_5m,
            volume_1h: token.volume_1h,
            mcap: token.mcap,
            organic_score: token.organic_score,
            last_updated: currentTime,
            price_change: priceChange
          });
          stats.updated++;
        } else {
          stats.unchanged++;
        }
      }
    });
    
    // Remove tokens that are no longer in the results
    if (!needsFullRefresh) {
      // Only perform removals during incremental updates
      // During full refresh we already cleared the cache
      for (const address of Array.from(tokenCache.tokens.keys())) {
        if (!currentTokenAddresses.has(address)) {
          tokenCache.tokens.delete(address);
          stats.removed++;
        }
      }
    }
    
    // Update the cache timestamp and expiry
    tokenCache.timestamp = currentTime;
    tokenCache.expiresAt = currentTime + CACHE_TTL_MS;
    
    console.log(`Token cache updated: ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed, ${stats.unchanged} unchanged`);
    console.log(`Price movements: ${stats.price_increased} increased, ${stats.price_decreased} decreased`);
    
    const tokenArray = Array.from(tokenCache.tokens.values());
    
    // Sort tokens by criteria - prioritize tokens with highest organic score and recent price change
    tokenArray.sort((a, b) => {
      // First by organic score (descending)
      if (b.organic_score !== a.organic_score) {
        return b.organic_score - a.organic_score;
      }
      // Then by absolute price change in the last hour (descending)
      return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0);
    });
    
    return NextResponse.json(
      { 
        tokens: tokenArray,
        cached: false,
        cache_age: 0,
        expires_in: CACHE_TTL_MS / 1000,
        stats,
        last_updated: currentTime,
        next_full_refresh: tokenCache.lastFullRefresh + FULL_REFRESH_INTERVAL_MS
      },
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