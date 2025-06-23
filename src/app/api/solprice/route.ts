import { NextResponse } from 'next/server'

// Cache structure for SOL price data
interface PriceCache {
  price: number;
  timestamp: number;
  expiresAt: number;
  source: string;
}

// Default SOL price in case all APIs fail
const DEFAULT_SOL_PRICE_USD = 145;

// In-memory cache with 30-second expiry
let priceCache: PriceCache = {
  price: DEFAULT_SOL_PRICE_USD,
  timestamp: 0,
  expiresAt: 0,
  source: 'default'
};

// Cache TTL in milliseconds (30 seconds)
const CACHE_TTL_MS = 30 * 1000;

// Rate limiting state for each API
interface RateLimitState {
  lastRequestTime: number;
  consecutiveErrors: number;
  backoffUntil: number;
}

const rateLimitStates = {
  coingecko: { lastRequestTime: 0, consecutiveErrors: 0, backoffUntil: 0 },
  birdeye: { lastRequestTime: 0, consecutiveErrors: 0, backoffUntil: 0 },
  jupiter: { lastRequestTime: 0, consecutiveErrors: 0, backoffUntil: 0 }
};

// Configuration for each API
const API_CONFIG = {
  coingecko: {
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    minInterval: 1000, // 1 second between requests
    maxBackoff: 60000, // 1 minute max backoff
    timeout: 5000
  },
  birdeye: {
    url: 'https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112',
    minInterval: 500, // 0.5 seconds between requests  
    maxBackoff: 30000, // 30 seconds max backoff
    timeout: 5000
  },
  jupiter: {
    url: 'https://api.jup.ag/price/v1?ids=So11111111111111111111111111111111111111112',
    minInterval: 2000, // 2 seconds between requests (most conservative)
    maxBackoff: 120000, // 2 minutes max backoff
    timeout: 8000
  }
};

// Utility function to implement exponential backoff
function calculateBackoff(consecutiveErrors: number, maxBackoff: number): number {
  const baseDelay = 1000; // 1 second base
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, consecutiveErrors), maxBackoff);
  const jitter = Math.random() * 0.1 * exponentialDelay; // Add 10% jitter
  return exponentialDelay + jitter;
}

// Generic API fetch with rate limiting and error handling
async function fetchWithRateLimit(
  apiName: keyof typeof API_CONFIG,
  parseResponse: (data: any) => number
): Promise<{ price: number; source: string } | null> {
  const config = API_CONFIG[apiName];
  const state = rateLimitStates[apiName];
  const now = Date.now();

  // Check if we're in backoff period
  if (now < state.backoffUntil) {
    console.log(`${apiName} in backoff until ${new Date(state.backoffUntil).toISOString()}`);
    return null;
  }

  // Enforce minimum interval between requests
  const timeSinceLastRequest = now - state.lastRequestTime;
  if (timeSinceLastRequest < config.minInterval) {
    const waitTime = config.minInterval - timeSinceLastRequest;
    console.log(`Rate limiting ${apiName}, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  try {
    console.log(`Fetching SOL price from ${apiName}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);
    
    state.lastRequestTime = Date.now();
    
    const response = await fetch(config.url, {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'BuyBulk/1.0'
      },
      signal: controller.signal,
      next: { revalidate: 0 }
    });

    clearTimeout(timeoutId);

    if (response.status === 429) {
      console.warn(`Rate limited by ${apiName} API`);
      state.consecutiveErrors++;
      state.backoffUntil = Date.now() + calculateBackoff(state.consecutiveErrors, config.maxBackoff);
      return null;
    }

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json();
    const price = parseResponse(data);
    
    if (!price || price <= 0) {
      throw new Error('Invalid price data received');
    }

    // Reset error count on success
    state.consecutiveErrors = 0;
    state.backoffUntil = 0;
    
    console.log(`Successfully fetched SOL price from ${apiName}: $${price}`);
    return { price, source: apiName };

  } catch (error) {
    console.error(`Error fetching from ${apiName}:`, error);
    
    // Increase error count and set backoff
    state.consecutiveErrors++;
    state.backoffUntil = Date.now() + calculateBackoff(state.consecutiveErrors, config.maxBackoff);
    
    return null;
  }
}

// SOL price fetching with intelligent fallback
async function getSolPriceUSD(): Promise<{ price: number; source: string }> {
  // Try CoinGecko first
  const coingeckoResult = await fetchWithRateLimit('coingecko', (data) => data?.solana?.usd);
  if (coingeckoResult) return coingeckoResult;

  // Try Birdeye second
  const birdeyeResult = await fetchWithRateLimit('birdeye', (data) => data?.data?.value);
  if (birdeyeResult) return birdeyeResult;

  // Try Jupiter last
  const jupiterResult = await fetchWithRateLimit('jupiter', (data) => {
    const solData = data?.data?.So11111111111111111111111111111111111111112;
    return solData?.price;
  });
  if (jupiterResult) return jupiterResult;

  // All APIs failed, use cached or default price
  if (priceCache.price && priceCache.price !== DEFAULT_SOL_PRICE_USD) {
    console.warn('All APIs failed, using stale cached price');
    return { price: priceCache.price, source: 'stale_cache' };
  }

  console.warn('All APIs failed, using default price');
  return { price: DEFAULT_SOL_PRICE_USD, source: 'default' };
}

export async function GET() {
  try {
    const currentTime = Date.now();
    
    // Return cached data if it's still valid
    if (currentTime < priceCache.expiresAt) {
      console.log(`Using cached SOL price from ${priceCache.source}, expires in ${Math.round((priceCache.expiresAt - currentTime) / 1000)} seconds`);
      return NextResponse.json(
        { 
          price: priceCache.price,
          source: priceCache.source,
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
    
    console.log('Cache expired, fetching fresh SOL price data');
    const result = await getSolPriceUSD();
    
    // Update the cache
    priceCache = {
      price: result.price,
      source: result.source,
      timestamp: currentTime,
      expiresAt: currentTime + CACHE_TTL_MS
    };
    
    return NextResponse.json(
      { 
        price: result.price,
        source: result.source,
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
    console.error('Error in SOL price endpoint:', error);
    
    // If cache exists but is expired, use it anyway during error
    if (priceCache.price) {
      return NextResponse.json(
        { 
          price: priceCache.price,
          source: priceCache.source + '_emergency',
          cached: true,
          error: 'Failed to fetch fresh price data, using emergency cache',
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