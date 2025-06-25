import { compareTradeQuotes, checkProviderHealth } from './trade-comparison'
import { TradeQuoteRequest } from '@/types'

// Test scenarios for comprehensive validation
const TEST_SCENARIOS = [
  {
    name: 'SOL to USDC (Large Amount)',
    request: {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '1000000000', // 1 SOL
      slippageBps: 100,
      userPublicKey: '11111111111111111111111111111111'
    }
  },
  {
    name: 'USDC to SOL (Medium Amount)',
    request: {
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: '100000000', // 100 USDC
      slippageBps: 50,
      userPublicKey: '11111111111111111111111111111111'
    }
  },
  {
    name: 'Small SOL to USDT',
    request: {
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      amount: '100000000', // 0.1 SOL
      slippageBps: 200,
      userPublicKey: '11111111111111111111111111111111'
    }
  }
]

interface TestResult {
  scenario: string
  success: boolean
  executionTime: number
  errors: string[]
  providerResults: {
    jupiter: { success: boolean; responseTime: number; error?: string }
    dflow: { success: boolean; responseTime: number; error?: string }
    'dflow-intent': { success: boolean; responseTime: number; error?: string }
    'solana-tracker': { success: boolean; responseTime: number; error?: string }
    gmgn: { success: boolean; responseTime: number; error?: string }
  }
  bestProvider?: string
  recommendation?: string
}

export async function runTradeComparisonTests(): Promise<{
  summary: {
    totalTests: number
    passed: number
    failed: number
    averageExecutionTime: number
    providerReliability: Record<string, number>
  }
  results: TestResult[]
}> {
  console.log('🧪 Starting comprehensive trade comparison tests...')
  
  const results: TestResult[] = []
  let totalExecutionTime = 0

  // Test provider health first
  console.log('🔍 Checking provider health...')
  const providerHealth = await checkProviderHealth()
  console.log('Provider health status:', providerHealth)

  // Run test scenarios
  for (const scenario of TEST_SCENARIOS) {
    console.log(`\n📋 Running test: ${scenario.name}`)
    
    const startTime = Date.now()
    const errors: string[] = []
    
    try {
      const comparison = await compareTradeQuotes(scenario.request)
      const executionTime = Date.now() - startTime
      totalExecutionTime += executionTime

      // Analyze results
      const providerResults = {
        jupiter: {
          success: comparison.quotes.find(q => q.provider === 'jupiter')?.success || false,
          responseTime: comparison.quotes.find(q => q.provider === 'jupiter')?.responseTime || 0,
          error: comparison.quotes.find(q => q.provider === 'jupiter')?.error
        },
        dflow: {
          success: comparison.quotes.find(q => q.provider === 'dflow')?.success || false,
          responseTime: comparison.quotes.find(q => q.provider === 'dflow')?.responseTime || 0,
          error: comparison.quotes.find(q => q.provider === 'dflow')?.error
        },
        'dflow-intent': {
          success: comparison.quotes.find(q => q.provider === 'dflow-intent')?.success || false,
          responseTime: comparison.quotes.find(q => q.provider === 'dflow-intent')?.responseTime || 0,
          error: comparison.quotes.find(q => q.provider === 'dflow-intent')?.error
        },
        'solana-tracker': {
          success: comparison.quotes.find(q => q.provider === 'solana-tracker')?.success || false,
          responseTime: comparison.quotes.find(q => q.provider === 'solana-tracker')?.responseTime || 0,
          error: comparison.quotes.find(q => q.provider === 'solana-tracker')?.error
        },
        gmgn: {
          success: comparison.quotes.find(q => q.provider === 'gmgn')?.success || false,
          responseTime: comparison.quotes.find(q => q.provider === 'gmgn')?.responseTime || 0,
          error: comparison.quotes.find(q => q.provider === 'gmgn')?.error
        }
      }

      // Validate results
      if (comparison.summary.successfulQuotes === 0) {
        errors.push('No successful quotes from any provider')
      }

      if (!comparison.bestQuote) {
        errors.push('No best quote determined')
      }

      if (comparison.summary.averageResponseTime > 30000) {
        errors.push('Average response time too high (>30s)')
      }

      results.push({
        scenario: scenario.name,
        success: errors.length === 0,
        executionTime,
        errors,
        providerResults,
        bestProvider: comparison.bestQuote?.provider,
        recommendation: comparison.summary.recommendation
      })

      console.log(`✅ ${scenario.name} completed:`, {
        success: errors.length === 0,
        executionTime,
        successfulQuotes: comparison.summary.successfulQuotes,
        bestProvider: comparison.bestQuote?.provider
      })

    } catch (error) {
      const executionTime = Date.now() - startTime
      totalExecutionTime += executionTime
      
      errors.push(error instanceof Error ? error.message : 'Unknown error')
      
      results.push({
        scenario: scenario.name,
        success: false,
        executionTime,
        errors,
        providerResults: {
          jupiter: { success: false, responseTime: 0, error: 'Test failed' },
          dflow: { success: false, responseTime: 0, error: 'Test failed' },
          'dflow-intent': { success: false, responseTime: 0, error: 'Test failed' },
          'solana-tracker': { success: false, responseTime: 0, error: 'Test failed' },
          gmgn: { success: false, responseTime: 0, error: 'Test failed' }
        }
      })

      console.log(`❌ ${scenario.name} failed:`, error)
    }
  }

  // Calculate summary statistics
  const passed = results.filter(r => r.success).length
  const failed = results.length - passed
  const averageExecutionTime = totalExecutionTime / results.length

  // Calculate provider reliability
  const providerReliability: Record<string, number> = {}
  const providers = ['jupiter', 'dflow', 'dflow-intent', 'solana-tracker', 'gmgn']
  
  providers.forEach(provider => {
    const successCount = results.reduce((acc, result) => 
      acc + (result.providerResults[provider as keyof typeof result.providerResults]?.success ? 1 : 0), 0
    )
    providerReliability[provider] = (successCount / results.length) * 100
  })

  const summary = {
    totalTests: results.length,
    passed,
    failed,
    averageExecutionTime: Math.round(averageExecutionTime),
    providerReliability
  }

  console.log('\n📊 Test Summary:', summary)
  
  return { summary, results }
}

