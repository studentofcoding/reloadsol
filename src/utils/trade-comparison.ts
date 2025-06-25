import { 
  TradeProvider, 
  TradeQuoteRequest, 
  ProviderQuote, 
  TradeComparison, 
  ProviderConfig 
} from '@/types'
import { getSwapQuote } from './jupiter'

// Provider configurations
const PROVIDER_CONFIG: ProviderConfig = {
  jupiter: {
    apiUrl: 'https://quote-api.jup.ag/v6',
    maxRetries: 3,
    timeout: 10000
  },
  dflow: {
    apiUrl: 'https://quote-api.dflow.net',
    maxRetries: 3,
    timeout: 15000
  },
  'dflow-intent': {
    apiUrl: 'https://quote-api.dflow.net',
    maxRetries: 3,
    timeout: 15000
  },
  solanaTracker: {
    apiUrl: 'https://swap-v2.solanatracker.io',
    maxRetries: 3,
    timeout: 12000
  },
  gmgn: {
    apiUrl: 'https://gmgn.ai/defi/router/v1/sol/tx',
    maxRetries: 3,
    timeout: 12000
  },
  'pump-swap': {
    apiUrl: 'https://pumpportal.fun/api',
    rpcUrl: 'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
    maxRetries: 3,
    timeout: 15000
  }
}

// Utility function for measuring execution time
function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; time: number }> {
  const start = Date.now()
  return fn().then(result => ({
    result,
    time: Date.now() - start
  }))
}

// Jupiter quote fetcher (using existing implementation)
async function getJupiterQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
  try {
    const { result: quote, time } = await measureTime(async () => {
      return await getSwapQuote(
        request.inputMint,
        request.outputMint,
        parseInt(request.amount),
        request.slippageBps
      )
    })

    if (!quote) {
      throw new Error('No quote received from Jupiter')
    }

    return {
      provider: 'jupiter',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      otherAmountThreshold: quote.otherAmountThreshold,
      slippageBps: quote.slippageBps,
      priceImpactPct: quote.priceImpactPct,
      responseTime: time,
      success: true,
      route: quote.routePlan,
      fees: quote.platformFee ? {
        totalFeeLamports: parseInt(quote.platformFee.amount),
        feePercentage: quote.platformFee.feeBps / 100
      } : undefined,
      providerData: {
        jupiter: {
          routePlan: quote.routePlan,
          timeTaken: time
        }
      }
    }
  } catch (error) {
    return {
      provider: 'jupiter',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown Jupiter error'
    }
  }
}

// DFlow quote fetcher (using imperative swaps API)
async function getDflowQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
  try {
    const { result: quote, time } = await measureTime(async () => {
      const queryParams = new URLSearchParams()
      queryParams.append('inputMint', request.inputMint)
      queryParams.append('outputMint', request.outputMint)
      queryParams.append('amount', request.amount)
      queryParams.append('slippageBps', request.slippageBps.toString())

      const response = await fetch(
        `${PROVIDER_CONFIG.dflow.apiUrl}/quote?${queryParams.toString()}`,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(PROVIDER_CONFIG.dflow.timeout)
        }
      )

      if (!response.ok) {
        throw new Error(`DFlow API error: ${response.status} ${response.statusText}`)
      }

      return await response.json()
    })

    return {
      provider: 'dflow',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: quote.inAmount || request.amount,
      outAmount: quote.outAmount || '0',
      otherAmountThreshold: quote.otherAmountThreshold || '0',
      slippageBps: request.slippageBps,
      priceImpactPct: quote.priceImpactPct || '0',
      responseTime: time,
      success: true,
      route: quote.routePlan || [],
      fees: quote.platformFee ? {
        totalFeeLamports: parseInt(quote.platformFee.amount || '0'),
        feePercentage: (quote.platformFee.feeBps || 0) / 100
      } : undefined,
      providerData: {
        dflow: {
          intentId: quote.intentId,
          guaranteedAmount: quote.guaranteedAmount,
          estimatedTime: quote.estimatedTime
        }
      }
    }
  } catch (error) {
    return {
      provider: 'dflow',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown DFlow error'
    }
  }
}

