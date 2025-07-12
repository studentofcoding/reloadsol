import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

// Database schema for Supabase
interface DatabaseRecord {
  id: string
  wallet_address: string
  operation_type: string
  timestamp: string
  data: any
  created_at?: string
}

// Caching for trading records
interface TradingRecordsCache {
  data: any[]
  walletAddress: string
  limit: number
  timestamp: number
  expiresAt: number
}

interface OngoingRecordsRequest {
  promise: Promise<any[]>
  walletAddress: string
  limit: number
  timestamp: number
}

const tradingRecordsCache = new Map<string, TradingRecordsCache>()
const ongoingRecordsRequests = new Map<string, OngoingRecordsRequest>()

const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes cache for trading records
const MAX_CACHE_ENTRIES = 50 // Cache for different wallet/limit combinations
const REQUEST_TIMEOUT = 10000 // 10 second timeout

// Clean up expired cache entries
function cleanupRecordsCache() {
  const now = Date.now()
  
  // Clean expired cache entries
  for (const [key, cache] of Array.from(tradingRecordsCache.entries())) {
    if (now > cache.expiresAt) {
      tradingRecordsCache.delete(key)
    }
  }
  
  // Clean expired ongoing requests
  for (const [key, request] of Array.from(ongoingRecordsRequests.entries())) {
    if (now - request.timestamp > REQUEST_TIMEOUT) {
      ongoingRecordsRequests.delete(key)
    }
  }
  
  // Limit cache size
  if (tradingRecordsCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(tradingRecordsCache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toDelete = entries.slice(0, tradingRecordsCache.size - MAX_CACHE_ENTRIES)
    toDelete.forEach(([key]) => tradingRecordsCache.delete(key))
  }
}

// Generate cache key for trading records
function generateRecordsCacheKey(walletAddress: string, limit: number): string {
  return `${walletAddress}-${limit}`
}

// Get cached trading records
function getCachedRecords(walletAddress: string, limit: number): any[] | null {
  const cacheKey = generateRecordsCacheKey(walletAddress, limit)
  const cached = tradingRecordsCache.get(cacheKey)
  if (!cached) return null
  
  const now = Date.now()
  if (now <= cached.expiresAt) {
    return cached.data
  }
  
  tradingRecordsCache.delete(cacheKey)
  return null
}

// Set cached trading records
function setCachedRecords(walletAddress: string, limit: number, data: any[]) {
  const now = Date.now()
  const cacheKey = generateRecordsCacheKey(walletAddress, limit)
  
  tradingRecordsCache.set(cacheKey, {
    data,
    walletAddress,
    limit,
    timestamp: now,
    expiresAt: now + CACHE_TTL_MS
  })
  
  cleanupRecordsCache()
}

// Fetch trading records with caching and deduplication
async function fetchTradingRecordsWithCache(walletAddress: string, limit: number): Promise<any[]> {
  // Check cache first
  const cached = getCachedRecords(walletAddress, limit)
  if (cached) {
    console.log(`🎯 Cache hit for trading records: ${walletAddress.substring(0, 8)}... (${limit} records)`)
    return cached
  }
  
  const cacheKey = generateRecordsCacheKey(walletAddress, limit)
  
  // Check if there's an ongoing request
  const ongoing = ongoingRecordsRequests.get(cacheKey)
  if (ongoing) {
    console.log(`⏳ Waiting for ongoing trading records request: ${walletAddress.substring(0, 8)}...`)
    try {
      return await ongoing.promise
    } catch (error) {
      ongoingRecordsRequests.delete(cacheKey)
      throw error
    }
  }
  
  // Create new request
  const requestPromise = fetchTradingRecordsFromDB(walletAddress, limit)
  ongoingRecordsRequests.set(cacheKey, {
    promise: requestPromise,
    walletAddress,
    limit,
    timestamp: Date.now()
  })
  
  try {
    const result = await requestPromise
    ongoingRecordsRequests.delete(cacheKey)
    
    if (result && result.length >= 0) {
      setCachedRecords(walletAddress, limit, result)
    }
    
    return result
  } catch (error) {
    ongoingRecordsRequests.delete(cacheKey)
    throw error
  }
}

// Actual database fetch function
async function fetchTradingRecordsFromDB(walletAddress: string, limit: number): Promise<any[]> {
  const { data, error } = await supabase
    .from('trading_records')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  return (data || []).map((item: DatabaseRecord) => item.data)
}

// GET /api/trading/records?wallet=<address>&limit=<number>
export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    // const authResult = await validateAuth(request)
    // if (!authResult.valid) {
    //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // }

    const { searchParams } = new URL(request.url)
    const walletAddress = searchParams.get('wallet')
    const limit = parseInt(searchParams.get('limit') || '500')

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'wallet parameter is required' },
        { status: 400 }
      )
    }

    const records = await fetchTradingRecordsWithCache(walletAddress, limit)

    return NextResponse.json({
      success: true,
      records,
      cached: getCachedRecords(walletAddress, limit) !== null
    }, {
      headers: {
        'Cache-Control': 'public, max-age=120, stale-while-revalidate=60',
        'X-Cache-Status': getCachedRecords(walletAddress, limit) ? 'HIT' : 'MISS'
      }
    })
  } catch (error) {
    console.error('Error fetching trading records:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch trading records',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

// POST /api/trading/records - Save new trading record
export async function POST(request: NextRequest) {
  try {
    const record = await request.json()

    if (!record.id || !record.walletAddress || !record.operationType) {
      return NextResponse.json(
        { error: 'Missing required fields: id, walletAddress, operationType' },
        { status: 400 }
      )
    }

    // Skip records with errors
    if (
      (record.errors && record.errors.length > 0) || 
      (record.failureCount > 0 && record.successCount === 0)
    ) {
      return NextResponse.json({ 
        success: true,
        skipped: true,
        reason: 'Record contains errors or represents failed operation'
      })
    }

    const dbRecord: Omit<DatabaseRecord, 'created_at'> = {
      id: record.id,
      wallet_address: record.walletAddress,
      operation_type: record.operationType,
      timestamp: new Date(record.timestamp).toISOString(),
      data: record
    }

    const { error } = await supabase
      .from('trading_records')
      .insert(dbRecord)

    if (error) {
      throw error
    }

    // Invalidate cache for this wallet address
    const keysToDelete: string[] = []
    for (const [key, cache] of Array.from(tradingRecordsCache.entries())) {
      if (cache.walletAddress === record.walletAddress) {
        keysToDelete.push(key)
      }
    }
    keysToDelete.forEach(key => tradingRecordsCache.delete(key))
    
    console.log(`🗑️ Invalidated ${keysToDelete.length} cache entries for wallet ${record.walletAddress.substring(0, 8)}...`)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error saving trading record:', error)
    return NextResponse.json(
      { 
        error: 'Failed to save trading record',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

// OPTIONS /api/trading/records - Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}