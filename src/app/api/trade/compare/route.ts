import { NextRequest, NextResponse } from 'next/server'
import { compareTradeQuotes, checkProviderHealth } from '@/utils/trade-comparison'
import { TradeQuoteRequest } from '@/types'

// Enhanced caching for provider health and quote results
interface HealthCache {
  health: Record<string, boolean>
  timestamp: number
}

interface QuoteCache {
  key: string
  result: any
  timestamp: number
  expiresAt: number
}

let providerHealthCache: HealthCache | null = null
let quoteCacheMap = new Map<string, QuoteCache>()

const HEALTH_CACHE_DURATION = 1000 * 60 * 5 // 5 minutes
const QUOTE_CACHE_DURATION = 1000 * 30 // 30 seconds for quote caching
const MAX_CACHE_SIZE = 100 // Limit cache size to prevent memory issues

// Enhanced provider health status with better caching
async function getProviderHealthStatus() {
  const now = Date.now()
  
  if (providerHealthCache && (now - providerHealthCache.timestamp) < HEALTH_CACHE_DURATION) {
    return providerHealthCache.health
  }
  
  try {
    const health = await checkProviderHealth()
    
    providerHealthCache = {
      health,
      timestamp: now
    }
    
    return health
  } catch (error) {
    console.warn('Health check failed:', error)
    // Return cached health if available, otherwise default
    if (providerHealthCache) {
      console.log('Using stale health cache due to error')
      return providerHealthCache.health
    }
    return { jupiter: true, dflow: false, 'solana-tracker': false }
  }
}

// Generate cache key for quote requests
function generateQuoteCacheKey(request: TradeQuoteRequest): string {
  return `${request.inputMint}-${request.outputMint}-${request.amount}-${request.slippageBps}`
}