// DFlow Intent quote fetcher (using intent API endpoint)
async function getDflowIntentQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
  try {
    const { result: quote, time } = await measureTime(async () => {
      const queryParams = new URLSearchParams()
      queryParams.append('userPublicKey', request.userPublicKey || '')
      queryParams.append('inputMint', request.inputMint)
      queryParams.append('outputMint', request.outputMint)
      queryParams.append('amount', request.amount)
      queryParams.append('wrapAndUnwrapSol', 'true')
      queryParams.append('slippageBps', request.slippageBps.toString())

      const response = await fetch(
        `${PROVIDER_CONFIG['dflow-intent'].apiUrl}/intent?${queryParams.toString()}`,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(PROVIDER_CONFIG['dflow-intent'].timeout)
        }
      )

      if (!response.ok) {
        throw new Error(`DFlow Intent API error: ${response.status} ${response.statusText}`)
      }

      return await response.json()
    })

    return {
      provider: 'dflow-intent',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: quote.inAmount || request.amount,
      outAmount: quote.outAmount || '0',
      otherAmountThreshold: quote.otherAmountThreshold || quote.minOutAmount || '0',
      slippageBps: request.slippageBps,
      priceImpactPct: quote.priceImpactPct || '0',
      responseTime: time,
      success: true,
      route: [],
      fees: quote.platformFee ? {
        totalFeeLamports: parseInt(quote.platformFee.amount || '0'),
        feePercentage: (quote.platformFee.feeBps || 0) / 100
      } : quote.feeBudget ? {
        totalFeeLamports: quote.feeBudget,
        feePercentage: 0 // Intent API doesn't provide fee percentage directly
      } : undefined,
      providerData: {
        'dflow-intent': {
          intentId: quote.intentId,
          openTransaction: quote.openTransaction,
          lastValidBlockHeight: quote.lastValidBlockHeight,
          expiry: quote.expiry,
          feeBudget: quote.feeBudget,
          timeTaken: time
        }
      }
    }
  } catch (error) {
    return {
      provider: 'dflow-intent',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown DFlow Intent error'
    }
  }
}

// Solana Tracker quote fetcher
async function getSolanaTrackerQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
  try {
    const { result: quote, time } = await measureTime(async () => {
      // Use Solana Tracker swap API with GET request
      const queryParams = new URLSearchParams()
      queryParams.append('from', request.inputMint)
      queryParams.append('to', request.outputMint)
      
      // Convert amount from lamports to proper decimal format
      const amountInSol = parseFloat(request.amount) / 1_000_000_000 // Convert lamports to SOL
      queryParams.append('fromAmount', amountInSol.toString())
      
      // Convert slippageBps to percentage (1000 bps = 10%)
      const slippagePercentage = request.slippageBps / 100
      queryParams.append('slippage', slippagePercentage.toString())
      queryParams.append('payer', request.userPublicKey || '')

      const response = await fetch(
        `${PROVIDER_CONFIG.solanaTracker.apiUrl}/swap?${queryParams.toString()}`,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(PROVIDER_CONFIG.solanaTracker.timeout)
        }
      )

      if (!response.ok) {
        throw new Error(`Solana Tracker API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      
      // Validate response structure
      if (!data.rate || typeof data.rate.amountOut !== 'number') {
        throw new Error('Invalid Solana Tracker response format')
      }

      return data
    })

    // Convert amounts back to token units (considering decimals)
    const outputAmount = quote.rate.amountOut * Math.pow(10, quote.rate.quoteCurrency?.decimals || 6)
    const minAmountOut = quote.rate.minAmountOut * Math.pow(10, quote.rate.quoteCurrency?.decimals || 6)

    return {
      provider: 'solana-tracker',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: Math.floor(outputAmount).toString(),
      otherAmountThreshold: Math.floor(minAmountOut).toString(),
      slippageBps: request.slippageBps,
      priceImpactPct: (quote.rate.priceImpact * 100).toString(), // Convert to percentage
      responseTime: time,
      success: true,
      route: [],
      fees: quote.rate.platformFeeUI ? {
        totalFeeLamports: Math.floor(quote.rate.platformFee || 0),
        feePercentage: quote.rate.platformFeeUI * 100 // Convert to percentage
      } : undefined,
      providerData: {
        solanaTracker: {
          txn: quote.txn,
          type: quote.type,
          timeTaken: quote.timeTaken,
          executionPrice: quote.rate.executionPrice,
          currentPrice: quote.rate.currentPrice
        }
      }
    }
  } catch (error) {
    return {
      provider: 'solana-tracker',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown Solana Tracker error'
    }
  }
}

// GMGN quote fetcher
async function getGmgnQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
  try {
    const { result: quote, time } = await measureTime(async () => {
      // Convert amount from string to proper format for GMGN API
      const amountValue = parseFloat(request.amount)
      
      // Build the GMGN API URL
      const queryParams = new URLSearchParams()
      queryParams.append('token_in_address', request.inputMint)
      queryParams.append('token_out_address', request.outputMint)
      queryParams.append('in_amount', amountValue.toString())
      queryParams.append('from_address', request.userPublicKey || '')
      queryParams.append('slippage', (request.slippageBps / 100).toString()) // Convert bps to percentage

      const response = await fetch(
        `${PROVIDER_CONFIG.gmgn.apiUrl}/get_swap_route?${queryParams.toString()}`,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; Trade-Comparison-Bot/1.0)'
          },
          signal: AbortSignal.timeout(PROVIDER_CONFIG.gmgn.timeout)
        }
      )

      if (!response.ok) {
        throw new Error(`GMGN API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      
      // Validate response structure (adapt based on actual GMGN response format)
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid GMGN response format')
      }

      return data
    })

    // Extract relevant data from GMGN response (adapt based on actual response structure)
    const outAmount = quote.out_amount || quote.outAmount || '0'
    const priceImpact = quote.price_impact || quote.priceImpact || 0
    const minAmountOut = quote.min_amount_out || quote.minAmountOut || outAmount

    return {
      provider: 'gmgn',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: outAmount.toString(),
      otherAmountThreshold: minAmountOut.toString(),
      slippageBps: request.slippageBps,
      priceImpactPct: (priceImpact * 100).toString(),
      responseTime: time,
      success: true,
      route: quote.route || [],
      fees: quote.fees ? {
        totalFeeLamports: parseInt(quote.fees.total || '0'),
        feePercentage: parseFloat(quote.fees.percentage || '0')
      } : undefined,
      providerData: {
        gmgn: {
          routeData: quote.route,
          estimatedGas: quote.estimated_gas,
          estimatedTime: quote.estimated_time,
          poolInfo: quote.pool_info,
          timeTaken: time
        }
      }
    }
  } catch (error) {
    return {
      provider: 'gmgn',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown GMGN error'
    }
  }
}

