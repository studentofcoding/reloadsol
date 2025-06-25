import { compareTradeQuotes, checkProviderHealth } from './trade-comparison'
import { testSingleTrade, benchmarkProviders } from './trade-comparison-test'
import type { TradeQuoteRequest, ProviderQuote } from '@/types'

// Real Jupiter pools data fetched from https://datapi.jup.ag/v1/pools
const JUPITER_TEST_POOLS = [
  {
    id: "9C924XBrMo6argBZAkFbPNYH89V87kihGrFYrKCpump",
    baseAsset: "9C924XBrMo6argBZAkFbPNYH89V87kihGrFYrKCpump",
    baseSymbol: "PWEELON",
    quoteAsset: "So11111111111111111111111111111111111111112", // SOL
    dex: "pump.fun",
    liquidity: null,
    createdAt: "2024-01-15T10:30:00Z", // Example timestamp
    marketCap: null
  },
  {
    id: "Hi5Zi6RAdkX8tedsqau6Z8izCYLEHVYyVL5KqKiwpump",
    baseAsset: "Hi5Zi6RAdkX8tedsqau6Z8izCYLEHVYyVL5KqKiwpump",
    baseSymbol: "Course",
    quoteAsset: "So11111111111111111111111111111111111111112", // SOL
    dex: "pump.fun",
    liquidity: 4608.404363539797,
    createdAt: "2024-12-20T14:22:00Z", // Recent token
    marketCap: 15000
  },
  {
    id: "B87gKo64niCHj3486fWQAspAE7Ee1KK9rPEuiVnQpump",
    baseAsset: "B87gKo64niCHj3486fWQAspAE7Ee1KK9rPEuiVnQpump",
    baseSymbol: "LASER",
    quoteAsset: "So11111111111111111111111111111111111111112", // SOL
    dex: "pump.fun",
    liquidity: 5253.997787879333,
    createdAt: "2024-11-05T09:15:00Z", // Medium age
    marketCap: 18500
  },
  {
    id: "8VWoDvLNZJ45gcfM9cGwzdspkfEzrmL98NYoQx3eEnZd",
    baseAsset: "8VWoDvLNZJ45gcfM9cGwzdspkfEzrmL98NYoQx3eEnZd",
    baseSymbol: "PumpFunDev",
    quoteAsset: "So11111111111111111111111111111111111111112", // SOL
    dex: "pump.fun",
    liquidity: 4683.706383999845,
    createdAt: "2024-10-10T16:45:00Z", // Older token
    marketCap: 12000
  },
  {
    id: "Svw7H1f4yiyebDNQzMNt41sGmirhzJfyPNyCpnSpump",
    baseAsset: "Svw7H1f4yiyebDNQzMNt41sGmirhzJfyPNyCpnSpump",
    baseSymbol: "CLI",
    quoteAsset: "So11111111111111111111111111111111111111112", // SOL
    dex: "pump.fun",
    liquidity: 5541.324422819173,
    createdAt: "2024-12-25T20:30:00Z", // Very recent
    marketCap: 22000
  }
]

// Test amounts for different scenarios
const TEST_AMOUNTS = {
  SMALL: '10000000',    // 0.01 SOL or equivalent
  MEDIUM: '100000000',  // 0.1 SOL or equivalent  
  LARGE: '1000000000'   // 1 SOL or equivalent
}

// Test user public key (placeholder)
const TEST_USER_KEY = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'

// Enhanced interface for pool test results with detailed price comparison
interface PoolTestResult {
  poolId: string
  symbol: string
  tokenAge: {
    ageInDays: number
    ageCategory: 'NEW' | 'RECENT' | 'ESTABLISHED' | 'OLD'
    ageDisplay: string
    createdAt: string
  }
  marketCap: number | null
  buyTest: {
    success: boolean
    bestProvider?: string
    outputAmount?: string
    responseTime?: number
    priceComparison?: {
      providers: Record<string, {
        success: boolean
        outputAmount: string
        priceImpact: string
        fee?: {
          totalFeeLamports: number
          feePercentage: number
        }
        responseTime: number
        error?: string
      }>
      bestPrice: {
        provider: string
        outputAmount: string
        advantage: string // percentage better than average
      }
      worstPrice: {
        provider: string
        outputAmount: string
        disadvantage: string
      }
      avgPriceImpact: string
      priceSpread: string // difference between best and worst
    }
    providers: Record<string, { success: boolean; error?: string }>
  }
  sellTest: {
    success: boolean
    bestProvider?: string
    outputAmount?: string
    responseTime?: number
    priceComparison?: {
      providers: Record<string, {
        success: boolean
        outputAmount: string
        priceImpact: string
        fee?: {
          totalFeeLamports: number
          feePercentage: number
        }
        responseTime: number
        error?: string
      }>
      bestPrice: {
        provider: string
        outputAmount: string
        advantage: string
      }
      worstPrice: {
        provider: string
        outputAmount: string
        disadvantage: string
      }
      avgPriceImpact: string
      priceSpread: string
    }
    providers: Record<string, { success: boolean; error?: string }>
  }
  liquidity: number | null
  errors: string[]
}