// Clean up expired cache entries
function cleanupQuoteCache() {
  const now = Date.now()
  for (const [key, cache] of quoteCacheMap.entries()) {
    if (now > cache.expiresAt) {
      quoteCacheMap.delete(key)
    }
  }
  
  // Limit cache size
  if (quoteCacheMap.size > MAX_CACHE_SIZE) {
    const entries = Array.from(quoteCacheMap.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toDelete = entries.slice(0, quoteCacheMap.size - MAX_CACHE_SIZE)
    toDelete.forEach(([key]) => quoteCacheMap.delete(key))
  }
}

// Get cached quote result
function getCachedQuote(cacheKey: string): any | null {
  const cached = quoteCacheMap.get(cacheKey)
  if (!cached) return null
  
  const now = Date.now()
  if (now <= cached.expiresAt) {
    return cached.result
  }
  
  quoteCacheMap.delete(cacheKey)
  return null
}

// Set cached quote result
function setCachedQuote(cacheKey: string, result: any) {
  const now = Date.now()
  quoteCacheMap.set(cacheKey, {
    key: cacheKey,
    result,
    timestamp: now,
    expiresAt: now + QUOTE_CACHE_DURATION
  })
  
  // Clean up old entries
  cleanupQuoteCache()
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    const { inputMint, outputMint, amount, slippageBps = 100, userPublicKey } = body
    
    if (!inputMint || !outputMint || !amount || !userPublicKey) {
      return NextResponse.json(
        { 
          error: 'Missing required fields', 
          required: ['inputMint', 'outputMint', 'amount', 'userPublicKey'] 
        },
        { status: 400 }
      )
    }

    // Validate mint addresses (basic check)
    if (inputMint.length < 32 || inputMint.length > 44 || outputMint.length < 32 || outputMint.length > 44) {
      return NextResponse.json(
        { error: 'Invalid mint address format' },
        { status: 400 }
      )
    }

    // Basic Base58 character validation
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/
    if (!base58Regex.test(inputMint) || !base58Regex.test(outputMint)) {
      return NextResponse.json(
        { error: 'Invalid mint address characters' },
        { status: 400 }
      )
    }

    // Validate amount
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum <= 0) {
      return NextResponse.json(
        { error: 'Amount must be a positive number' },
        { status: 400 }
      )
    }

    // Validate slippage
    if (slippageBps < 0 || slippageBps > 10000) {
      return NextResponse.json(
        { error: 'Slippage must be between 0 and 10000 basis points' },
        { status: 400 }
      )
    }

    const tradeRequest: TradeQuoteRequest = {
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps,
      userPublicKey
    }

    // Generate cache key and check for cached result
    const cacheKey = generateQuoteCacheKey(tradeRequest)
    const cachedResult = getCachedQuote(cacheKey)
    
    if (cachedResult) {
      console.log('🎯 Returning cached trade comparison result')
      return NextResponse.json({
        ...cachedResult,
        metadata: {
          ...cachedResult.metadata,
          cached: true,
          cacheKey: cacheKey.substring(0, 16) + '...'
        }
      }, {
        headers: {
          'Cache-Control': 'public, max-age=30',
          'X-Cache-Status': 'HIT',
          'X-Request-ID': cachedResult.metadata?.api?.requestId || generateRequestId()
        }
      })
    }

    console.log('🚀 Trade comparison request:', {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      userPublicKey: userPublicKey.substring(0, 8) + '...',
      cacheKey: cacheKey.substring(0, 16) + '...'
    })

    // Get provider health status and execute trade comparison in parallel
    const startTime = Date.now()
    const [providerHealth, comparison] = await Promise.all([
      getProviderHealthStatus(),
      compareTradeQuotes(tradeRequest)
    ])
    const totalTime = Date.now() - startTime

    // Add metadata to response
    const response = {
      ...comparison,
      metadata: {
        executionTime: totalTime,
        providerHealth,
        cached: false,
        api: {
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          requestId: generateRequestId()
        }
      }
    }

    // Cache the result for future requests
    setCachedQuote(cacheKey, response)

    console.log('✅ Trade comparison response:', {
      requestId: response.metadata.api.requestId,
      executionTime: totalTime,
      bestProvider: comparison.bestQuote?.provider,
      bestAmount: comparison.bestQuote?.outAmount,
      successfulQuotes: comparison.summary.successfulQuotes,
      cached: false
    })

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'public, max-age=30',
        'X-Cache-Status': 'MISS',
        'X-Request-ID': response.metadata.api.requestId,
        'X-Execution-Time': totalTime.toString()
      }
    })

  } catch (error) {
    console.error('❌ Trade comparison error:', error)
    
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    
    // Support GET requests for simple quote comparisons
    const inputMint = searchParams.get('inputMint')
    const outputMint = searchParams.get('outputMint')
    const amount = searchParams.get('amount')
    const slippageBps = parseInt(searchParams.get('slippageBps') || '100')
    const userPublicKey = searchParams.get('userPublicKey')

    if (!inputMint || !outputMint || !amount || !userPublicKey) {
      return NextResponse.json(
        {
          error: 'Missing required parameters',
          required: ['inputMint', 'outputMint', 'amount', 'userPublicKey'],
          example: '/api/trade/compare?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&userPublicKey=YOUR_WALLET_ADDRESS'
        },
        { status: 400 }
      )
    }

    // Validate and process the request same as POST
    const tradeRequest: TradeQuoteRequest = {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      userPublicKey
    }

    const comparison = await compareTradeQuotes(tradeRequest)
    const providerHealth = await getProviderHealthStatus()

    return NextResponse.json({
      ...comparison,
      metadata: {
        providerHealth,
        api: {
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          method: 'GET'
        }
      }
    })

  } catch (error) {
    console.error('❌ GET trade comparison error:', error)
    
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

// Health check endpoint
export async function HEAD(request: NextRequest) {
  try {
    const health = await getProviderHealthStatus()
    const isHealthy = Object.values(health).some(status => status)
    
    return new NextResponse(null, {
      status: isHealthy ? 200 : 503,
      headers: {
        'X-Provider-Health': JSON.stringify(health)
      }
    })
  } catch (error) {
    return new NextResponse(null, { status: 503 })
  }
}

function generateRequestId(): string {
  return `trade_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
}