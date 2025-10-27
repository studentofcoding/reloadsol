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
  // 'pump-fun': {
  //   apiUrl: 'https://pumpportal.fun/api',
  //   rpcUrl: 'https://pump-fe.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b',
  //   maxRetries: 3,
  //   timeout: 15000
  // }
}

// Utility function for measuring execution time
async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; time: number }> {
  const start = Date.now()
  const result = await fn()
  const time = Date.now() - start
  return { result, time }
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
      // First get the quote
      const queryParams = new URLSearchParams()
      queryParams.append('inputMint', request.inputMint)
      queryParams.append('outputMint', request.outputMint)
      queryParams.append('amount', request.amount)
      queryParams.append('slippageBps', request.slippageBps.toString())

      const quoteResponse = await fetch(
        `https://quote-api.dflow.net/quote?${queryParams.toString()}`,
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(PROVIDER_CONFIG.dflow.timeout)
        }
      )

      if (!quoteResponse.ok) {
        throw new Error(`DFlow quote error: ${quoteResponse.status} ${quoteResponse.statusText}`)
      }

      const quoteData = await quoteResponse.json()

      // Then get the swap transaction
      const swapResponse = await fetch('https://quote-api.dflow.net/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userPublicKey: request.userPublicKey,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 150000, // Standard priority fee
          quoteResponse: quoteData,
          wrapAndUnwrapSol: true
        })
      })

      if (!swapResponse.ok) {
        throw new Error(`DFlow swap error: ${swapResponse.status} ${swapResponse.statusText}`)
      }

      const swapData = await swapResponse.json()

      return {
        quote: quoteData,
        swap: swapData
      }
    })

    return {
      provider: 'dflow' as TradeProvider,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: quote.quote.inAmount || request.amount,
      outAmount: quote.quote.outAmount || '0',
      otherAmountThreshold: quote.quote.minOutAmount || '0',
      slippageBps: request.slippageBps,
      priceImpactPct: quote.quote.priceImpactPct || '0',
      responseTime: time,
      success: true,
      route: quote.quote.routePlan || [],
      fees: {
        totalFeeLamports: quote.swap.prioritizationFeeLamports || 150000,
        feePercentage: 0
      },
      providerData: {
        dflow: {
          intentId: quote.quote.intentId,
          guaranteedAmount: quote.quote.guaranteedAmount,
          estimatedTime: quote.quote.estimatedTime
        }
      }
    }
  } catch (error) {
    console.error('DFlow quote error:', error)
    return {
      provider: 'dflow' as TradeProvider,
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
// async function getPumpFunQuote(request: TradeQuoteRequest): Promise<ProviderQuote> {
//   try {
//     const { result: quote, time } = await measureTime(async () => {
//       // Convert amount to SOL for pump.fun calculation
//       const amountInSol = parseFloat(request.amount) / 1e9

//       // Get quote using PumpPortal local trade API
//       const response = await fetch(`${PROVIDER_CONFIG['pump-fun'].apiUrl}/trade-local`, {
//         method: 'POST',
//         headers: {
//           'Content-Type': 'application/json',
//           'Accept': 'application/json'
//         },
//         body: JSON.stringify({
//           publicKey: request.userPublicKey || '11111111111111111111111111111111',
//           action: 'buy',
//           mint: request.outputMint,
//           denominatedInSol: 'true',
//           amount: amountInSol,
//           slippage: request.slippageBps / 100, // Convert bps to percentage
//           priorityFee: 0.00001,
//           pool: 'pump'
//         }),
//         signal: AbortSignal.timeout(PROVIDER_CONFIG['pump-fun'].timeout)
//       })

//       if (!response.ok) {
//         throw new Error(`PumpPortal API error: ${response.status} ${response.statusText}`)
//       }

//       // For quotes, we'll simulate the transaction data
//       // In a real implementation, you'd parse the transaction to get expected output
//       // For now, we'll use market data estimation

//       // Fallback to market estimation since PumpPortal returns transaction data
//       // This is a simplified calculation - in production you'd parse the transaction
//       const estimatedPrice = 0.00001 // Placeholder price for pump.fun tokens
//       const estimatedOutput = Math.floor(amountInSol / estimatedPrice)
//       const priceImpact = Math.min((amountInSol / 1000) * 100, 15) // Estimate based on trade size

//       return {
//         success: true,
//         estimatedOutput: estimatedOutput.toString(),
//         estimatedPrice,
//         priceImpact,
//         transactionReady: true
//       }
//     })

//     return {
//       provider: 'pump-fun',
//       inputMint: request.inputMint,
//       outputMint: request.outputMint,
//       inAmount: request.amount,
//       outAmount: quote.estimatedOutput,
//       otherAmountThreshold: Math.floor(parseFloat(quote.estimatedOutput) * (1 - request.slippageBps / 10000)).toString(),
//       slippageBps: request.slippageBps,
//       priceImpactPct: quote.priceImpact.toFixed(4),
//       responseTime: time,
//       success: true,
//       route: [{
//         type: 'pump-fun-bonding-curve',
//         tokenAddress: request.outputMint,
//         price: quote.estimatedPrice
//       }],
//       fees: {
//         totalFeeLamports: Math.floor(parseFloat(request.amount) * 0.005), // 0.5% PumpPortal fee
//         feePercentage: 0.5
//       },
//       providerData: {
//         'pump-fun': {
//           routePlan: [{
//             type: 'pump-fun-bonding-curve',
//             tokenAddress: request.outputMint,
//             price: quote.estimatedPrice
//           }],
//           marketPrice: quote.estimatedPrice,
//           liquidityUsd: 0, // Not available in this API
//           timeTaken: time,
//           rpcEndpoint: PROVIDER_CONFIG['pump-fun'].rpcUrl
//         }
//       }
//     }
//   } catch (error) {
//     return {
//       provider: 'pump-fun',
//       inputMint: request.inputMint,
//       outputMint: request.outputMint,
//       inAmount: request.amount,
//       outAmount: '0',
//       otherAmountThreshold: '0',
//       slippageBps: request.slippageBps,
//       priceImpactPct: '0',
//       responseTime: 0,
//       success: false,
//       error: error instanceof Error ? error.message : 'Unknown Pump.fun error'
//     }
//   }
// }

// Main comparison function
export async function compareTradeQuotes(request: TradeQuoteRequest): Promise<TradeComparison> {
  console.log('🔄 Starting trade comparison for:', {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
    slippageBps: request.slippageBps
  })

  // Fetch quotes from all providers in parallel
  const [jupiterQuote, dflowQuote, solanaTrackerQuote, gmgnQuote] = await Promise.all([
    getJupiterQuote(request),
    getDflowQuote(request),
    getSolanaTrackerQuote(request),
    getGmgnQuote(request),
    // getPumpFunQuote(request)
  ])

  const quotes = [jupiterQuote, dflowQuote, solanaTrackerQuote, gmgnQuote]
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
      bestPrice: {
        provider: 'jupiter' as TradeProvider,
        outAmount: '0',
        advantage: '0'
      },
      fastestResponse: {
        provider: 'jupiter' as TradeProvider,
        responseTime: 0
      },
      lowestSlippage: {
        provider: 'jupiter' as TradeProvider,
        priceImpactPct: '0'
      },
      mostReliable: {
        provider: 'jupiter' as TradeProvider,
        successRate: 0
      }
    }
  }

  // Find best price
  const successfulQuotes = quotes.filter(q => q.success && parseFloat(q.outAmount) > 0)
  const bestQuote = successfulQuotes.reduce((best, current) => {
    return parseFloat(current.outAmount) > parseFloat(best.outAmount) ? current : best
  }, successfulQuotes[0])

  // Calculate price advantage
  const bestAmount = parseFloat(bestQuote.outAmount)
  const nextBestAmount = successfulQuotes
    .filter(q => q.provider !== bestQuote.provider)
    .reduce((max, current) => Math.max(max, parseFloat(current.outAmount)), 0)

  const advantage = nextBestAmount > 0
    ? ((bestAmount - nextBestAmount) / nextBestAmount * 100).toFixed(2)
    : '0'

  // Find fastest response
  const fastestQuote = quotes.reduce((fastest, current) => {
    return current.responseTime < fastest.responseTime ? current : fastest
  }, quotes[0])

  // Find lowest slippage
  const lowestSlippageQuote = successfulQuotes.reduce((lowest, current) => {
    const currentImpact = parseFloat(current.priceImpactPct)
    const lowestImpact = parseFloat(lowest.priceImpactPct)
    return currentImpact < lowestImpact ? current : lowest
  }, successfulQuotes[0])

  // Calculate reliability scores
  const reliabilityScores = new Map<TradeProvider, number>()
  quotes.forEach(quote => {
    const provider = quote.provider
    const currentScore = reliabilityScores.get(provider) || 0
    reliabilityScores.set(provider, currentScore + (quote.success ? 1 : 0))
  })

  let mostReliableProvider: TradeProvider = 'jupiter'
  let highestReliability = 0

  reliabilityScores.forEach((score, provider) => {
    if (score > highestReliability) {
      highestReliability = score
      mostReliableProvider = provider
    }
  })

  return {
    bestPrice: {
      provider: bestQuote.provider,
      outAmount: bestQuote.outAmount,
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
      provider: mostReliableProvider,
      successRate: highestReliability
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
    checkSolanaTrackerHealth(),
    checkGmgnHealth(),
    // checkPumpFunHealth()
  ])

  return {
    jupiter: healthChecks[0],
    dflow: healthChecks[1],
    'solana-tracker': healthChecks[2],
    gmgn: healthChecks[3],
    // 'pump-fun': healthChecks[4]
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

// async function checkPumpFunHealth(): Promise<boolean> {
//   try {
//     // Check if PumpPortal API is accessible with a simple test request
//     const response = await fetch(`${PROVIDER_CONFIG['pump-fun'].apiUrl}/trade-local`, {
//       method: 'POST',
//       headers: {
//         'Accept': 'application/json',
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         publicKey: '11111111111111111111111111111111',
//         action: 'buy',
//         mint: 'So11111111111111111111111111111111111111112',
//         denominatedInSol: 'true',
//         amount: 0.01,
//         slippage: 1,
//         priorityFee: 0.00001,
//         pool: 'pump'
//       }),
//       signal: AbortSignal.timeout(5000)
//     })
//     // PumpPortal returns 400 for invalid tokens, which means API is working
//     return response.status === 400 || response.ok
//   } catch {
//     return false
//   }
// }

// Enhanced Trade Comparison with parallel processing and multiple configurations
interface EnhancedTradeConfig {
  slippage: number
  rpc?: string
  provider: TradeProvider
}

interface EnhancedComparisonResult {
  token_address: string
  token_symbol: string | null
  timestamp: string
  buy_amount_sol: number
  configurations: {
    [key: string]: {
      success: boolean
      response_time: number
      token_amount: string
      total_fees: number
      price_impact: string
      best_provider: string
      rpc_used?: string
      error?: string
    }
  }
  best_config: {
    slippage: number
    provider: string
    token_amount: string
    response_time: number
    total_fees: number
    rpc_used?: string
  } | null
  provider_performance: {
    [provider: string]: {
      success_rate: number
      avg_response_time: number
      best_slippage: number
      total_attempts: number
    }
  }
  rpc_performance: {
    [rpc: string]: {
      success_rate: number
      avg_response_time: number
      total_attempts: number
    }
  }
}

// RPC endpoints for testing redundancy
const RPC_ENDPOINTS = [
  { name: 'Helius', url: 'https://mainnet.helius-rpc.com/?api-key=1b8db865-a5a1-4535-9aec-01061440523b' },
  { name: 'Shyft', url: 'https://mainnet.helius-rpc.com/?api-key=9b707ec2-17da-4c3a-b17d-19bb3a58dd2d' },
  { name: 'SolanaTracker', url: 'https://rpc-mainnet.solanatracker.io/?api_key=3efd278f-9f1d-4888-ac0e-8d24014714d5' },
  { name: 'FluxBeam', url: 'https://eu.rpc.fluxbeam.xyz?key=94a42d66-8cc7-454a-9d33-513cff867307' }
]

// Cache for recent quotes (5 minute TTL)
const quoteCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Get cached quote if available and fresh
function getCachedQuote(cacheKey: string): any | null {
  const cached = quoteCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  if (cached) {
    quoteCache.delete(cacheKey) // Remove stale cache
  }
  return null
}

// Cache a quote
function setCachedQuote(cacheKey: string, data: any): void {
  quoteCache.set(cacheKey, { data, timestamp: Date.now() })
}

// Retry logic with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 100
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error')

      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 100
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError
}

// Enhanced quote fetcher with RPC redundancy
async function getEnhancedQuote(
  request: TradeQuoteRequest,
  provider: TradeProvider,
  rpcEndpoint?: string
): Promise<ProviderQuote & { rpc_used?: string }> {
  const cacheKey = `${provider}-${request.inputMint}-${request.outputMint}-${request.amount}-${request.slippageBps}-${rpcEndpoint || 'default'}`

  // Check cache first
  const cached = getCachedQuote(cacheKey)
  if (cached) {
    return { ...cached, rpc_used: rpcEndpoint }
  }

  let result: ProviderQuote & { rpc_used?: string }

  try {
    result = await retryWithBackoff(async () => {
      const startTime = Date.now()

      // Use the appropriate provider function based on type
      let quote: ProviderQuote
      switch (provider) {
        case 'jupiter':
          quote = await getJupiterQuote(request)
          break
        case 'dflow':
          quote = await getDflowQuote(request)
          break
        case 'solana-tracker':
          quote = await getSolanaTrackerQuote(request)
          break
        case 'gmgn':
          quote = await getGmgnQuote(request)
          break
        // case 'pump-fun':
        //   quote = await getPumpFunQuote(request)
        //   break
        default:
          throw new Error(`Unknown provider: ${provider}`)
      }

      const totalTime = Date.now() - startTime
      const enhancedQuote = {
        ...quote,
        responseTime: Math.max(quote.responseTime, totalTime),
        rpc_used: rpcEndpoint
      }

      // Cache successful quotes
      if (quote.success) {
        setCachedQuote(cacheKey, enhancedQuote)
      }

      return enhancedQuote
    }, 2, 200) // 2 retries with 200ms base delay

  } catch (error) {
    result = {
      provider,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inAmount: request.amount,
      outAmount: '0',
      otherAmountThreshold: '0',
      slippageBps: request.slippageBps,
      priceImpactPct: '0',
      responseTime: 0,
      success: false,
      error: error instanceof Error ? error.message : `Unknown ${provider} error`,
      rpc_used: rpcEndpoint
    }
  }

  return result
}

// Enhanced trade comparison function
export async function performEnhancedTradeComparison(
  tokenAddress: string,
  tokenSymbol: string | null,
  buyAmountSol: number = 0.1
): Promise<EnhancedComparisonResult> {
  console.log(`🚀 Starting enhanced trade comparison for ${tokenSymbol} (${tokenAddress})`)

  const SOL_MINT = 'So11111111111111111111111111111111111111112'
  const buyAmountLamports = Math.floor(buyAmountSol * 1e9)

  // Test configurations
  const slippageConfigs = [1, 2, 5] // 1%, 2%, 5%
  const providers: TradeProvider[] = ['jupiter', 'dflow', 'solana-tracker', 'gmgn']
  const rpcs = RPC_ENDPOINTS

  // Build all test combinations
  const testConfigurations: EnhancedTradeConfig[] = []

  for (const slippage of slippageConfigs) {
    for (const provider of providers) {
      for (const rpc of rpcs) {
        testConfigurations.push({
          slippage,
          provider,
          rpc: rpc.name
        })
      }
    }
  }

  console.log(`📊 Testing ${testConfigurations.length} configurations (${slippageConfigs.length} slippages × ${providers.length} providers × ${rpcs.length} RPCs)`)

  // Execute all tests in parallel with controlled concurrency
  const batchSize = 12 // Process 12 requests at a time to avoid overwhelming APIs
  const results: Array<{
    config: EnhancedTradeConfig
    quote: ProviderQuote & { rpc_used?: string }
  }> = []

  for (let i = 0; i < testConfigurations.length; i += batchSize) {
    const batch = testConfigurations.slice(i, i + batchSize)

    const batchPromises = batch.map(async (config) => {
      const request: TradeQuoteRequest = {
        inputMint: SOL_MINT,
        outputMint: tokenAddress,
        amount: buyAmountLamports.toString(),
        slippageBps: config.slippage * 100, // Convert percentage to basis points
        userPublicKey: '11111111111111111111111111111111' // Dummy key for comparison
      }

      const quote = await getEnhancedQuote(request, config.provider, config.rpc)
      // Detailed logging for each attempt
      if (quote.success) {
        console.log(
          `✅ [${config.provider}] [${config.rpc}] slippage=${config.slippage}% | outAmount=${quote.outAmount} | priceImpact=${quote.priceImpactPct} | responseTime=${quote.responseTime}ms`
        )
      } else {
        console.warn(
          `❌ [${config.provider}] [${config.rpc}] slippage=${config.slippage}% | ERROR: ${quote.error || 'Unknown error'} | responseTime=${quote.responseTime ?? 'N/A'}ms`
        )
      }
      return { config, quote }
    })

    const batchResults = await Promise.allSettled(batchPromises)

    batchResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      }
    })
    // Batch summary log
    const batchSuccess = batchResults.filter(r => r.status === 'fulfilled' && r.value.quote.success).length
    const batchFail = batchResults.filter(r => r.status === 'fulfilled' && !r.value.quote.success).length
    console.log(`Batch ${i / batchSize + 1}: ${batchSuccess} success, ${batchFail} failed out of ${batch.length}`)
    // Small delay between batches to be API-friendly
    if (i + batchSize < testConfigurations.length) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  console.log(`✅ Completed ${results.length}/${testConfigurations.length} test configurations`)

  // Aggregate results by slippage configuration
  const configurations: EnhancedComparisonResult['configurations'] = {}
  const providerPerformance: EnhancedComparisonResult['provider_performance'] = {}
  const rpcPerformance: EnhancedComparisonResult['rpc_performance'] = {}

  // Initialize performance tracking
  providers.forEach(provider => {
    providerPerformance[provider] = {
      success_rate: 0,
      avg_response_time: 0,
      best_slippage: 0,
      total_attempts: 0
    }
  })

  rpcs.forEach(rpc => {
    rpcPerformance[rpc.name] = {
      success_rate: 0,
      avg_response_time: 0,
      total_attempts: 0
    }
  })

  // Process results by slippage
  for (const slippage of slippageConfigs) {
    const slippageResults = results.filter(r => r.config.slippage === slippage)
    const successfulResults = slippageResults.filter(r => r.quote.success)

    let bestResult = null
    if (successfulResults.length > 0) {
      bestResult = successfulResults.reduce((best, current) => {
        const bestAmount = parseFloat(best.quote.outAmount)
        const currentAmount = parseFloat(current.quote.outAmount)
        return currentAmount > bestAmount ? current : best
      })
    }

    const configKey = `slippage_${slippage}`

    if (bestResult) {
      const fees = bestResult.quote.fees?.totalFeeLamports || 0
      configurations[configKey] = {
        success: true,
        response_time: bestResult.quote.responseTime,
        token_amount: bestResult.quote.outAmount,
        total_fees: fees / 1e9, // Convert to SOL
        price_impact: bestResult.quote.priceImpactPct,
        best_provider: bestResult.quote.provider,
        rpc_used: bestResult.quote.rpc_used
      }
    } else {
      configurations[configKey] = {
        success: false,
        response_time: 0,
        token_amount: '0',
        total_fees: 0,
        price_impact: '0',
        best_provider: 'none',
        error: slippageResults.length > 0 ? 'All providers failed' : 'No results'
      }
    }

    // Update provider performance for this slippage
    slippageResults.forEach(result => {
      const provider = result.config.provider
      const rpc = result.config.rpc!

      // Provider performance
      providerPerformance[provider].total_attempts++
      if (result.quote.success) {
        providerPerformance[provider].success_rate++
        providerPerformance[provider].avg_response_time += result.quote.responseTime

        // Track best slippage for this provider
        const currentAmount = parseFloat(result.quote.outAmount)
        const existingBest = providerPerformance[provider].best_slippage
        if (existingBest === 0 || currentAmount > existingBest) {
          providerPerformance[provider].best_slippage = slippage
        }
      }

      // RPC performance
      rpcPerformance[rpc].total_attempts++
      if (result.quote.success) {
        rpcPerformance[rpc].success_rate++
        rpcPerformance[rpc].avg_response_time += result.quote.responseTime
      }
    })
  }

  // Calculate final performance metrics
  Object.keys(providerPerformance).forEach(provider => {
    const perf = providerPerformance[provider]
    if (perf.total_attempts > 0) {
      perf.success_rate = (perf.success_rate / perf.total_attempts) * 100
      perf.avg_response_time = perf.success_rate > 0 ? perf.avg_response_time / (perf.total_attempts * perf.success_rate / 100) : 0
    }
  })

  Object.keys(rpcPerformance).forEach(rpc => {
    const perf = rpcPerformance[rpc]
    if (perf.total_attempts > 0) {
      perf.success_rate = (perf.success_rate / perf.total_attempts) * 100
      perf.avg_response_time = perf.success_rate > 0 ? perf.avg_response_time / (perf.total_attempts * perf.success_rate / 100) : 0
    }
  })

  // Determine overall best configuration
  const allSuccessful = results.filter(r => r.quote.success)
  let bestConfig = null

  if (allSuccessful.length > 0) {
    const overallBest = allSuccessful.reduce((best, current) => {
      const bestAmount = parseFloat(best.quote.outAmount)
      const currentAmount = parseFloat(current.quote.outAmount)
      return currentAmount > bestAmount ? current : best
    })

    const fees = overallBest.quote.fees?.totalFeeLamports || 0
    bestConfig = {
      slippage: overallBest.config.slippage,
      provider: overallBest.quote.provider,
      token_amount: overallBest.quote.outAmount,
      response_time: overallBest.quote.responseTime,
      total_fees: fees / 1e9,
      rpc_used: overallBest.quote.rpc_used
    }
  }

  const result: EnhancedComparisonResult = {
    token_address: tokenAddress,
    token_symbol: tokenSymbol,
    timestamp: new Date().toISOString(),
    buy_amount_sol: buyAmountSol,
    configurations,
    best_config: bestConfig,
    provider_performance: providerPerformance,
    rpc_performance: rpcPerformance
  }

  console.log(`🎯 Enhanced comparison completed for ${tokenSymbol}:`, {
    successful_configs: Object.values(configurations).filter(c => c.success).length,
    best_provider: bestConfig?.provider,
    best_amount: bestConfig?.token_amount,
    provider_performance: Object.entries(providerPerformance)
      .map(([p, perf]) => `${p}: ${perf.success_rate.toFixed(1)}%`)
      .join(', ')
  })

  return result
}

function getProviderRecommendation(quotes: ProviderQuote[], comparison: ReturnType<typeof calculateComparison>): { provider: TradeProvider; reason: string } {
  // Default to best price if available
  if (comparison.bestPrice.provider && parseFloat(comparison.bestPrice.advantage) > 1) {
    return {
      provider: comparison.bestPrice.provider,
      reason: `Best price with ${comparison.bestPrice.advantage}% advantage`
    }
  }

  // If price differences are minimal, prefer fastest response
  if (comparison.fastestResponse.provider && comparison.fastestResponse.responseTime < 1000) {
    return {
      provider: comparison.fastestResponse.provider,
      reason: `Fastest response time at ${comparison.fastestResponse.responseTime}ms`
    }
  }

  // If response times are similar, prefer lowest slippage
  if (comparison.lowestSlippage.provider && parseFloat(comparison.lowestSlippage.priceImpactPct) < 1) {
    return {
      provider: comparison.lowestSlippage.provider,
      reason: `Lowest price impact at ${comparison.lowestSlippage.priceImpactPct}%`
    }
  }

  // Fall back to most reliable provider
  return {
    provider: comparison.mostReliable.provider,
    reason: `Most reliable provider with ${comparison.mostReliable.successRate}% success rate`
  }
} 