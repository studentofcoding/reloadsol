import { NextRequest, NextResponse, connection } from 'next/server'
import { searchTokenStats } from '@/utils/jupiter-pools-test'

// Enhanced caching for token search results
interface TokenSearchCache {
  data: any
  timestamp: number
  expiresAt: number
}

interface OngoingRequest {
  promise: Promise<any>
  timestamp: number
}

const tokenSearchCache = new Map<string, TokenSearchCache>()
const ongoingRequests = new Map<string, OngoingRequest>()

const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes cache
const MAX_CACHE_SIZE = 500 // Limit cache size
const REQUEST_TIMEOUT = 10000 // 10 second timeout for ongoing requests

// Clean up expired cache entries
function cleanupCache() {
  const now = Date.now()
  
  // Clean expired cache entries
  Array.from(tokenSearchCache.entries()).forEach(([key, cache]) => {
    if (now > cache.expiresAt) {
      tokenSearchCache.delete(key)
    }
  })
  
  // Clean expired ongoing requests
  Array.from(ongoingRequests.entries()).forEach(([key, request]) => {
    if (now - request.timestamp > REQUEST_TIMEOUT) {
      ongoingRequests.delete(key)
    }
  })
  
  // Limit cache size by removing oldest entries
  if (tokenSearchCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(tokenSearchCache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toDelete = entries.slice(0, tokenSearchCache.size - MAX_CACHE_SIZE)
    toDelete.forEach(([key]) => tokenSearchCache.delete(key))
  }
}

// Get cached token data
function getCachedToken(address: string): any | null {
  const cached = tokenSearchCache.get(address)
  if (!cached) return null
  
  const now = Date.now()
  if (now <= cached.expiresAt) {
    return cached.data
  }
  
  tokenSearchCache.delete(address)
  return null
}

// Set cached token data
function setCachedToken(address: string, data: any) {
  const now = Date.now()
  tokenSearchCache.set(address, {
    data,
    timestamp: now,
    expiresAt: now + CACHE_TTL_MS
  })
  
  cleanupCache()
}

// Deduplicated token search with caching
async function searchTokenWithCache(address: string): Promise<any> {
  // Check cache first
  const cached = getCachedToken(address)
  if (cached) {
    console.log(`🎯 Cache hit for token: ${address}`);
    return cached
  }
  
  // Check if there's an ongoing request for this address
  const ongoing = ongoingRequests.get(address)
  if (ongoing) {
    console.log(`⏳ Waiting for ongoing request for token: ${address}`);
    try {
      return await ongoing.promise
    } catch (error) {
      ongoingRequests.delete(address)
      throw error
    }
  }
  
  // Create new request
  const requestPromise = searchTokenStats(address)
  ongoingRequests.set(address, {
    promise: requestPromise,
    timestamp: Date.now()
  })
  
  try {
    const result = await requestPromise
    ongoingRequests.delete(address)
    
    if (result) {
      setCachedToken(address, result)
    }
    
    return result
  } catch (error) {
    ongoingRequests.delete(address)
    throw error
  }
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')
    
    if (!address) {
      return NextResponse.json(
        { error: 'Token address is required' },
        { status: 400 }
      )
    }

    // Validate address format (basic Solana address validation)
    if (address.length < 32 || address.length > 44) {
      return NextResponse.json(
        { error: 'Invalid token address format' },
        { status: 400 }
      )
    }

    console.log(`🔍 Searching token stats for: ${address}`)
    
    const tokenStats = await searchTokenWithCache(address)
    
    if (!tokenStats) {
      return NextResponse.json(
        { error: 'Token not found or data unavailable' },
        { status: 404 }
      )
    }

    console.log(`✅ Successfully found stats for token: ${tokenStats.basic.symbol}`)
    
    return NextResponse.json({
      success: true,
      token: tokenStats,
      cached: getCachedToken(address) !== null
    }, {
      headers: {
        'Cache-Control': 'public, max-age=120, stale-while-revalidate=60',
        'X-Cache-Status': getCachedToken(address) ? 'HIT' : 'MISS'
      }
    })
    
  } catch (error) {
    console.error('❌ Token search API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to search token stats',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { address } = body
    
    if (!address) {
      return NextResponse.json(
        { error: 'Token address is required' },
        { status: 400 }
      )
    }

    // Validate address format
    if (address.length < 32 || address.length > 44) {
      return NextResponse.json(
        { error: 'Invalid token address format' },
        { status: 400 }
      )
    }

    console.log(`🔍 POST: Searching token stats for: ${address}`)
    
    const tokenStats = await searchTokenWithCache(address)
    
    if (!tokenStats) {
      return NextResponse.json(
        { error: 'Token not found or data unavailable' },
        { status: 404 }
      )
    }

    console.log(`✅ POST: Successfully found stats for token: ${tokenStats.basic.symbol}`)
    
    return NextResponse.json({
      success: true,
      token: tokenStats,
      cached: getCachedToken(address) !== null
    }, {
      headers: {
        'Cache-Control': 'public, max-age=120, stale-while-revalidate=60',
        'X-Cache-Status': getCachedToken(address) ? 'HIT' : 'MISS'
      }
    })
    
  } catch (error) {
    console.error('❌ Token search POST API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to search token stats',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}