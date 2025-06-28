import { NextRequest, NextResponse } from 'next/server'
import { performEnhancedTradeComparison } from '@/utils/trade-comparison'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    
    // Validate required fields
    const { tokenAddress, tokenSymbol, buyAmountSol = 0.1 } = body
    
    if (!tokenAddress) {
      return NextResponse.json(
        { 
          error: 'Missing required field: tokenAddress',
          example: {
            tokenAddress: 'TokenAddressHere',
            tokenSymbol: 'TOKEN',
            buyAmountSol: 0.1
          }
        },
        { status: 400 }
      )
    }

    // Validate token address format
    if (tokenAddress.length < 32 || tokenAddress.length > 44) {
      return NextResponse.json(
        { error: 'Invalid token address format' },
        { status: 400 }
      )
    }

    // Basic Base58 character validation
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/
    if (!base58Regex.test(tokenAddress)) {
      return NextResponse.json(
        { error: 'Invalid token address characters' },
        { status: 400 }
      )
    }

    // Validate buy amount
    const amount = parseFloat(buyAmountSol)
    if (isNaN(amount) || amount <= 0 || amount > 1) {
      return NextResponse.json(
        { error: 'Buy amount must be between 0 and 1 SOL' },
        { status: 400 }
      )
    }

    console.log('🚀 Enhanced trade comparison request:', {
      tokenAddress,
      tokenSymbol,
      buyAmountSol: amount
    })

    // Execute enhanced trade comparison
    const startTime = Date.now()
    const result = await performEnhancedTradeComparison(
      tokenAddress,
      tokenSymbol,
      amount
    )
    const executionTime = Date.now() - startTime

    // Add metadata to response
    const response = {
      success: true,
      data: result,
      metadata: {
        executionTime,
        totalConfigurations: Object.keys(result.configurations).length,
        successfulConfigurations: Object.values(result.configurations).filter(c => c.success).length,
        api: {
          version: '2.0.0',
          timestamp: new Date().toISOString(),
          requestId: generateRequestId()
        }
      }
    }

    console.log('✅ Enhanced trade comparison response:', {
      requestId: response.metadata.api.requestId,
      executionTime,
      bestProvider: result.best_config?.provider,
      bestRpc: result.best_config?.rpc_used,
      successfulConfigs: response.metadata.successfulConfigurations
    })

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Request-ID': response.metadata.api.requestId,
        'X-Execution-Time': executionTime.toString()
      }
    })

  } catch (error) {
    console.error('❌ Enhanced trade comparison error:', error)
    
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
    
    const tokenAddress = searchParams.get('tokenAddress')
    const tokenSymbol = searchParams.get('tokenSymbol')
    const buyAmountSol = parseFloat(searchParams.get('buyAmountSol') || '0.1')

    if (!tokenAddress) {
      return NextResponse.json(
        {
          error: 'Missing required parameter: tokenAddress',
          example: '/api/trade/enhanced-compare?tokenAddress=TOKEN_ADDRESS&tokenSymbol=TOKEN&buyAmountSol=0.1'
        },
        { status: 400 }
      )
    }

    // Execute the same logic as POST
    const result = await performEnhancedTradeComparison(
      tokenAddress,
      tokenSymbol,
      buyAmountSol
    )

    return NextResponse.json({
      success: true,
      data: result,
      metadata: {
        api: {
          version: '2.0.0',
          timestamp: new Date().toISOString(),
          method: 'GET'
        }
      }
    })

  } catch (error) {
    console.error('❌ GET enhanced trade comparison error:', error)
    
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}

function generateRequestId(): string {
  return `enhanced_trade_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
} 