import { NextRequest, NextResponse, connection } from 'next/server'
import { assertSessionWallet, requireWalletSession } from '@/utils/api-auth'
import { parseDbChain } from '@/utils/app-network-db'
import type { AppNetwork } from '@/utils/app-network'
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
  chain?: string
  created_at?: string
}

const REQUEST_TIMEOUT = 10000

// Fetch trading records with caching and deduplication
async function fetchTradingRecordsWithCache(
  walletAddress: string,
  limit: number,
  chain: AppNetwork,
): Promise<{ records: any[]; fromCache: boolean }> {
  const cached = await getCachedRecords(walletAddress, limit, chain)
  if (cached) {
    console.log(`🎯 Cache hit for trading records: ${walletAddress.substring(0, 8)}... (${limit} records)`)
    return { records: cached as any[], fromCache: true }
  }

  const cacheKey = generateRecordsCacheKey(walletAddress, limit, chain)

  const ongoing = ongoingRecordsRequests.get(cacheKey)
  if (ongoing) {
    console.log(`⏳ Waiting for ongoing trading records request: ${walletAddress.substring(0, 8)}...`)
    try {
      return { records: (await ongoing.promise) as any[], fromCache: false }
    } catch (error) {
      ongoingRecordsRequests.delete(cacheKey)
      throw error
    }
  }

  const requestPromise = fetchTradingRecordsFromDB(walletAddress, limit, chain)
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
      setCachedRecords(walletAddress, limit, result, chain)
    }

    return { records: result, fromCache: false }
  } catch (error) {
    ongoingRecordsRequests.delete(cacheKey)
    throw error
  }
}

async function fetchTradingRecordsFromDB(
  walletAddress: string,
  limit: number,
  chain: AppNetwork,
): Promise<any[]> {
  const { rows } = await query<DatabaseRecord>(
    `SELECT * FROM trading_records
     WHERE wallet_address = $1 AND chain = $2
     ORDER BY timestamp DESC
     LIMIT $3`,
    [walletAddress, chain, limit],
  )

  return rows.map((item) => {
    const data = item.data
    if (data && typeof data === 'object' && !data.chain) {
      return { ...data, chain }
    }
    return data
  })
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

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const walletAddress = searchParams.get('wallet')
    const limit = parseInt(searchParams.get('limit') || '500')
    const chain = parseDbChain(searchParams.get('chain'))

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'wallet parameter is required' },
        { status: 400 }
      )
    }

    // Sol: session wallet must match. RH: EVM portfolio wallet; Sol session optional
    // (RH network is already gated to dev wallets in the client).
    if (chain === 'sol') {
      const auth = requireWalletSession(request)
      if (auth instanceof NextResponse) {
        return auth
      }
      const mismatch = assertSessionWallet(auth.session.address, walletAddress)
      if (mismatch) {
        return mismatch
      }
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return NextResponse.json(
        { error: 'Robinhood wallet must be a 0x address' },
        { status: 400 },
      )
    }

    const { records, fromCache } = await fetchTradingRecordsWithCache(
      walletAddress,
      limit,
      chain,
    )

    const allowedOrigin = resolveAllowedOrigin(request)

    return NextResponse.json({
      success: true,
      records,
      cached: fromCache
    }, {
      headers: {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Cache-Status': fromCache ? 'HIT' : 'MISS',
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
    const record = await request.json()

    if (!record.id || !record.walletAddress || !record.operationType) {
      return NextResponse.json(
        { error: 'Missing required fields: id, walletAddress, operationType' },
        { status: 400 }
      )
    }

    record.chain = parseDbChain(record.chain)

    // Mirror GET: Sol requires signed session; RH accepts 0x portfolio wallet
    // (RH network is already gated to dev wallets in the client).
    if (record.chain === 'sol') {
      const auth = requireWalletSession(request)
      if (auth instanceof NextResponse) {
        return auth
      }
      const mismatch = assertSessionWallet(auth.session.address, record.walletAddress)
      if (mismatch) {
        return mismatch
      }
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(String(record.walletAddress))) {
      return NextResponse.json(
        { error: 'Robinhood wallet must be a 0x address' },
        { status: 400 },
      )
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
