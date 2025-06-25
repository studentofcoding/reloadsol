import { NextRequest, NextResponse } from 'next/server'
import { compareTradeQuotes, checkProviderHealth } from '@/utils/trade-comparison'
import { TradeQuoteRequest } from '@/types'

// Cache for provider health status
let providerHealthCache: Record<string, { status: boolean; timestamp: number }> = {}
const HEALTH_CACHE_DURATION = 1000 * 60 * 5 // 5 minutes

async function getProviderHealthStatus() {
  const now = Date.now()
  const cached = providerHealthCache['health']
  
  if (cached && (now - cached.timestamp) < HEALTH_CACHE_DURATION) {
    return cached.status
  }
  
  try {
    const health = await checkProviderHealth()
    const isHealthy = Object.values(health).some(status => status)
    
    providerHealthCache['health'] = {
      status: isHealthy,
      timestamp: now
    }
    
    return health
  } catch (error) {
    console.warn('Health check failed:', error)
    return { jupiter: true, dflow: false, 'solana-tracker': false }
  }
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

    console.log('🚀 Trade comparison request:', {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      userPublicKey: userPublicKey.substring(0, 8) + '...' // Log partial key for privacy
    })

    const tradeRequest: TradeQuoteRequest = {
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps,
      userPublicKey
    }

    // Get provider health status
    const providerHealth = await getProviderHealthStatus()

    // Execute trade comparison
    const startTime = Date.now()
    const comparison = await compareTradeQuotes(tradeRequest)
    const totalTime = Date.now() - startTime

    // Add metadata to response
    const response = {
      ...comparison,
      metadata: {
        executionTime: totalTime,
        providerHealth,
        api: {
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          requestId: generateRequestId()
        }
      }
    }

    console.log('✅ Trade comparison response:', {
      requestId: response.metadata.api.requestId,
      executionTime: totalTime,
      bestProvider: comparison.bestQuote?.provider,
      bestAmount: comparison.bestQuote?.outAmount,
      successfulQuotes: comparison.summary.successfulQuotes
    })

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
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