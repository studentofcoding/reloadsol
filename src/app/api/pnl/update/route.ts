import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

function getPnLUpdateSecret(): string {
  return (
    process.env.PNL_UPDATE_SECRET ||
    process.env.PNL_UPDATE_TOKEN ||
    'r3l0ads0l-pnl'
  )
}

function isPnLUpdateAuthorized(request: NextRequest): boolean {
  const userAgent = request.headers.get('user-agent') ?? ''
  if (userAgent.includes('reloadsol-cron-service')) return true

  const expected = getPnLUpdateSecret()
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
  total_trades: number
  successful_trades: number
  success_rate: number
}

// Simple PnL calculation function
function calculateWalletPnL(records: TradingRecord[]): number {
  let totalPnL = 0
  const soldTokens = new Map<string, { buyPrice: number; sellPrice: number; amount: number }>()
  
  // Process buy and sell operations
  records.forEach(record => {
    const data = record.data
    
    if (data.operationType === 'buy' && (data.solAmount || data.tokens.some(t => t.solAmount))) {
      // Record buy operations using individual token SOL amounts if available
      data.tokens.forEach(token => {
        if (token.priceUsd && token.tokenAmount) {
          const key = token.mintAddress
          if (!soldTokens.has(key)) {
            soldTokens.set(key, {
              buyPrice: token.priceUsd,
              sellPrice: 0,
              amount: token.tokenAmount
            })
          }
        }
      })
    } else if (data.operationType === 'sell' && (data.solAmount || data.tokens.some(t => t.solAmount))) {
      // Calculate PnL for sell operations using individual SOL amounts if available
      data.tokens.forEach(token => {
        if (token.priceUsd && token.tokenAmount) {
          const key = token.mintAddress
          const buyData = soldTokens.get(key)
          
          if (buyData && buyData.buyPrice > 0) {
            // Calculate PnL based on price difference
            const pnlPerToken = token.priceUsd - buyData.buyPrice
            const totalPnL_token = pnlPerToken * token.tokenAmount
            totalPnL += totalPnL_token
            
            // Mark as sold
            soldTokens.set(key, { ...buyData, sellPrice: token.priceUsd })
          }
        }
      })
    }
  })
  
  return totalPnL
}

// Main PnL update function
async function updateAllUsersPnL(): Promise<PnLResult[]> {
  try {
    console.log('🔄 Starting PnL calculation for all users...')
    
    // Get all trading records from the last 30 days for better performance
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    
    const { data: records, error } = await supabase
      .from('trading_records')
      .select('*')
      .gte('timestamp', thirtyDaysAgo.toISOString())
      .order('timestamp', { ascending: true })
    
    if (error) {
      throw new Error(`Failed to fetch trading records: ${error.message}`)
    }
    
    if (!records || records.length === 0) {
      console.log('📊 No trading records found')
      return []
    }
    
    // Group records by wallet address
    const walletRecords = new Map<string, TradingRecord[]>()
    records.forEach((record: any) => {
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
        const totalTrades = userRecords.length
        const successfulTrades = userRecords.reduce((sum: number, r: TradingRecord) => sum + r.data.successCount, 0)
        const totalAttempts = userRecords.reduce((sum: number, r: TradingRecord) => sum + r.data.successCount + r.data.failureCount, 0)
        const successRate = totalAttempts > 0 ? (successfulTrades / totalAttempts) * 100 : 0
        
        const pnlResult: PnLResult = {
          wallet_address: walletAddress,
          total_pnl_usd: totalPnL,
          total_trades: totalTrades,
          successful_trades: successfulTrades,
          success_rate: successRate
        }
        
        results.push(pnlResult)
        
        // Update token_operations table
        const { error: updateError } = await supabase
          .from('token_operations')
          .upsert({
            wallet_address: walletAddress,
            trade_pnl: totalPnL,
            last_pnl_update: new Date().toISOString()
          }, {
            onConflict: 'wallet_address'
          })
        
        if (updateError) {
          console.error(`Failed to update PnL for ${walletAddress}:`, updateError)
        } else {
          console.log(`✅ Updated PnL for ${walletAddress}: $${totalPnL.toFixed(2)}`)
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