// Helper function to calculate detailed price comparison
function calculatePriceComparison(quotes: ProviderQuote[], testType: 'buy' | 'sell') {
  const successfulQuotes = quotes.filter(q => q.success)
  
  if (successfulQuotes.length === 0) {
    return undefined
  }

  // Build provider data
  const providers: Record<string, any> = {}
  successfulQuotes.forEach(quote => {
    providers[quote.provider] = {
      success: true,
      outputAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct,
      fee: quote.fees,
      responseTime: quote.responseTime,
      error: undefined
    }
  })

  // Add failed quotes
  quotes.filter(q => !q.success).forEach(quote => {
    providers[quote.provider] = {
      success: false,
      outputAmount: '0',
      priceImpact: '0',
      fee: undefined,
      responseTime: quote.responseTime,
      error: quote.error
    }
  })

  // Find best and worst prices
  const amounts = successfulQuotes.map(q => parseFloat(q.outAmount))
  const avgAmount = amounts.reduce((sum, amt) => sum + amt, 0) / amounts.length

  // For buy operations, higher output is better
  // For sell operations, higher output is also better (more SOL received)
  const bestQuote = successfulQuotes.reduce((best, current) => 
    parseFloat(current.outAmount) > parseFloat(best.outAmount) ? current : best
  )
  
  const worstQuote = successfulQuotes.reduce((worst, current) => 
    parseFloat(current.outAmount) < parseFloat(worst.outAmount) ? current : worst
  )

  const bestAmount = parseFloat(bestQuote.outAmount)
  const worstAmount = parseFloat(worstQuote.outAmount)

  // Calculate advantages/disadvantages
  const bestAdvantage = avgAmount > 0 ? (((bestAmount - avgAmount) / avgAmount) * 100).toFixed(2) : '0'
  const worstDisadvantage = avgAmount > 0 ? (((avgAmount - worstAmount) / avgAmount) * 100).toFixed(2) : '0'
  
  // Calculate price spread
  const priceSpread = worstAmount > 0 ? (((bestAmount - worstAmount) / worstAmount) * 100).toFixed(2) : '0'

  // Calculate average price impact
  const priceImpacts = successfulQuotes.map(q => parseFloat(q.priceImpactPct)).filter(p => !isNaN(p))
  const avgPriceImpact = priceImpacts.length > 0 
    ? (priceImpacts.reduce((sum, impact) => sum + impact, 0) / priceImpacts.length).toFixed(4)
    : '0'

  return {
    providers,
    bestPrice: {
      provider: bestQuote.provider,
      outputAmount: bestQuote.outAmount,
      advantage: `${bestAdvantage}%`
    },
    worstPrice: {
      provider: worstQuote.provider,
      outputAmount: worstQuote.outAmount,
      disadvantage: `${worstDisadvantage}%`
    },
    avgPriceImpact: `${avgPriceImpact}%`,
    priceSpread: `${priceSpread}%`
  }
}

