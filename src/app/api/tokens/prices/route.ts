import { NextRequest, NextResponse } from 'next/server'

// Enhanced cache with longer TTL for high-volume usage
interface PriceCache {
  price: number
  timestamp: number
  expiresAt: number
  source: string
}

// In-memory cache with 2-minute TTL (can be replaced with Redis)
const priceCache = new Map<string, PriceCache>()

// Request queue to batch multiple client requests
interface PendingRequest {
  tokens: string[]
  resolve: (prices: Record<string, number>) => void
  reject: (error: Error) => void
  timestamp: number
}

const pendingRequests: PendingRequest[] = []
let batchTimeout: NodeJS.Timeout | null = null

// Rate limiting state
let requestCount = 0
let resetTime = Date.now() + 60000 // Reset every minute
const MAX_REQUESTS_PER_MINUTE = 55 // Leave buffer for other API calls

// Cache TTL configurations
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes for regular tokens
const POPULAR_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes for popular tokens
const STALE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes stale fallback

// Popular tokens that get longer cache (SOL, USDC, USDT, etc.)
const POPULAR_TOKENS = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
])

function isRateLimited(): boolean {
  const now = Date.now()
  if (now >= resetTime) {
    requestCount = 0
    resetTime = now + 60000
  }
  return requestCount >= MAX_REQUESTS_PER_MINUTE
}

function getCachedPrice(mint: string): number | null {
  const cached = priceCache.get(mint)
  if (!cached) return null
  
  const now = Date.now()
  if (now <= cached.expiresAt) {
    return cached.price
  }
  
  // Check if we can use stale cache to avoid API calls
  if (now <= cached.timestamp + STALE_CACHE_TTL_MS) {
    console.log(`Using stale cache for ${mint}`)
    return cached.price
  }
  
  return null
}

function setCachedPrice(mint: string, price: number, source: string = 'jupiter') {
  const now = Date.now()
  const ttl = POPULAR_TOKENS.has(mint) ? POPULAR_CACHE_TTL_MS : CACHE_TTL_MS
  
  priceCache.set(mint, {
    price,
    timestamp: now,
    expiresAt: now + ttl,
    source
  })
}

async function fetchPricesFromJupiter(tokens: string[]): Promise<Record<string, number>> {
  if (tokens.length === 0) return {}
  
  try {
    requestCount++
    const mintIds = tokens.join(',')
    console.log(`Fetching prices for ${tokens.length} tokens from Jupiter`)
    
    const response = await fetch(`https://lite-api.jup.ag/price/v2?ids=${mintIds}`, {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'BuyBulk/1.0'
      }
    })
    
    if (response.status === 429) {
      throw new Error('Rate limited by Jupiter API')
    }
    
    if (!response.ok) {
      throw new Error(`Jupiter API error: ${response.status}`)
    }
    
    const data = await response.json()
    const prices: Record<string, number> = {}
    
    if (data?.data) {
      Object.entries(data.data).forEach(([mint, priceData]: [string, any]) => {
        if (priceData && priceData.price) {
          const price = parseFloat(priceData.price)
          prices[mint] = price
          setCachedPrice(mint, price, 'jupiter')
        } else {
          prices[mint] = 0
        }
      })
    }
    
    return prices
  } catch (error) {
    console.error('Jupiter price fetch error:', error)
    throw error
  }
}

