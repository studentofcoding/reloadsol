import { NextRequest, NextResponse, connection } from 'next/server'
import { testJupiterPoolsTrading, stressTestJupiterPools, quickPoolsBenchmark } from '@/utils/jupiter-pools-test'

export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const testType = searchParams.get('type') || 'comprehensive'
    const format = searchParams.get('format') || 'json'

    console.log(`🚀 Running Jupiter pools test: ${testType}`)

    let result: any

    switch (testType) {
      case 'comprehensive':
        result = await testJupiterPoolsTrading()
        break
        
      case 'stress':
        const concurrent = parseInt(searchParams.get('concurrent') || '3')
        result = await stressTestJupiterPools(concurrent)
        break
        
      case 'benchmark':
        result = await quickPoolsBenchmark()
        break
        
      default:
        return NextResponse.json({ 
          error: 'Invalid test type. Use: comprehensive, stress, or benchmark' 
        }, { status: 400 })
    }

    // Return formatted response based on request
    if (format === 'summary' && testType === 'comprehensive') {
      return NextResponse.json({
        testType,
        timestamp: Date.now(),
        summary: result.summary,
        providerHealth: result.providerHealth,
        poolResults: result.results.map((r: any) => ({
          symbol: r.symbol,
          poolId: r.poolId,
          liquidity: r.liquidity,
          buySuccess: r.buyTest.success,
          sellSuccess: r.sellTest.success,
          bestBuyProvider: r.buyTest.bestProvider,
          bestSellProvider: r.sellTest.bestProvider
        }))
      })
    }

    return NextResponse.json({
      testType,
      timestamp: Date.now(),
      result
    })

  } catch (error) {
    console.error('Jupiter pools test error:', error)
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : 'Test execution failed',
      timestamp: Date.now()
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { testType = 'comprehensive', options = {} } = body

    console.log(`🚀 Running Jupiter pools POST test: ${testType}`, options)

    let result: any

    switch (testType) {
      case 'comprehensive':
        result = await testJupiterPoolsTrading()
        break
        
      case 'stress':
        const concurrent = options.concurrent || 3
        result = await stressTestJupiterPools(concurrent)
        break
        
      case 'benchmark':
        result = await quickPoolsBenchmark()
        break
        
      default:
        return NextResponse.json({ 
          error: 'Invalid test type. Use: comprehensive, stress, or benchmark' 
        }, { status: 400 })
    }

    return NextResponse.json({
      testType,
      timestamp: Date.now(),
      result,
      requestOptions: options
    })

  } catch (error) {
    console.error('Jupiter pools POST test error:', error)
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : 'Test execution failed',
      timestamp: Date.now()
    }, { status: 500 })
  }
} 