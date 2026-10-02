import { NextRequest, NextResponse, connection } from 'next/server'
import { query } from '@/utils/db'
import { calculateWalletPnL } from '@/utils/pnl-wallet'
import { executionStatsForRecords } from '@/utils/pnl-execution-stats'

function getPnLUpdateSecret(): string | null {
  return process.env.PNL_UPDATE_SECRET || process.env.PNL_UPDATE_TOKEN || null
}

function isPnLUpdateAuthorized(request: NextRequest): boolean {
  const expected = getPnLUpdateSecret()
  if (!expected) return false

  const key = request.nextUrl.searchParams.get('key')
  if (key && key === expected) return true

  const auth = request.headers.get('authorization')
  return auth === `Bearer ${expected}`
}

// PnL calculation API route
// Calculates total PnL for all users and updates token_operations table

interface TradingRecord {
  id: string
  wallet_address: string
  operation_type: string
  timestamp: string
  data: {
    operationType: 'buy' | 'sell' | 'close'
    solAmount?: number
    solPriceUsd?: number
    successCount: number
    failureCount: number
    tokens: Array<{
      mintAddress: string
      priceUsd?: number
      tokenAmount?: number
      solAmount?: number
    }>
  }
}

interface PnLResult {
  wallet_address: string
  total_pnl_usd: number
  /**
   * Three different units, named as such — see `executionStatsForRecords`. Previously `total_trades`
   * (a record/batch count) sat next to `successful_trades` (a token count) and `success_rate` (a
   * submit-time execution rate), which is why the log could print 454 successes out of 372 trades and
   * `success_rate: 100` for a wallet that lost money.
   */
  total_records: number
  tokens_bought: number
  tokens_attempted: number
  execution_success_rate: number
}

// Main PnL update function
async function updateAllUsersPnL(): Promise<PnLResult[]> {
  try {
    console.log('🔄 Starting PnL calculation for all users...')
    
    // Get all trading records from the last 30 days for better performance.
    // Chain is deliberately NOT filtered: RH (chain='robinhood', 0x wallets)
    // and Sol records both carry per-token priceUsd/tokenAmount (see
    // src/utils/rh-trade-record.ts), so the same average-cost engine below
    // realizes gains on both networks. Wallet addresses never collide across
    // chains (base58 vs 0x).
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    
    const { rows: records } = await query<TradingRecord>(
      `SELECT id, wallet_address, operation_type, timestamp, data
       FROM trading_records
       WHERE timestamp >= $1
       ORDER BY timestamp ASC`,
      [thirtyDaysAgo.toISOString()],
    )
    
    if (!records || records.length === 0) {
      console.log('📊 No trading records found')
      return []
    }
    
    // Group records by wallet address
    const walletRecords = new Map<string, TradingRecord[]>()
    records.forEach((record) => {
      const walletAddress = record.wallet_address
      if (!walletRecords.has(walletAddress)) {
        walletRecords.set(walletAddress, [])
      }
      walletRecords.get(walletAddress)!.push(record)
    })
    
    const results: PnLResult[] = []
    
    // Calculate PnL for each wallet
    for (const [walletAddress, userRecords] of Array.from(walletRecords.entries())) {
      try {
        const totalPnL = calculateWalletPnL(userRecords)
        // Execution stats, not trade stats: `userRecords.length` counts BATCHES while `successCount`
        // counts TOKENS, so they were never comparable and the labels made the wrong reading the
        // natural one. The units and the reasoning live in the helper.
        const executionStats = executionStatsForRecords(userRecords.map((r) => r.data))

        const pnlResult: PnLResult = {
          wallet_address: walletAddress,
          total_pnl_usd: totalPnL,
          total_records: executionStats.total_records,
          tokens_bought: executionStats.tokens_bought,
          tokens_attempted: executionStats.tokens_attempted,
          execution_success_rate: executionStats.execution_success_rate
        }
        
        results.push(pnlResult)
        
        const lastPnlUpdate = new Date().toISOString()
        try {
          await query(
            `INSERT INTO token_operations (wallet_address, trade_pnl, last_pnl_update)
             VALUES ($1, $2, $3)
             ON CONFLICT (wallet_address)
             DO UPDATE SET
               trade_pnl = EXCLUDED.trade_pnl,
               last_pnl_update = EXCLUDED.last_pnl_update`,
            [walletAddress, totalPnL, lastPnlUpdate],
          )
          console.log(`✅ Updated PnL for ${walletAddress}: $${totalPnL.toFixed(2)}`)
        } catch (updateError) {
          console.error(`Failed to update PnL for ${walletAddress}:`, updateError)
        }
        
      } catch (error) {
        console.error(`Error calculating PnL for ${walletAddress}:`, error)
      }
    }
    
    console.log(`🎉 PnL calculation completed for ${results.length} wallets`)
    return results
    
  } catch (error) {
    console.error('Failed to update PnL:', error)
    throw error
  }
}

// API route handler
export async function POST(request: NextRequest) {
  try {
    if (!isPnLUpdateAuthorized(request)) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }
    
    const results = await updateAllUsersPnL()
    
    return NextResponse.json({
      success: true,
      message: `Updated PnL for ${results.length} wallets`,
      results: results.slice(0, 10), // Return first 10 for debugging
      timestamp: new Date().toISOString()
    })
    
  } catch (error) {
    console.error('PnL update API error:', error)
    return NextResponse.json(
      { 
        error: 'Failed to update PnL',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

// GET endpoint for manual testing
export async function GET() {
  return NextResponse.json({
    message: 'PnL Update API',
    usage: 'POST with ?key= or Authorization: Bearer header to update PnL',
    timestamp: new Date().toISOString()
  })
}