function processBatchedRequests() {
  if (pendingRequests.length === 0) return
  
  // Collect all unique tokens from pending requests
  const allTokens = new Set<string>()
  pendingRequests.forEach(req => {
    req.tokens.forEach(token => allTokens.add(token))
  })
  
  const uniqueTokens = Array.from(allTokens)
  console.log(`Processing batch: ${pendingRequests.length} requests for ${uniqueTokens.length} unique tokens`)
  
  // Get cached prices first
  const cachedPrices: Record<string, number> = {}
  const tokensToFetch: string[] = []
  
  uniqueTokens.forEach(token => {
    const cached = getCachedPrice(token)
    if (cached !== null) {
      cachedPrices[token] = cached
    } else {
      tokensToFetch.push(token)
    }
  })
  
  console.log(`Cache hit: ${Object.keys(cachedPrices).length}, Need to fetch: ${tokensToFetch.length}`)
  
  // Process the batch
  Promise.resolve().then(async () => {
    let freshPrices: Record<string, number> = {}
    
    if (tokensToFetch.length > 0 && !isRateLimited()) {
      try {
        // Split into chunks of 100 (Jupiter API limit)
        const chunks = []
        for (let i = 0; i < tokensToFetch.length; i += 100) {
          chunks.push(tokensToFetch.slice(i, i + 100))
        }
        
        // Fetch all chunks (if within rate limit)
        const chunkPromises = chunks.slice(0, Math.floor((MAX_REQUESTS_PER_MINUTE - requestCount) / chunks.length))
        const chunkResults = await Promise.allSettled(
          chunkPromises.map(chunk => fetchPricesFromJupiter(chunk))
        )
        
        chunkResults.forEach(result => {
          if (result.status === 'fulfilled') {
            Object.assign(freshPrices, result.value)
          }
        })
      } catch (error) {
        console.error('Batch price fetch failed:', error)
      }
    }
    
    // Combine cached and fresh prices
    const allPrices = { ...cachedPrices, ...freshPrices }
    
    // Resolve all pending requests
    const requestsToResolve = [...pendingRequests]
    pendingRequests.length = 0 // Clear the queue
    
    requestsToResolve.forEach(request => {
      const requestPrices: Record<string, number> = {}
      request.tokens.forEach(token => {
        requestPrices[token] = allPrices[token] ?? 0
      })
      request.resolve(requestPrices)
    })
  }).catch(error => {
    // Reject all pending requests on error
    const requestsToReject = [...pendingRequests]
    pendingRequests.length = 0
    requestsToReject.forEach(request => request.reject(error))
  })
}

function addToBatch(tokens: string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    pendingRequests.push({
      tokens,
      resolve,
      reject,
      timestamp: Date.now()
    })
    
    // Set timeout to process batch (aggregate requests for 100ms)
    if (batchTimeout) {
      clearTimeout(batchTimeout)
    }
    
    batchTimeout = setTimeout(processBatchedRequests, 100)
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { tokens } = body
    
    if (!tokens || !Array.isArray(tokens)) {
      return NextResponse.json(
        { error: 'Invalid request. Expected { tokens: string[] }' },
        { status: 400 }
      )
    }
    
    if (tokens.length === 0) {
      return NextResponse.json({ prices: {} })
    }
    
    if (tokens.length > 100) {
      return NextResponse.json(
        { error: 'Too many tokens. Maximum 100 per request.' },
        { status: 400 }
      )
    }
    
    // Validate token addresses
    const validTokens = tokens.filter(token => 
      typeof token === 'string' && token.length >= 32 && token.length <= 44
    )
    
    if (validTokens.length === 0) {
      return NextResponse.json(
        { error: 'No valid token addresses provided' },
        { status: 400 }
      )
    }
    
    // Add to batch processing queue
    const prices = await addToBatch(validTokens)
    
    return NextResponse.json(
      { 
        prices,
        cached_tokens: Object.keys(prices).filter(token => getCachedPrice(token) !== null).length,
        fresh_tokens: Object.keys(prices).filter(token => getCachedPrice(token) === null).length,
        rate_limit_remaining: Math.max(0, MAX_REQUESTS_PER_MINUTE - requestCount),
        cache_stats: {
          total_cached: priceCache.size,
          popular_tokens: validTokens.filter(token => POPULAR_TOKENS.has(token)).length
        }
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=30'
        }
      }
    )
  } catch (error) {
    console.error('Price API error:', error)
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokensParam = searchParams.get('tokens') || searchParams.get('token')
  const tokens = tokensParam ? tokensParam.split(',').filter(Boolean) : []
  
  if (tokens.length === 0) {
    return NextResponse.json({ error: 'No tokens specified' }, { status: 400 })
  }
  
  try {
    const prices = await addToBatch(tokens)
    return NextResponse.json({ prices })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch prices', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
} 