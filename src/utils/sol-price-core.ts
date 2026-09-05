import { getTokenPrice } from './jupiter-api'
import { cacheGet, cacheSet } from './redis-cache'
import { fetchBybitSpotLast } from './bybit-spot'

const SOL_PRICE_REDIS_KEY = 'sol:price'
const SOL_PRICE_REDIS_TTL_SECONDS = 30

// Cache structure for SOL price data
interface PriceCache {
  price: number;
  timestamp: number;
  expiresAt: number;
  source: string;
  originalSource: string;
}

// Default SOL price in case all APIs fail
const DEFAULT_SOL_PRICE_USD = 145;

// In-memory cache with 30-second expiry
let priceCache: PriceCache = {
  price: DEFAULT_SOL_PRICE_USD,
  timestamp: 0,
  expiresAt: 0,
  source: 'default',
  originalSource: 'default'
};

// Cache TTL in milliseconds (30 seconds for fresh, 5 minutes for stale)
const CACHE_TTL_MS = 30 * 1000;
const STALE_CACHE_TTL_MS = 5 * 60 * 1000;

// Rate limiting state for each API
interface RateLimitState {
  lastRequestTime: number;
  consecutiveErrors: number;
  backoffUntil: number;
}

const rateLimitStates: Record<keyof typeof API_CONFIG, RateLimitState> = {
  coingecko: { lastRequestTime: 0, consecutiveErrors: 0, backoffUntil: 0 },
  jupiter: { lastRequestTime: 0, consecutiveErrors: 0, backoffUntil: 0 }
};

// Configuration for each API
type ApiConfig = {
  url?: string;
  minInterval: number;
  maxBackoff: number;
  timeout: number;
  requiresAuth: boolean;
  headers?: Record<string, string>;
};

const API_CONFIG: Record<string, ApiConfig> = {
  coingecko: {
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    minInterval: 1000, // 1 second between requests
    maxBackoff: 60000, // 1 minute max backoff
    timeout: 5000,
    requiresAuth: false
  },
  jupiter: {
    // No URL needed - using Jupiter API utility
    minInterval: 2000, // 2 seconds between requests (most conservative)
    maxBackoff: 120000, // 2 minutes max backoff
    timeout: 8000,
    requiresAuth: false
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
    state.lastRequestTime = Date.now();

    let price: number;

    if (apiName === 'jupiter') {
      // Use the Jupiter API utility for Jupiter requests
      price = await getTokenPrice('So11111111111111111111111111111111111111112');
      if (!price) {
        throw new Error('Jupiter API returned null price');
      }
    } else {
      // For other APIs, use the standard fetch approach
      if (!config.url) {
        throw new Error(`No URL configured for ${apiName}`);
      }

      // Use direct fetch for other APIs (CoinGecko)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout);

      const response = await fetch(config.url, {
        headers: {
          'accept': 'application/json',
          'cache-control': 'no-cache',
          'user-agent': 'BuyBulk/1.0'
        },
        signal: controller.signal
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
      price = parseResponse(data);
    }

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

async function hydrateSolPriceFromRedis(): Promise<void> {
  const cached = await cacheGet<PriceCache>(SOL_PRICE_REDIS_KEY)
  if (!cached?.price) return
  if (cached.expiresAt > Date.now() || cached.price !== DEFAULT_SOL_PRICE_USD) {
    priceCache = cached
  }
}

async function persistSolPriceToRedis(): Promise<void> {
  await cacheSet(SOL_PRICE_REDIS_KEY, priceCache, SOL_PRICE_REDIS_TTL_SECONDS)
}

// Enhanced SOL price fetching with parallel requests and intelligent fallback
export async function getSolPriceUSDCore(): Promise<{ price: number; source: string }> {
  await hydrateSolPriceFromRedis()

  // Check if we can use stale cache to avoid API calls during high load
  const now = Date.now();
  if (priceCache.price && priceCache.price !== DEFAULT_SOL_PRICE_USD &&
    now - priceCache.timestamp < STALE_CACHE_TTL_MS) {
    console.log('Using stale cache to reduce API load');
    // Use originalSource to prevent accumulation
    return { price: priceCache.price, source: `stale_${priceCache.originalSource}` };
  }

  const bybit = await fetchBybitSpotLast('SOLUSDT')
  if (bybit > 0) {
    const currentTime = Date.now()
    priceCache = {
      price: bybit,
      source: 'bybit',
      timestamp: currentTime,
      expiresAt: currentTime + CACHE_TTL_MS,
      originalSource: 'bybit',
    }
    await persistSolPriceToRedis()
    return { price: bybit, source: 'bybit' }
  }

  // Try all APIs in parallel for faster response
  const apiPromises = [
    fetchWithRateLimit('coingecko', (data) => data?.solana?.usd),
    fetchWithRateLimit('jupiter', () => 0) // Price will be fetched using Jupiter API utility
  ];

  // Use Promise.allSettled to get results from all APIs
  const results = await Promise.allSettled(apiPromises);

  // Find the first successful result
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled' && result.value) {
      // Update cache with fresh data
      const currentTime = Date.now();
      priceCache = {
        price: result.value.price,
        source: result.value.source,
        timestamp: currentTime,
        expiresAt: currentTime + CACHE_TTL_MS,
        originalSource: result.value.source
      };
      await persistSolPriceToRedis();
      
      return result.value;
    }
  }

  // All APIs failed, use cached or default price
  if (priceCache.price && priceCache.price !== DEFAULT_SOL_PRICE_USD) {
    console.warn('All APIs failed, using stale cached price');
    return { price: priceCache.price, source: `stale_${priceCache.originalSource}` };
  }

  console.warn('All APIs failed, using default price');
  return { price: DEFAULT_SOL_PRICE_USD, source: 'default' };
}

export async function warmSolPriceCacheFromRedis(): Promise<void> {
  await hydrateSolPriceFromRedis()
}

// Get cached price info for API responses
export function getCachedPriceInfo() {
  const currentTime = Date.now();
  return {
    price: priceCache.price,
    source: priceCache.source,
    cached: currentTime < priceCache.expiresAt,
    cache_age: Math.round((currentTime - priceCache.timestamp) / 1000),
    expires_in: Math.round((priceCache.expiresAt - currentTime) / 1000),
    rate_limit_status: Object.entries(rateLimitStates).map(([api, state]) => ({
      api,
      backoff_until: state.backoffUntil > Date.now() ? new Date(state.backoffUntil).toISOString() : null,
      consecutive_errors: state.consecutiveErrors
    }))
  };
}