export async function testJupiterPoolsTrading(): Promise<{
  summary: {
    totalPools: number
    successfulBuyTests: number
    successfulSellTests: number
    averageResponseTime: number
    providerPerformance: Record<string, { successes: number; failures: number; avgResponseTime: number }>
    priceAnalysis: {
      avgBuyPriceSpread: string
      avgSellPriceSpread: string
      avgBuyPriceImpact: string
      avgSellPriceImpact: string
      bestBuyProvider: string
      bestSellProvider: string
    }
  }
  results: PoolTestResult[]
  providerHealth: Record<string, boolean>
}> {
  console.log('🚀 Starting Jupiter Pools Trading Tests with Real Pool Data')
  console.log(`Testing ${JUPITER_TEST_POOLS.length} pools with buy/sell operations...`)

  // Check provider health first
  console.log('\n🔍 Checking provider health...')
  const providerHealth = await checkProviderHealth()
  console.log('Provider health status:', providerHealth)

  const results: PoolTestResult[] = []
  const providerStats: Record<string, { successes: number; failures: number; responseTimes: number[] }> = {
    jupiter: { successes: 0, failures: 0, responseTimes: [] },
    dflow: { successes: 0, failures: 0, responseTimes: [] },
    'solana-tracker': { successes: 0, failures: 0, responseTimes: [] }
  }

  // Track price analysis data
  const priceAnalysisData = {
    buyPriceSpreads: [] as number[],
    sellPriceSpreads: [] as number[],
    buyPriceImpacts: [] as number[],
    sellPriceImpacts: [] as number[],
    buyProviderWins: {} as Record<string, number>,
    sellProviderWins: {} as Record<string, number>
  }

  for (const pool of JUPITER_TEST_POOLS) {
    console.log(`\n💰 Testing Pool: ${pool.baseSymbol} (${pool.id})`)
    console.log(`   Liquidity: ${pool.liquidity || 'Unknown'}`)
    
    const poolResult: PoolTestResult = {
      poolId: pool.id,
      symbol: pool.baseSymbol,
      tokenAge: getTokenAge(pool.createdAt),
      marketCap: pool.marketCap,
      buyTest: { success: false, providers: {} },
      sellTest: { success: false, providers: {} },
      liquidity: pool.liquidity,
      errors: []
    }

    try {
      // TEST 1: BUY - SOL → Token (using medium amount)
      console.log(`   🟢 Testing BUY: SOL → ${pool.baseSymbol}`)
      const buyRequest: TradeQuoteRequest = {
        inputMint: pool.quoteAsset, // SOL
        outputMint: pool.baseAsset, // Token
        amount: TEST_AMOUNTS.MEDIUM,
        slippageBps: 100,
        userPublicKey: TEST_USER_KEY
      }

      const buyComparison = await compareTradeQuotes(buyRequest)
      
      // Process buy test results
      poolResult.buyTest.success = buyComparison.summary.successfulQuotes > 0
      poolResult.buyTest.bestProvider = buyComparison.bestQuote?.provider
      poolResult.buyTest.outputAmount = buyComparison.bestQuote?.outAmount
      poolResult.buyTest.responseTime = buyComparison.summary.averageResponseTime
      
      // Calculate detailed price comparison for buy
      poolResult.buyTest.priceComparison = calculatePriceComparison(buyComparison.quotes, 'buy')

      buyComparison.quotes.forEach(quote => {
        poolResult.buyTest.providers[quote.provider] = {
          success: quote.success,
          error: quote.error
        }
        
        // Update provider stats
        if (quote.success) {
          providerStats[quote.provider].successes++
          providerStats[quote.provider].responseTimes.push(quote.responseTime)
        } else {
          providerStats[quote.provider].failures++
        }
      })

      // Track price analysis data for buy
      if (poolResult.buyTest.priceComparison) {
        const spread = parseFloat(poolResult.buyTest.priceComparison.priceSpread.replace('%', ''))
        const impact = parseFloat(poolResult.buyTest.priceComparison.avgPriceImpact.replace('%', ''))
        if (!isNaN(spread)) priceAnalysisData.buyPriceSpreads.push(spread)
        if (!isNaN(impact)) priceAnalysisData.buyPriceImpacts.push(impact)
        
        const winner = poolResult.buyTest.priceComparison.bestPrice.provider
        priceAnalysisData.buyProviderWins[winner] = (priceAnalysisData.buyProviderWins[winner] || 0) + 1
      }

      console.log(`      ✅ Buy Result: ${poolResult.buyTest.success ? 'SUCCESS' : 'FAILED'}`)
      if (poolResult.buyTest.success && poolResult.buyTest.priceComparison) {
        console.log(`         Best: ${poolResult.buyTest.priceComparison.bestPrice.provider} (${poolResult.buyTest.priceComparison.bestPrice.outputAmount} tokens, +${poolResult.buyTest.priceComparison.bestPrice.advantage} vs avg)`)
        console.log(`         Price Spread: ${poolResult.buyTest.priceComparison.priceSpread}, Avg Impact: ${poolResult.buyTest.priceComparison.avgPriceImpact}`)
      }

      // Wait between tests to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000))

      // TEST 2: SELL - Token → SOL (using small amount)
      console.log(`   🔴 Testing SELL: ${pool.baseSymbol} → SOL`)
      const sellRequest: TradeQuoteRequest = {
        inputMint: pool.baseAsset, // Token
        outputMint: pool.quoteAsset, // SOL
        amount: TEST_AMOUNTS.SMALL,
        slippageBps: 200, // Higher slippage for sell
        userPublicKey: TEST_USER_KEY
      }

      const sellComparison = await compareTradeQuotes(sellRequest)
      
      // Process sell test results
      poolResult.sellTest.success = sellComparison.summary.successfulQuotes > 0
      poolResult.sellTest.bestProvider = sellComparison.bestQuote?.provider
      poolResult.sellTest.outputAmount = sellComparison.bestQuote?.outAmount
      poolResult.sellTest.responseTime = sellComparison.summary.averageResponseTime
      
      // Calculate detailed price comparison for sell
      poolResult.sellTest.priceComparison = calculatePriceComparison(sellComparison.quotes, 'sell')

      sellComparison.quotes.forEach(quote => {
        poolResult.sellTest.providers[quote.provider] = {
          success: quote.success,
          error: quote.error
        }
        
        // Update provider stats
        if (quote.success) {
          providerStats[quote.provider].successes++
          providerStats[quote.provider].responseTimes.push(quote.responseTime)
        } else {
          providerStats[quote.provider].failures++
        }
      })

      // Track price analysis data for sell
      if (poolResult.sellTest.priceComparison) {
        const spread = parseFloat(poolResult.sellTest.priceComparison.priceSpread.replace('%', ''))
        const impact = parseFloat(poolResult.sellTest.priceComparison.avgPriceImpact.replace('%', ''))
        if (!isNaN(spread)) priceAnalysisData.sellPriceSpreads.push(spread)
        if (!isNaN(impact)) priceAnalysisData.sellPriceImpacts.push(impact)
        
        const winner = poolResult.sellTest.priceComparison.bestPrice.provider
        priceAnalysisData.sellProviderWins[winner] = (priceAnalysisData.sellProviderWins[winner] || 0) + 1
      }

      console.log(`      ✅ Sell Result: ${poolResult.sellTest.success ? 'SUCCESS' : 'FAILED'}`)
      if (poolResult.sellTest.success && poolResult.sellTest.priceComparison) {
        console.log(`         Best: ${poolResult.sellTest.priceComparison.bestPrice.provider} (${poolResult.sellTest.priceComparison.bestPrice.outputAmount} lamports, +${poolResult.sellTest.priceComparison.bestPrice.advantage} vs avg)`)
        console.log(`         Price Spread: ${poolResult.sellTest.priceComparison.priceSpread}, Avg Impact: ${poolResult.sellTest.priceComparison.avgPriceImpact}`)
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      poolResult.errors.push(errorMsg)
      console.log(`   ❌ Pool test failed: ${errorMsg}`)
    }

    results.push(poolResult)
    
    // Wait between pools to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000))
  }

  // Calculate summary statistics
  const successfulBuyTests = results.filter(r => r.buyTest.success).length
  const successfulSellTests = results.filter(r => r.sellTest.success).length
  
  const allResponseTimes = results.flatMap(r => [
    r.buyTest.responseTime || 0,
    r.sellTest.responseTime || 0
  ]).filter(t => t > 0)
  
  const averageResponseTime = allResponseTimes.length > 0 
    ? allResponseTimes.reduce((sum, time) => sum + time, 0) / allResponseTimes.length 
    : 0

  // Calculate provider performance
  const providerPerformance: Record<string, { successes: number; failures: number; avgResponseTime: number }> = {}
  
  Object.entries(providerStats).forEach(([provider, stats]) => {
    providerPerformance[provider] = {
      successes: stats.successes,
      failures: stats.failures,
      avgResponseTime: stats.responseTimes.length > 0 
        ? stats.responseTimes.reduce((sum, time) => sum + time, 0) / stats.responseTimes.length 
        : 0
    }
  })

  // Calculate price analysis summary
  const avgBuyPriceSpread = priceAnalysisData.buyPriceSpreads.length > 0 
    ? (priceAnalysisData.buyPriceSpreads.reduce((sum, spread) => sum + spread, 0) / priceAnalysisData.buyPriceSpreads.length).toFixed(2)
    : '0'
  
  const avgSellPriceSpread = priceAnalysisData.sellPriceSpreads.length > 0 
    ? (priceAnalysisData.sellPriceSpreads.reduce((sum, spread) => sum + spread, 0) / priceAnalysisData.sellPriceSpreads.length).toFixed(2)
    : '0'
  
  const avgBuyPriceImpact = priceAnalysisData.buyPriceImpacts.length > 0 
    ? (priceAnalysisData.buyPriceImpacts.reduce((sum, impact) => sum + impact, 0) / priceAnalysisData.buyPriceImpacts.length).toFixed(4)
    : '0'
  
  const avgSellPriceImpact = priceAnalysisData.sellPriceImpacts.length > 0 
    ? (priceAnalysisData.sellPriceImpacts.reduce((sum, impact) => sum + impact, 0) / priceAnalysisData.sellPriceImpacts.length).toFixed(4)
    : '0'

  // Find best providers
  const bestBuyProvider = Object.entries(priceAnalysisData.buyProviderWins).reduce((best, [provider, wins]) => 
    wins > (priceAnalysisData.buyProviderWins[best] || 0) ? provider : best, 'jupiter')
  
  const bestSellProvider = Object.entries(priceAnalysisData.sellProviderWins).reduce((best, [provider, wins]) => 
    wins > (priceAnalysisData.sellProviderWins[best] || 0) ? provider : best, 'jupiter')

  const summary = {
    totalPools: JUPITER_TEST_POOLS.length,
    successfulBuyTests,
    successfulSellTests,
    averageResponseTime: Math.round(averageResponseTime),
    providerPerformance,
    priceAnalysis: {
      avgBuyPriceSpread: `${avgBuyPriceSpread}%`,
      avgSellPriceSpread: `${avgSellPriceSpread}%`,
      avgBuyPriceImpact: `${avgBuyPriceImpact}%`,
      avgSellPriceImpact: `${avgSellPriceImpact}%`,
      bestBuyProvider,
      bestSellProvider
    }
  }

  console.log('\n📊 JUPITER POOLS TEST SUMMARY')
  console.log('================================')
  console.log(`Total Pools Tested: ${summary.totalPools}`)
  console.log(`Successful Buy Tests: ${summary.successfulBuyTests}/${summary.totalPools}`)
  console.log(`Successful Sell Tests: ${summary.successfulSellTests}/${summary.totalPools}`)
  console.log(`Average Response Time: ${summary.averageResponseTime}ms`)
  console.log('\nPrice Analysis:')
  console.log(`  Average Buy Price Spread: ${summary.priceAnalysis.avgBuyPriceSpread}`)
  console.log(`  Average Sell Price Spread: ${summary.priceAnalysis.avgSellPriceSpread}`)
  console.log(`  Average Buy Price Impact: ${summary.priceAnalysis.avgBuyPriceImpact}`)
  console.log(`  Average Sell Price Impact: ${summary.priceAnalysis.avgSellPriceImpact}`)
  console.log(`  Best Buy Provider: ${summary.priceAnalysis.bestBuyProvider}`)
  console.log(`  Best Sell Provider: ${summary.priceAnalysis.bestSellProvider}`)
  console.log('\nProvider Performance:')
  Object.entries(summary.providerPerformance).forEach(([provider, stats]) => {
    const successRate = ((stats.successes / (stats.successes + stats.failures)) * 100).toFixed(1)
    console.log(`  ${provider}: ${stats.successes} successes, ${stats.failures} failures (${successRate}% success rate, ${Math.round(stats.avgResponseTime)}ms avg)`)
  })

  return { summary, results, providerHealth }
}

// Stress test with multiple concurrent requests per pool
export async function stressTestJupiterPools(concurrentRequests: number = 3): Promise<{
  testType: 'stress'
  summary: {
    totalPools: number
    totalRequests: number
    successfulRequests: number
    averageResponseTime: number
    concurrentRequests: number
  }
  results: Array<{
    poolId: string
    symbol: string
    requests: Array<{
      success: boolean
      responseTime: number
      error?: string
    }>
    successRate: number
    averageResponseTime: number
  }>
}> {
  console.log(`\n🔥 STRESS TEST: Testing ${concurrentRequests} concurrent requests per pool`)
  
  const stressResults: Array<{
    poolId: string
    symbol: string
    requests: Array<{ success: boolean; responseTime: number; error?: string }>
    successRate: number
    averageResponseTime: number
  }> = []

  const testPools = JUPITER_TEST_POOLS.slice(0, 2) // Test first 2 pools to avoid overwhelming APIs
  
  for (const pool of testPools) {
    console.log(`\nStress testing ${pool.baseSymbol}...`)
    
    const requests = Array(concurrentRequests).fill(null).map(async (_, index) => {
      const request: TradeQuoteRequest = {
        inputMint: pool.quoteAsset,
        outputMint: pool.baseAsset,
        amount: TEST_AMOUNTS.SMALL,
        slippageBps: 100,
        userPublicKey: TEST_USER_KEY
      }
      
      const startTime = Date.now()
      try {
        const result = await compareTradeQuotes(request)
        const responseTime = Date.now() - startTime
        console.log(`  Request ${index + 1}: ${result.summary.successfulQuotes} successful quotes (${responseTime}ms)`)
        return { success: true, responseTime, error: undefined }
      } catch (error) {
        const responseTime = Date.now() - startTime
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        console.log(`  Request ${index + 1}: FAILED (${responseTime}ms) - ${errorMsg}`)
        return { success: false, responseTime, error: errorMsg }
      }
    })
    
    const requestResults = await Promise.all(requests)
    const successCount = requestResults.filter(r => r.success).length
    const avgTime = requestResults.reduce((sum, r) => sum + r.responseTime, 0) / requestResults.length
    const successRate = (successCount / concurrentRequests) * 100
    
    console.log(`  Results: ${successCount}/${concurrentRequests} successful (${Math.round(avgTime)}ms avg, ${successRate.toFixed(1)}% success rate)`)
    
    stressResults.push({
      poolId: pool.id,
      symbol: pool.baseSymbol,
      requests: requestResults,
      successRate,
      averageResponseTime: Math.round(avgTime)
    })
  }

  const totalRequests = stressResults.reduce((sum, pool) => sum + pool.requests.length, 0)
  const successfulRequests = stressResults.reduce((sum, pool) => sum + pool.requests.filter(r => r.success).length, 0)
  const allResponseTimes = stressResults.flatMap(pool => pool.requests.map(r => r.responseTime))
  const averageResponseTime = allResponseTimes.reduce((sum, time) => sum + time, 0) / allResponseTimes.length

  return {
    testType: 'stress',
    summary: {
      totalPools: testPools.length,
      totalRequests,
      successfulRequests,
      averageResponseTime: Math.round(averageResponseTime),
      concurrentRequests
    },
    results: stressResults
  }
}

// Quick benchmark test using pool data
export async function quickPoolsBenchmark(): Promise<{
  testType: 'benchmark'
  summary: {
    totalIterations: number
    testPool: string
    averageResponseTime: number
    fastestProvider: string
    slowestProvider: string
  }
  results: {
    providerPerformance: Record<string, {
      averageResponseTime: number
      successRate: number
      iterations: number
    }>
    iterations: Array<{
      iteration: number
      providers: Record<string, {
        success: boolean
        responseTime: number
        error?: string
      }>
    }>
  }
}> {
  console.log('\n⚡ QUICK BENCHMARK: Testing provider speeds with real pools')
  
  const testPool = JUPITER_TEST_POOLS[2] // Use LASER token pool
  const iterations = 3
  
  const benchmarkRequest: TradeQuoteRequest = {
    inputMint: testPool.quoteAsset,
    outputMint: testPool.baseAsset,
    amount: TEST_AMOUNTS.MEDIUM,
    slippageBps: 100,
    userPublicKey: TEST_USER_KEY
  }
  
  console.log(`Benchmarking with ${testPool.baseSymbol} (${testPool.baseAsset}) - ${iterations} iterations`)
  
  const iterationResults: Array<{
    iteration: number
    providers: Record<string, { success: boolean; responseTime: number; error?: string }>
  }> = []

  const providerStats: Record<string, { responseTimes: number[]; successes: number; failures: number }> = {
    jupiter: { responseTimes: [], successes: 0, failures: 0 },
    dflow: { responseTimes: [], successes: 0, failures: 0 },
    'solana-tracker': { responseTimes: [], successes: 0, failures: 0 }
  }

  const startTime = Date.now()
  
  for (let i = 0; i < iterations; i++) {
    console.log(`\n  Iteration ${i + 1}/${iterations}`)
    
    try {
      const result = await compareTradeQuotes(benchmarkRequest)
      
      const iterationData: Record<string, { success: boolean; responseTime: number; error?: string }> = {}
      
      result.quotes.forEach(quote => {
        iterationData[quote.provider] = {
          success: quote.success,
          responseTime: quote.responseTime,
          error: quote.error
        }
        
        if (quote.success) {
          providerStats[quote.provider].successes++
          providerStats[quote.provider].responseTimes.push(quote.responseTime)
        } else {
          providerStats[quote.provider].failures++
        }
      })
      
      iterationResults.push({
        iteration: i + 1,
        providers: iterationData
      })
      
      console.log(`    Results: ${result.summary.successfulQuotes} successful quotes, ${result.summary.averageResponseTime}ms avg`)
      
    } catch (error) {
      console.log(`    Iteration ${i + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
    
    // Wait between iterations
    if (i < iterations - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  
  const totalTime = Date.now() - startTime
  
  // Calculate provider performance
  const providerPerformance: Record<string, { averageResponseTime: number; successRate: number; iterations: number }> = {}
  let fastestProvider = ''
  let slowestProvider = ''
  let fastestTime = Infinity
  let slowestTime = 0
  
  Object.entries(providerStats).forEach(([provider, stats]) => {
    const totalAttempts = stats.successes + stats.failures
    const avgTime = stats.responseTimes.length > 0 
      ? stats.responseTimes.reduce((sum, time) => sum + time, 0) / stats.responseTimes.length 
      : 0
    const successRate = totalAttempts > 0 ? (stats.successes / totalAttempts) * 100 : 0
    
    providerPerformance[provider] = {
      averageResponseTime: Math.round(avgTime),
      successRate: Math.round(successRate * 10) / 10,
      iterations: totalAttempts
    }
    
    if (avgTime > 0 && avgTime < fastestTime) {
      fastestTime = avgTime
      fastestProvider = provider
    }
    if (avgTime > slowestTime) {
      slowestTime = avgTime
      slowestProvider = provider
    }
  })
  
  const allResponseTimes = Object.values(providerStats).flatMap(stats => stats.responseTimes)
  const overallAvgTime = allResponseTimes.length > 0 
    ? allResponseTimes.reduce((sum, time) => sum + time, 0) / allResponseTimes.length 
    : 0
  
  console.log(`\n📈 Benchmark completed in ${totalTime}ms`)
  console.log('Provider Performance:')
  Object.entries(providerPerformance).forEach(([provider, stats]) => {
    console.log(`  ${provider}: ${stats.averageResponseTime}ms avg, ${stats.successRate}% success rate`)
  })
  
  return {
    testType: 'benchmark',
    summary: {
      totalIterations: iterations,
      testPool: testPool.baseSymbol,
      averageResponseTime: Math.round(overallAvgTime),
      fastestProvider,
      slowestProvider
    },
    results: {
      providerPerformance,
      iterations: iterationResults
    }
  }
}

// Utility function to calculate token age
export const getTokenAge = (createdAt: string): {
  ageInDays: number
  ageCategory: 'NEW' | 'RECENT' | 'ESTABLISHED' | 'OLD'
  ageDisplay: string
  createdAt: string
} => {
  const created = new Date(createdAt)
  const now = new Date()
  const diffMs = now.getTime() - created.getTime()
  const ageInDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  let ageCategory: 'NEW' | 'RECENT' | 'ESTABLISHED' | 'OLD'
  let ageDisplay: string
  
  if (ageInDays <= 7) {
    ageCategory = 'NEW'
    ageDisplay = ageInDays === 0 ? 'Today' : `${ageInDays} day${ageInDays === 1 ? '' : 's'} old`
  } else if (ageInDays <= 30) {
    ageCategory = 'RECENT'
    ageDisplay = `${ageInDays} days old`
  } else if (ageInDays <= 90) {
    ageCategory = 'ESTABLISHED'
    ageDisplay = `${Math.floor(ageInDays / 7)} weeks old`
  } else {
    ageCategory = 'OLD'
    ageDisplay = `${Math.floor(ageInDays / 30)} months old`
  }
  
  return { ageInDays, ageCategory, ageDisplay, createdAt }
}

// Function to get random tokens from Jupiter API
export const getRandomTokens = async (count: number = 10): Promise<Array<{
  address: string
  symbol: string
  name: string
  decimals: number
  tags?: string[]
  extensions?: {
    coingeckoId?: string
  }
  logoURI?: string
}>> => {
  try {
    const response = await fetch('https://tokens.jup.ag/tokens?tags=verified', {
      headers: {
        'Accept': 'application/json',
      }
    })
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    
    const data = await response.json()
    const tokens = data || []
    
    // Shuffle and get random tokens
    const shuffled = tokens.sort(() => 0.5 - Math.random())
    return shuffled.slice(0, count)
  } catch (error) {
    console.error('Error fetching random tokens:', error)
    return []
  }
}

// Enhanced function to search token by address and get detailed stats
export const searchTokenStats = async (tokenAddress: string): Promise<{
  basic: {
    address: string
    symbol: string
    name: string
    decimals: number
    logoURI?: string
  }
  price?: {
    current: number
    change24h: number
    volume24h: number
    marketCap: number
  }
  age?: {
    ageInDays: number
    ageCategory: 'NEW' | 'RECENT' | 'ESTABLISHED' | 'OLD'
    ageDisplay: string
    createdAt: string
  }
  trading?: {
    holders: number
    totalSupply: string
    liquidity: number
  }
  metadata?: {
    description?: string
    website?: string
    twitter?: string
    telegram?: string
  }
} | null> => {
  try {
    // Get basic token info from Jupiter
    const jupiterResponse = await fetch(`https://tokens.jup.ag/token/${tokenAddress}`)
    
    if (!jupiterResponse.ok) {
      return null
    }
    
    const basicData = await jupiterResponse.json()
    
    // Get price data from Jupiter price API
    let priceData = null
    try {
      const priceResponse = await fetch(`https://lite-api.jup.ag/price/v2?ids=${tokenAddress}`)
      if (priceResponse.ok) {
        const priceJson = await priceResponse.json()
        priceData = priceJson.data?.[tokenAddress]
      }
    } catch (error) {
      console.warn('Price data unavailable:', error)
    }
    
    // Try to get creation timestamp from blockchain (simplified)
    let ageData = undefined
    try {
      // For demo purposes, we'll use a random date
      // In production, you'd query the blockchain for the token creation transaction
      const randomDaysAgo = Math.floor(Math.random() * 365)
      const createdAt = new Date()
      createdAt.setDate(createdAt.getDate() - randomDaysAgo)
      
      ageData = {
        ...getTokenAge(createdAt.toISOString()),
        createdAt: createdAt.toISOString()
      }
    } catch (error) {
      console.warn('Age data unavailable:', error)
    }
    
    return {
      basic: {
        address: tokenAddress,
        symbol: basicData.symbol || 'UNKNOWN',
        name: basicData.name || 'Unknown Token',
        decimals: basicData.decimals || 9,
        logoURI: basicData.logoURI
      },
      price: priceData ? {
        current: priceData.price || 0,
        change24h: priceData.change24h || 0,
        volume24h: priceData.volume24h || 0,
        marketCap: priceData.marketCap || 0
      } : undefined,
      age: ageData,
      trading: {
        holders: Math.floor(Math.random() * 10000), // Mock data
        totalSupply: '1000000000', // Mock data
        liquidity: Math.floor(Math.random() * 100000) // Mock data
      },
      metadata: {
        description: `${basicData.name} is a token on the Solana blockchain`,
        website: basicData.extensions?.website,
        twitter: basicData.extensions?.twitter,
        telegram: basicData.extensions?.telegram
      }
    }
  } catch (error) {
    console.error('Error searching token stats:', error)
    return null
  }
} 