// Utility function to test a single trade scenario
export async function testSingleTrade(
  inputMint: string,
  outputMint: string,
  amount: string,
  userPublicKey: string,
  slippageBps: number = 100
): Promise<TestResult> {
  const request: TradeQuoteRequest = {
    inputMint,
    outputMint,
    amount,
    slippageBps,
    userPublicKey
  }

  const startTime = Date.now()
  const errors: string[] = []

  try {
    const comparison = await compareTradeQuotes(request)
    const executionTime = Date.now() - startTime

    const providerResults = {
      jupiter: {
        success: comparison.quotes.find(q => q.provider === 'jupiter')?.success || false,
        responseTime: comparison.quotes.find(q => q.provider === 'jupiter')?.responseTime || 0,
        error: comparison.quotes.find(q => q.provider === 'jupiter')?.error
      },
      dflow: {
        success: comparison.quotes.find(q => q.provider === 'dflow')?.success || false,
        responseTime: comparison.quotes.find(q => q.provider === 'dflow')?.responseTime || 0,
        error: comparison.quotes.find(q => q.provider === 'dflow')?.error
      },
      'dflow-intent': {
        success: comparison.quotes.find(q => q.provider === 'dflow-intent')?.success || false,
        responseTime: comparison.quotes.find(q => q.provider === 'dflow-intent')?.responseTime || 0,
        error: comparison.quotes.find(q => q.provider === 'dflow-intent')?.error
      },
      'solana-tracker': {
        success: comparison.quotes.find(q => q.provider === 'solana-tracker')?.success || false,
        responseTime: comparison.quotes.find(q => q.provider === 'solana-tracker')?.responseTime || 0,
        error: comparison.quotes.find(q => q.provider === 'solana-tracker')?.error
      },
      gmgn: {
        success: comparison.quotes.find(q => q.provider === 'gmgn')?.success || false,
        responseTime: comparison.quotes.find(q => q.provider === 'gmgn')?.responseTime || 0,
        error: comparison.quotes.find(q => q.provider === 'gmgn')?.error
      }
    }

    return {
      scenario: `${inputMint.substring(0, 8)}... to ${outputMint.substring(0, 8)}...`,
      success: comparison.summary.successfulQuotes > 0,
      executionTime,
      errors,
      providerResults,
      bestProvider: comparison.bestQuote?.provider,
      recommendation: comparison.summary.recommendation
    }
  } catch (error) {
    return {
      scenario: `${inputMint.substring(0, 8)}... to ${outputMint.substring(0, 8)}...`,
      success: false,
      executionTime: Date.now() - startTime,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
      providerResults: {
        jupiter: { success: false, responseTime: 0, error: 'Test failed' },
        dflow: { success: false, responseTime: 0, error: 'Test failed' },
        'dflow-intent': { success: false, responseTime: 0, error: 'Test failed' },
        'solana-tracker': { success: false, responseTime: 0, error: 'Test failed' },
        gmgn: { success: false, responseTime: 0, error: 'Test failed' }
      }
    }
  }
}

// Performance benchmark utility
export async function benchmarkProviders(iterations: number = 5): Promise<{
  averageResponseTimes: Record<string, number>
  successRates: Record<string, number>
  reliability: Record<string, number>
}> {
  console.log(`🏃 Running performance benchmark with ${iterations} iterations...`)
  
  const testRequest: TradeQuoteRequest = {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '1000000000',
    slippageBps: 100,
    userPublicKey: '11111111111111111111111111111111'
  }

  const providerStats: Record<string, { times: number[]; successes: number }> = {
    jupiter: { times: [], successes: 0 },
    dflow: { times: [], successes: 0 },
    'dflow-intent': { times: [], successes: 0 },
    'solana-tracker': { times: [], successes: 0 },
    gmgn: { times: [], successes: 0 }
  }

  for (let i = 0; i < iterations; i++) {
    console.log(`Iteration ${i + 1}/${iterations}`)
    
    try {
      const comparison = await compareTradeQuotes(testRequest)
      
      comparison.quotes.forEach(quote => {
        const stats = providerStats[quote.provider]
        stats.times.push(quote.responseTime)
        if (quote.success) stats.successes++
      })
    } catch (error) {
      console.warn(`Iteration ${i + 1} failed:`, error)
    }

    // Wait between iterations to avoid rate limiting
    if (i < iterations - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  // Calculate statistics
  const averageResponseTimes: Record<string, number> = {}
  const successRates: Record<string, number> = {}
  const reliability: Record<string, number> = {}

  Object.entries(providerStats).forEach(([provider, stats]) => {
    averageResponseTimes[provider] = stats.times.length > 0 
      ? stats.times.reduce((sum, time) => sum + time, 0) / stats.times.length 
      : 0
    
    successRates[provider] = (stats.successes / iterations) * 100
    
    // Reliability score combines success rate and speed (lower response time is better)
    const speedScore = averageResponseTimes[provider] > 0 ? 10000 / averageResponseTimes[provider] : 0
    reliability[provider] = (successRates[provider] * 0.7) + (speedScore * 0.3)
  })

  console.log('📈 Benchmark results:', {
    averageResponseTimes,
    successRates,
    reliability
  })

  return { averageResponseTimes, successRates, reliability }
} 