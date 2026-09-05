import { NextRequest, NextResponse, connection } from 'next/server'
import { getRandomTokens } from '@/utils/jupiter-pools-test'

// Caching for random tokens with shorter TTL
interface RandomTokensCache {
  data: any[]
  count: number
  timestamp: number
  expiresAt: number
}

interface OngoingRandomRequest {
  promise: Promise<any[]>
  count: number
  timestamp: number
}

const randomTokensCache = new Map<number, RandomTokensCache>()
const ongoingRandomRequests = new Map<number, OngoingRandomRequest>()

const CACHE_TTL_MS = 30 * 1000 // 30 seconds cache for random tokens
const MAX_CACHE_ENTRIES = 10 // Cache for different count values
const REQUEST_TIMEOUT = 8000 // 8 second timeout

// Clean up expired cache entries
function cleanupRandomCache() {
  const now = Date.now()
  
  // Clean expired cache entries
  Array.from(randomTokensCache.entries()).forEach(([count, cache]) => {
    if (now > cache.expiresAt) {
      randomTokensCache.delete(count)
    }
  })
  
  // Clean expired ongoing requests
  Array.from(ongoingRandomRequests.entries()).forEach(([count, request]) => {
    if (now - request.timestamp > REQUEST_TIMEOUT) {
      ongoingRandomRequests.delete(count)
    }
  })
  
  // Limit cache size
  if (randomTokensCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(randomTokensCache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toDelete = entries.slice(0, randomTokensCache.size - MAX_CACHE_ENTRIES)
    toDelete.forEach(([count]) => randomTokensCache.delete(count))
  }
}

// Get cached random tokens
function getCachedRandomTokens(count: number): any[] | null {
  const cached = randomTokensCache.get(count)
  if (!cached) return null
  
  const now = Date.now()
  if (now <= cached.expiresAt) {
    return cached.data
  }
  
  randomTokensCache.delete(count)
  return null
}

// Set cached random tokens
function setCachedRandomTokens(count: number, data: any[]) {
  const now = Date.now()
  randomTokensCache.set(count, {
    data,
    count,
    timestamp: now,
    expiresAt: now + CACHE_TTL_MS
  })
  
  cleanupRandomCache()
}

// Deduplicated random tokens fetch with caching
async function getRandomTokensWithCache(count: number): Promise<any[]> {
  // Check cache first
  const cached = getCachedRandomTokens(count)
  if (cached) {
    console.log(`🎯 Cache hit for ${count} random tokens`)
    return cached
  }
  
  // Check if there's an ongoing request for this count
  const ongoing = ongoingRandomRequests.get(count)
  if (ongoing) {
    console.log(`⏳ Waiting for ongoing request for ${count} random tokens`)
    try {
      return await ongoing.promise
    } catch (error) {
      ongoingRandomRequests.delete(count)
      throw error
    }
  }
  
  // Create new request
  const requestPromise = getRandomTokens(count)
  ongoingRandomRequests.set(count, {
    promise: requestPromise,
    count,
    timestamp: Date.now()
  })
  
  try {
    const result = await requestPromise
    ongoingRandomRequests.delete(count)
    
    if (result && result.length > 0) {
      setCachedRandomTokens(count, result)
    }
    
    return result
  } catch (error) {
    ongoingRandomRequests.delete(count)
    throw error
  }
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const count = parseInt(searchParams.get('count') || '10')
    
    // Validate count parameter
    if (count < 1 || count > 50) {
      return NextResponse.json(
        { error: 'Count must be between 1 and 50' },
        { status: 400 }
      )
    }

    console.log(`🎲 Fetching ${count} random tokens...`)
    
    const tokens = await getRandomTokensWithCache(count)
    
    if (tokens.length === 0) {
      return NextResponse.json(
        { error: 'No tokens found' },
        { status: 404 }
      )
    }

    console.log(`✅ Successfully fetched ${tokens.length} random tokens`)
    
    return NextResponse.json({
      success: true,
      count: tokens.length,
      tokens,
      cached: getCachedRandomTokens(count) !== null
    }, {
      headers: {
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=15',
        'X-Cache-Status': getCachedRandomTokens(count) ? 'HIT' : 'MISS'
      }
    })
    
  } catch (error) {
    console.error('❌ Random tokens API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch random tokens',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { count = 10 } = body
    
    // Validate count parameter
    if (count < 1 || count > 50) {
      return NextResponse.json(
        { error: 'Count must be between 1 and 50' },
        { status: 400 }
      )
    }

    console.log(`🎲 POST: Fetching ${count} random tokens...`)
    
    const tokens = await getRandomTokensWithCache(count)
    
    if (tokens.length === 0) {
      return NextResponse.json(
        { error: 'No tokens found' },
        { status: 404 }
      )
    }

    console.log(`✅ POST: Successfully fetched ${tokens.length} random tokens`)
    
    return NextResponse.json({
      success: true,
      count: tokens.length,
      tokens,
      cached: getCachedRandomTokens(count) !== null
    }, {
      headers: {
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=15',
        'X-Cache-Status': getCachedRandomTokens(count) ? 'HIT' : 'MISS'
      }
    })
    
  } catch (error) {
    console.error('❌ Random tokens POST API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch random tokens',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}