// Pump.fun quote fetcher (using PumpPortal API)
async function getPumpSwapQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
  try {
    const { result: quote, time } = await measureTime(async () => {
      // Convert amount to SOL for pump swap calculation
      const amountInSol = parseFloat(request.amount) / 1e9
      
      // Get quote using PumpPortal local trade API
      const response = await fetch(`${PROVIDER_CONFIG['pump-swap'].apiUrl}/trade-local`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          publicKey: request.userPublicKey || '11111111111111111111111111111111',
          action: 'buy',
          mint: request.outputMint,
          denominatedInSol: 'true',
          amount: amountInSol,
          slippage: request.slippageBps / 100, // Convert bps to percentage
          priorityFee: 0.00001,
          pool: 'pump'
        }),
        signal: AbortSignal.timeout(PROVIDER_CONFIG['pump-swap'].timeout)
      })

      if (!response.ok) {
        throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`)
      }

      // For quotes, we'll simulate the transaction data
      // In a real implementation, you'd parse the transaction to get expected output
      // For now, we'll use market data estimation
      
      // Fallback to market estimation since PumpPortal returns transaction data
      // This is a simplified calculation - in production you'd parse the transaction
      const estimatedPrice = 0.00001 // Placeholder price for pump swap tokens
      const estimatedOutput = Math.floor(amountInSol / estimatedPrice)
      const priceImpact = Math.min((amountInSol / 1000) * 100, 15) // Estimate based on trade size
      
      return {
        success: true,
        estimatedOutput: estimatedOutput.toString(),
        estimatedPrice,
        priceImpact,
        transactionReady: true
      }
    })

    return {
      provider: 'pump-swap',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: quote.estimatedOutput,
      otherAmountThreshold: Math.floor(parseFloat(quote.estimatedOutput) * (1 - request.slippageBps / 10000)).toString(),
      slippageBps: request.slippageBps,
      priceImpactPct: quote.priceImpact.toFixed(4),
      responseTime: time,
      success: true,
      route: [{
        type: 'pump-swap-bonding-curve',
        tokenAddress: request.outputMint,
        price: quote.estimatedPrice
      }],
      fees: {
        totalFeeLamports: Math.floor(parseFloat(request.amount) * 0.005), // 0.5% PumpPortal fee
        feePercentage: 0.5
      },
      providerData: {
        'pump-swap': {
          poolData: { transactionReady: quote.transactionReady },
          bondingCurvePrice: quote.estimatedPrice,
          marketCap: 0, // Not available in this API
          liquidityUsd: 0, // Not available in this API
          timeTaken: time,
          rpcEndpoint: PROVIDER_CONFIG['pump-swap'].rpcUrl
        }
      }
    }
  } catch (error) {
    return {
      provider: 'pump-swap',
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown Pump.fun error'
    }
  }
}

// Main comparison function
export async function compareTradeQuotes(request: TradeQuoteRequest): Promise<TradeComparison> {
  console.log('🔄 Starting trade comparison for:', {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
    slippageBps: request.slippageBps
  })

  // Fetch quotes from all providers in parallel
  const [jupiterQuote, dflowQuote, dflowIntentQuote, solanaTrackerQuote, gmgnQuote, pumpfunQuote] = await Promise.all([
    getJupiterQuote(request),
    getDflowQuote(request),
    getDflowIntentQuote(request),
    getSolanaTrackerQuote(request),
    getGmgnQuote(request),
    getPumpfunQuote(request)
  ])

  const quotes = [jupiterQuote, dflowQuote, dflowIntentQuote, solanaTrackerQuote, gmgnQuote, pumpfunQuote]
  const successfulQuotes = quotes.filter(q => q.success)

  // Find best quote by output amount
  let bestQuote: ProviderQuote | null = null
  if (successfulQuotes.length > 0) {
    bestQuote = successfulQuotes.reduce((best, current) => 
      parseFloat(current.outAmount) > parseFloat(best.outAmount) ? current : best
    )
  }

  // Calculate comparison metrics
  const comparison = calculateComparison(successfulQuotes)
  const summary = calculateSummary(quotes, bestQuote)

  console.log('✅ Trade comparison completed:', {
    totalQuotes: quotes.length,
    successful: successfulQuotes.length,
    bestProvider: bestQuote?.provider,
    bestAmount: bestQuote?.outAmount
  })

  return {
    request,
    quotes,
    bestQuote,
    comparison,
    summary,
    timestamp: Date.now()
  }
}

function calculateComparison(quotes: ProviderQuote[]) {
  if (quotes.length === 0) {
    return {
      bestPrice: { provider: 'jupiter' as TradeProvider, outAmount: '0', advantage: '0%' },
      fastestResponse: { provider: 'jupiter' as TradeProvider, responseTime: 0 },
      lowestSlippage: { provider: 'jupiter' as TradeProvider, priceImpactPct: '0' },
      mostReliable: { provider: 'jupiter' as TradeProvider, successRate: 0 }
    }
  }

  // Best price
  const bestPriceQuote = quotes.reduce((best, current) =>
    parseFloat(current.outAmount) > parseFloat(best.outAmount) ? current : best
  )

  // Calculate advantage percentage
  const otherQuotes = quotes.filter(q => q.provider !== bestPriceQuote.provider)
  const avgOtherAmount = otherQuotes.length > 0 
    ? otherQuotes.reduce((sum, q) => sum + parseFloat(q.outAmount), 0) / otherQuotes.length 
    : parseFloat(bestPriceQuote.outAmount)
  
  const advantage = avgOtherAmount > 0 
    ? (((parseFloat(bestPriceQuote.outAmount) - avgOtherAmount) / avgOtherAmount) * 100).toFixed(2) + '%'
    : '0%'

  // Fastest response
  const fastestQuote = quotes.reduce((fastest, current) =>
    current.responseTime < fastest.responseTime ? current : fastest
  )

  // Lowest slippage
  const lowestSlippageQuote = quotes.reduce((lowest, current) =>
    parseFloat(current.priceImpactPct) < parseFloat(lowest.priceImpactPct) ? current : lowest
  )

  return {
    bestPrice: {
      provider: bestPriceQuote.provider,
      outAmount: bestPriceQuote.outAmount,
      advantage
    },
    fastestResponse: {
      provider: fastestQuote.provider,
      responseTime: fastestQuote.responseTime
    },
    lowestSlippage: {
      provider: lowestSlippageQuote.provider,
      priceImpactPct: lowestSlippageQuote.priceImpactPct
    },
    mostReliable: {
      provider: bestPriceQuote.provider, // Simplified - could be based on historical data
      successRate: 100 // Simplified - could be based on historical data
    }
  }
}

function calculateSummary(quotes: ProviderQuote[], bestQuote: ProviderQuote | null) {
  const successfulQuotes = quotes.filter(q => q.success)
  const failedQuotes = quotes.filter(q => !q.success)
  const averageResponseTime = quotes.length > 0 
    ? quotes.reduce((sum, q) => sum + q.responseTime, 0) / quotes.length 
    : 0

  // Determine recommendation based on multiple factors
  let recommendation: TradeProvider = 'jupiter'
  let recommendationReason = 'Default fallback'

  if (bestQuote) {
    // Weight factors: 50% price, 30% speed, 20% reliability
    const providerScores = successfulQuotes.map(quote => {
      const priceScore = parseFloat(quote.outAmount)
      const speedScore = 10000 / Math.max(quote.responseTime, 1) // Inverse of response time
      const reliabilityScore = quote.success ? 100 : 0
      
      const totalScore = (priceScore * 0.5) + (speedScore * 0.3) + (reliabilityScore * 0.2)
      
      return { provider: quote.provider, score: totalScore, quote }
    })

    const bestProvider = providerScores.reduce((best, current) =>
      current.score > best.score ? current : best
    )

    recommendation = bestProvider.provider
    recommendationReason = `Best overall score: ${bestProvider.score.toFixed(2)} (price: ${bestProvider.quote.outAmount}, speed: ${bestProvider.quote.responseTime}ms)`
  }

  return {
    totalProvidersQueried: quotes.length,
    successfulQuotes: successfulQuotes.length,
    failedQuotes: failedQuotes.length,
    averageResponseTime: Math.round(averageResponseTime),
    recommendation,
    recommendationReason
  }
}

// Health check function for providers
export async function checkProviderHealth(): Promise<Record<TradeProvider, boolean>> {
  const healthChecks = await Promise.all([
    checkJupiterHealth(),
    checkDflowHealth(), 
    checkDflowIntentHealth(),
    checkSolanaTrackerHealth(),
    checkGmgnHealth(),
    checkPumpfunHealth()
  ])

  return {
    jupiter: healthChecks[0],
    dflow: healthChecks[1],
    'dflow-intent': healthChecks[2],
    'solana-tracker': healthChecks[3],
    gmgn: healthChecks[4],
    pumpfun: healthChecks[5]
  }
}

async function checkJupiterHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${PROVIDER_CONFIG.jupiter.apiUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function checkDflowHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${PROVIDER_CONFIG.dflow.apiUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function checkDflowIntentHealth(): Promise<boolean> {
  try {
    // Test with a simple intent request to check if the endpoint is working
    const response = await fetch(`${PROVIDER_CONFIG['dflow-intent'].apiUrl}/intent?userPublicKey=11111111111111111111111111111111&inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`, {
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function checkSolanaTrackerHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${PROVIDER_CONFIG.solanaTracker.apiUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function checkGmgnHealth(): Promise<boolean> {
  try {
    // Since GMGN might not have a dedicated health endpoint, we'll test with a simple request
    const response = await fetch(`${PROVIDER_CONFIG.gmgn.apiUrl}/get_swap_route?token_in_address=So11111111111111111111111111111111111111112&token_out_address=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&in_amount=1000000&from_address=11111111111111111111111111111111&slippage=1`, {
      signal: AbortSignal.timeout(5000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function checkPumpfunHealth(): Promise<boolean> {
  try {
    // Check if PumpPortal API is accessible with a simple test request
    const response = await fetch(`${PROVIDER_CONFIG.pumpfun.apiUrl}/trade-local`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        publicKey: '11111111111111111111111111111111',
        action: 'buy',
        mint: 'So11111111111111111111111111111111111111112',
        denominatedInSol: 'true',
        amount: 0.01,
        slippage: 1,
        priorityFee: 0.00001,
        pool: 'pump'
      }),
      signal: AbortSignal.timeout(5000)
    })
    // PumpPortal returns 400 for invalid tokens, which means API is working
    return response.status === 400 || response.ok
  } catch {
    return false
  }
} 