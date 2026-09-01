import { NextRequest, NextResponse, connection } from 'next/server'
import { runTradeComparisonTests, testSingleTrade, benchmarkProviders } from '@/utils/trade-comparison-test'

export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const testType = searchParams.get('type') || 'comprehensive'
    const iterations = parseInt(searchParams.get('iterations') || '3')

    console.log(`🧪 Running ${testType} tests...`)

    switch (testType) {
      case 'comprehensive':
        const comprehensiveResults = await runTradeComparisonTests()
        return NextResponse.json({
          testType: 'comprehensive',
          ...comprehensiveResults,
          timestamp: new Date().toISOString()
        })

      case 'benchmark':
        const benchmarkResults = await benchmarkProviders(iterations)
        return NextResponse.json({
          testType: 'benchmark',
          iterations,
          ...benchmarkResults,
          timestamp: new Date().toISOString()
        })

      case 'single':
        const inputMint = searchParams.get('inputMint') || 'So11111111111111111111111111111111111111112'
        const outputMint = searchParams.get('outputMint') || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        const amount = searchParams.get('amount') || '1000000000'
        const userPublicKey = searchParams.get('userPublicKey') || '11111111111111111111111111111111'

        const singleResult = await testSingleTrade(inputMint, outputMint, amount, userPublicKey)
        return NextResponse.json({
          testType: 'single',
          result: singleResult,
          timestamp: new Date().toISOString()
        })

      default:
        return NextResponse.json(
          {
            error: 'Invalid test type',
            supportedTypes: ['comprehensive', 'benchmark', 'single'],
            examples: {
              comprehensive: '/api/trade/test?type=comprehensive',
              benchmark: '/api/trade/test?type=benchmark&iterations=5',
              single: '/api/trade/test?type=single&inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&userPublicKey=YOUR_WALLET'
            }
          },
          { status: 400 }
        )
    }
  } catch (error) {
    console.error('❌ Test endpoint error:', error)
    
    return NextResponse.json(
      {
        error: 'Test execution failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { testType, config } = body

    switch (testType) {
      case 'custom-scenario':
        const { inputMint, outputMint, amount, userPublicKey, slippageBps } = config
        
        if (!inputMint || !outputMint || !amount || !userPublicKey) {
          return NextResponse.json(
            { error: 'Missing required fields for custom scenario' },
            { status: 400 }
          )
        }

        const result = await testSingleTrade(inputMint, outputMint, amount, userPublicKey, slippageBps)
        return NextResponse.json({
          testType: 'custom-scenario',
          config,
          result,
          timestamp: new Date().toISOString()
        })

      case 'stress-test':
        const { concurrent = 3, iterations = 5 } = config || {}
        
        console.log(`🔥 Running stress test: ${concurrent} concurrent requests, ${iterations} iterations`)
        
        const stressResults = []
        
        for (let i = 0; i < iterations; i++) {
          console.log(`Stress test iteration ${i + 1}/${iterations}`)
          
          const promises = Array(concurrent).fill(0).map(() => 
            testSingleTrade(
              'So11111111111111111111111111111111111111112',
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              '1000000000',
              '11111111111111111111111111111111'
            )
          )
          
          const iterationResults = await Promise.all(promises)
          stressResults.push({
            iteration: i + 1,
            results: iterationResults,
            successRate: iterationResults.filter(r => r.success).length / iterationResults.length
          })
          
          // Brief pause between iterations
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        
        return NextResponse.json({
          testType: 'stress-test',
          config: { concurrent, iterations },
          results: stressResults,
          summary: {
            totalRequests: concurrent * iterations,
            overallSuccessRate: stressResults.reduce((acc, iter) => acc + iter.successRate, 0) / stressResults.length
          },
          timestamp: new Date().toISOString()
        })

      default:
        return NextResponse.json(
          { error: 'Invalid test type for POST request' },
          { status: 400 }
        )
    }
  } catch (error) {
    console.error('❌ POST test endpoint error:', error)
    
    return NextResponse.json(
      {
        error: 'Test execution failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
} 