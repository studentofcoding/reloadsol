import { NextRequest, NextResponse } from 'next/server'
import { assertSessionWallet, requireWalletSession } from '@/utils/api-auth'
import { query } from '@/utils/db'
import {
  insertTradingRecord,
  shouldSkipTradingRecord,
} from '@/utils/trading-records-db'
import { maybeRecordSignalsOutcome } from '@/utils/signals-outcome-capture'
import {
  generateRecordsCacheKey,
  getCachedRecords,
  invalidateTradingRecordsCache,
  ongoingRecordsRequests,
  setCachedRecords,
} from '@/utils/trading-records-cache'

interface DatabaseRecord {
  id: string
  wallet_address: string
  operation_type: string
  timestamp: string
  data: any
  created_at?: string
}

const REQUEST_TIMEOUT = 10000

// Fetch trading records with caching and deduplication
async function fetchTradingRecordsWithCache(walletAddress: string, limit: number): Promise<any[]> {
  const cached = getCachedRecords(walletAddress, limit)
  if (cached) {
    console.log(`🎯 Cache hit for trading records: ${walletAddress.substring(0, 8)}... (${limit} records)`)
    return cached as any[]
  }

  const cacheKey = generateRecordsCacheKey(walletAddress, limit)

  const ongoing = ongoingRecordsRequests.get(cacheKey)
  if (ongoing) {
    console.log(`⏳ Waiting for ongoing trading records request: ${walletAddress.substring(0, 8)}...`)
    try {
      return (await ongoing.promise) as any[]
    } catch (error) {
      ongoingRecordsRequests.delete(cacheKey)
      throw error
    }
  }

  const requestPromise = fetchTradingRecordsFromDB(walletAddress, limit)
  ongoingRecordsRequests.set(cacheKey, {
    promise: requestPromise,
    walletAddress,
    limit,
    timestamp: Date.now(),
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

async function fetchTradingRecordsFromDB(walletAddress: string, limit: number): Promise<any[]> {
  const { rows } = await query<DatabaseRecord>(
    `SELECT * FROM trading_records
     WHERE wallet_address = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [walletAddress, limit],
  )

  return rows.map((item) => item.data)
}

function resolveAllowedOrigin(request: NextRequest): string | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  try {
    const url = new URL(origin)
    const hostname = url.hostname
    const protocol = url.protocol

    if (process.env.NODE_ENV === 'production' && protocol !== 'https:') return null
    if (hostname === 'reloadsol.xyz' || hostname.endsWith('.reloadsol.xyz')) return origin

    if (
      process.env.NODE_ENV !== 'production' &&
      (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))
    ) {
      return origin
    }
    return null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = requireWalletSession(request)
    if (auth instanceof NextResponse) {
      return auth
    }

    const { searchParams } = new URL(request.url)
    const walletAddress = searchParams.get('wallet')
    const limit = parseInt(searchParams.get('limit') || '500')

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'wallet parameter is required' },
        { status: 400 }
      )
    }

    const mismatch = assertSessionWallet(auth.session.address, walletAddress)
    if (mismatch) {
      return mismatch
    }

    const records = await fetchTradingRecordsWithCache(walletAddress, limit)

    const allowedOrigin = resolveAllowedOrigin(request)

    return NextResponse.json({
      success: true,
      records,
      cached: getCachedRecords(walletAddress, limit) !== null
    }, {
      headers: {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Cache-Status': getCachedRecords(walletAddress, limit) ? 'HIT' : 'MISS',
        ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin',
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

export async function POST(request: NextRequest) {
  try {
    const auth = requireWalletSession(request)
    if (auth instanceof NextResponse) {
      return auth
    }

    const record = await request.json()

    if (!record.id || !record.walletAddress || !record.operationType) {
      return NextResponse.json(
        { error: 'Missing required fields: id, walletAddress, operationType' },
        { status: 400 }
      )
    }

    const mismatch = assertSessionWallet(auth.session.address, record.walletAddress)
    if (mismatch) {
      return mismatch
    }

    if (shouldSkipTradingRecord(record)) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Record contains errors or represents failed operation'
      })
    }

    await insertTradingRecord(record)

    try {
      await maybeRecordSignalsOutcome(record)
    } catch (outcomeErr) {
      console.warn('[trading/records] signals outcome capture failed:', outcomeErr)
    }

    const allowedOrigin = resolveAllowedOrigin(request)

    return NextResponse.json(
      { success: true },
      {
        headers: {
          ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin',
        },
      }
    )
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

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const walletAddress = searchParams.get('wallet')

    if (!id || !walletAddress) {
      return NextResponse.json(
        { error: 'Missing required parameters: id, wallet' },
        { status: 400 }
      )
    }

    await query(
      `DELETE FROM trading_records WHERE id = $1 AND wallet_address = $2`,
      [id, walletAddress],
    )

    const invalidated = invalidateTradingRecordsCache(walletAddress)
    console.log(`🗑️ Deleted record ${id} and invalidated ${invalidated} cache entries for wallet ${walletAddress.substring(0, 8)}...`)

    const allowedOrigin = resolveAllowedOrigin(request)

    return NextResponse.json(
      { success: true },
      {
        headers: {
          ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin',
        },
      }
    )
  } catch (error) {
    console.error('Error deleting trading record:', error)
    return NextResponse.json(
      {
        error: 'Failed to delete trading record',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

export async function OPTIONS(request: NextRequest) {
  const allowedOrigin = resolveAllowedOrigin(request)
  return new NextResponse(null, {
    status: 200,
    headers: {
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : { 'Access-Control-Allow-Origin': '*' }),
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin',
      'Access-Control-Max-Age': '86400',
    },
  })
}
