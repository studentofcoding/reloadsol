// Token filtering pipeline extracted from src/app/api/trending/track/route.ts (REL-19).
import { query } from '@/utils/db'
import type { TokenFilterConfig } from '@/strategies/types'
import { DEFAULT_FILTER_CONFIG } from '@/strategies/registry'
import { resolveTradingStrategy } from '@/strategies/load-strategy'
import { mapPoolToTrackedToken } from './mappers'
import type { TokenFilterResult, FilteringSummary, RejectionDetail } from './types'

export async function checkManualTradingHistoryBatch(tokenAddresses: string[]): Promise<Set<string>> {
  try {
    const manuallyTradedTokens = new Set<string>()

    // Query trading_records table for any manual trades (is_bot_operation = false or null)
    const { rows: data } = await query<{ data: Record<string, unknown> }>(
      `SELECT data FROM trading_records
       WHERE (data->>'is_bot_operation' IS NULL OR data->>'is_bot_operation' = 'false')`,
    )

    if (!data || data.length === 0) {
      return manuallyTradedTokens // No manual trades found
    }

    // Check each record for tokens that match our list
    for (const record of data) {
      const recordData = record.data
      if (recordData && recordData.tokens && Array.isArray(recordData.tokens)) {
        recordData.tokens.forEach((token: any) => {
          if (token.mintAddress && tokenAddresses.includes(token.mintAddress)) {
            manuallyTradedTokens.add(token.mintAddress)
          }
        })
      }
    }

    return manuallyTradedTokens
  } catch (error) {
    console.error('Error in checkManualTradingHistoryBatch:', error)
    return new Set<string>() // Return empty set if error occurs
  }
}

// Enhanced filtering function with detailed tracking and token collection
export async function performEnhancedFiltering(
  pools: any[],
  strategyId?: string,
  customConfig?: Partial<TokenFilterConfig>
): Promise<{ results: TokenFilterResult[], summary: FilteringSummary }> {
  const startTime = Date.now()
  const results: TokenFilterResult[] = []
  const rejectionBreakdown: { [reason: string]: number } = {}
  const rejectionTokens: {
    [reason: string]: Array<{
      name: string
      symbol: string
      address: string
      price: number
      mcap?: number
      organicScore?: number
    }>
  } = {}

  // Get filtering configuration based on strategy
  let filterConfig: TokenFilterConfig

  if (customConfig && Object.keys(customConfig).length > 0) {
    // Use custom configuration if provided
    filterConfig = { ...DEFAULT_FILTER_CONFIG, ...customConfig }
  } else if (strategyId) {
    // Use strategy-specific configuration
    const strategy = resolveTradingStrategy(strategyId)
    filterConfig = strategy.filtering || DEFAULT_FILTER_CONFIG
  } else {
    // Use default configuration
    filterConfig = DEFAULT_FILTER_CONFIG
  }

  console.log(`🔍 Using filtering configuration for strategy '${strategyId || 'default'}':`, filterConfig)

  // Skip filtering if disabled
  if (!filterConfig.enabled) {
    console.log('🚫 Filtering disabled, accepting all tokens')
    const mappedResults = pools.map(pool => ({
      token: pool,
      passed: true,
      rejectionReasons: [],
      mappedToken: mapPoolToTrackedToken(pool),
    }))

    return {
      results: mappedResults,
      summary: {
        totalTokens: pools.length,
        acceptedTokens: pools.length,
        rejectedTokens: 0,
        rejectionBreakdown: {},
        rejectionDetails: [],
        processingTime: Date.now() - startTime
      }
    }
  }

  // Extract all token addresses for batch checking
  const tokenAddresses = pools
    .map(pool => pool.baseAsset.id)
    .filter(id => id) // Remove null/undefined values

  // Batch check for manually traded tokens (if enabled)
  let manuallyTradedTokens = new Set<string>()
  if (filterConfig.checkManualTradingHistory) {
    manuallyTradedTokens = await checkManualTradingHistoryBatch(tokenAddresses)
    console.log(`🔍 Found ${manuallyTradedTokens.size} manually traded tokens out of ${tokenAddresses.length} tokens`)
  }

  pools.forEach(pool => {
    const rejectionReasons: string[] = []

    // Extract token data
    const priceChange5m = pool.baseAsset.stats5m?.priceChange ?? 0
    const priceChange1h = pool.baseAsset.stats1h?.priceChange ?? 0
    const priceChange6h = pool.baseAsset.stats6h?.priceChange ?? 0
    const organicScore = pool.baseAsset.organicScore
    const mcap = pool.baseAsset.mcap
    const topHoldersPercentage = pool.baseAsset.audit?.topHoldersPercentage

    // Apply dynamic filters based on configuration

    // Market cap filtering
    if (filterConfig.mcap) {
      if (filterConfig.mcap.min && (!mcap || mcap <= filterConfig.mcap.min)) {
        console.log(`🔍 Token ${pool.baseAsset.symbol} rejected: Market cap ${mcap} below minimum ${filterConfig.mcap.min}`);
        rejectionReasons.push(`Market cap too low (${mcap ? `$${(mcap / 1000).toFixed(0)}k` : 'N/A'} <= $${(filterConfig.mcap.min / 1000).toFixed(0)}k)`)
      }
      if (filterConfig.mcap.max && (!mcap || mcap >= filterConfig.mcap.max)) {
        console.log(`🔍 Token ${pool.baseAsset.symbol} (${pool.baseAsset.id}) rejected: Market cap $${(mcap / 1000000).toFixed(2)}M above maximum $${(filterConfig.mcap.max / 1000).toFixed(0)}k`);
        rejectionReasons.push(`Market cap too high (${mcap ? `$${(mcap / 1000000).toFixed(1)}M` : 'N/A'} >= $${(filterConfig.mcap.max / 1000000).toFixed(1)}M)`)
      }
    }

    // Price change 5m filtering
    if (filterConfig.priceChange5m) {
      if (filterConfig.priceChange5m.min && priceChange5m <= filterConfig.priceChange5m.min) {
        rejectionReasons.push(`5m price drop too severe (${priceChange5m.toFixed(2)}% <= ${filterConfig.priceChange5m.min}%)`)
      }
      if (filterConfig.priceChange5m.max && priceChange5m <= filterConfig.priceChange5m.max) {
        rejectionReasons.push(`5m price drop too severe (${priceChange5m.toFixed(2)}% <= ${filterConfig.priceChange5m.max}%)`)
      }
    }

    // Price change 1h filtering
    if (filterConfig.priceChange1h) {
      if (filterConfig.priceChange1h.min && priceChange1h <= filterConfig.priceChange1h.min) {
        rejectionReasons.push(`1h price rise insufficient (${priceChange1h.toFixed(2)}% <= ${filterConfig.priceChange1h.min}%)`)
      }
      if (filterConfig.priceChange1h.max && priceChange1h >= filterConfig.priceChange1h.max) {
        rejectionReasons.push(`1h price rise too high (${priceChange1h.toFixed(2)}% >= ${filterConfig.priceChange1h.max}%)`)
      }
    }

    // Price change 6h filtering
    if (filterConfig.priceChange6h) {
      if (filterConfig.priceChange6h.min && priceChange6h <= filterConfig.priceChange6h.min) {
        rejectionReasons.push(`6h price rise insufficient (${priceChange6h.toFixed(2)}% <= ${filterConfig.priceChange6h.min}%)`)
      }
      if (filterConfig.priceChange6h.max && priceChange6h >= filterConfig.priceChange6h.max) {
        rejectionReasons.push(`6h price rise too high (${priceChange6h.toFixed(2)}% >= ${filterConfig.priceChange6h.max}%)`)
      }
    }

    // Organic score filtering
    if (filterConfig.organicScore?.min && (!organicScore || organicScore < filterConfig.organicScore.min)) {
      rejectionReasons.push(`Organic score too low (${organicScore || 'N/A'} < ${filterConfig.organicScore.min})`)
    }

    // Top holders percentage filtering
    if (filterConfig.topHoldersPercentage?.max && (!topHoldersPercentage || topHoldersPercentage >= filterConfig.topHoldersPercentage.max)) {
      rejectionReasons.push(`Top holders percentage too high (${topHoldersPercentage || 'N/A'}% >= ${filterConfig.topHoldersPercentage.max}%)`)
    }

    // Data completeness check
    if (filterConfig.requireCompleteData && (!pool.baseAsset.id || !pool.baseAsset.symbol || !pool.baseAsset.usdPrice)) {
      rejectionReasons.push('Missing required data')
    }

    // Manual trading history check
    if (filterConfig.checkManualTradingHistory && pool.baseAsset.id && manuallyTradedTokens.has(pool.baseAsset.id)) {
      rejectionReasons.push('Token already traded manually')
    }

    const passed = rejectionReasons.length === 0

    if (passed) {
      console.log(`✅ Token ${pool.baseAsset.symbol} (${pool.baseAsset.id}) PASSED filters under strategy '${strategyId || 'default'}' with Market cap $${(mcap ? mcap / 1000000 : 0).toFixed(2)}M`)
    }

    // Track rejection reasons and collect token details
    rejectionReasons.forEach(reason => {
      rejectionBreakdown[reason] = (rejectionBreakdown[reason] || 0) + 1

      // Initialize array if it doesn't exist
      if (!rejectionTokens[reason]) {
        rejectionTokens[reason] = []
      }

      // Add token details to the rejection reason
      rejectionTokens[reason].push({
        name: pool.baseAsset.name || pool.baseAsset.symbol || 'UNKNOWN',
        symbol: pool.baseAsset.symbol || 'UNKNOWN',
        address: pool.baseAsset.id || 'UNKNOWN',
        price: pool.baseAsset.usdPrice || 0,
        mcap: pool.baseAsset.mcap,
        organicScore: pool.baseAsset.organicScore
      })
    })

    const result: TokenFilterResult = {
      token: pool,
      passed,
      rejectionReasons
    }

    // If passed, create mapped token data
    if (passed) {
      result.mappedToken = mapPoolToTrackedToken(pool)
    }

    results.push(result)
  })

  const processingTime = Date.now() - startTime
  const acceptedTokens = results.filter(r => r.passed).length
  const rejectedTokens = results.filter(r => !r.passed).length

  // Create rejection details array
  const rejectionDetails: RejectionDetail[] = Object.entries(rejectionBreakdown).map(([reason, count]) => ({
    reason,
    count,
    tokens: rejectionTokens[reason] || []
  }))

  const summary: FilteringSummary = {
    totalTokens: pools.length,
    acceptedTokens,
    rejectedTokens,
    rejectionBreakdown,
    rejectionDetails,
    processingTime
  }

  console.log(`🎯 Filtering completed for strategy '${strategyId || 'default'}': ${acceptedTokens}/${pools.length} tokens passed`)

  return { results, summary }
}

export function parseCustomFilterConfig(): Partial<TokenFilterConfig> | null {
  try {
    // Check for environment variable with custom filter config
    const customConfigEnv = process.env.CUSTOM_FILTER_CONFIG
    if (customConfigEnv) {
      return JSON.parse(customConfigEnv)
    }

    // Check for individual environment variables
    const customConfig: Partial<TokenFilterConfig> = {}

    if (process.env.FILTER_ENABLED !== undefined) {
      customConfig.enabled = process.env.FILTER_ENABLED === 'true'
    }

    if (process.env.FILTER_MCAP_MIN) {
      customConfig.mcap = { ...customConfig.mcap, min: parseInt(process.env.FILTER_MCAP_MIN) }
    }

    if (process.env.FILTER_MCAP_MAX) {
      customConfig.mcap = { ...customConfig.mcap, max: parseInt(process.env.FILTER_MCAP_MAX) }
    }

    if (process.env.FILTER_PRICE_5M_MAX) {
      customConfig.priceChange5m = { max: parseFloat(process.env.FILTER_PRICE_5M_MAX) }
    }

    if (process.env.FILTER_PRICE_1H_MAX) {
      customConfig.priceChange1h = { max: parseFloat(process.env.FILTER_PRICE_1H_MAX) }
    }

    if (process.env.FILTER_PRICE_6H_MAX) {
      customConfig.priceChange6h = { max: parseFloat(process.env.FILTER_PRICE_6H_MAX) }
    }

    if (process.env.FILTER_ORGANIC_SCORE_MIN) {
      customConfig.organicScore = { min: parseInt(process.env.FILTER_ORGANIC_SCORE_MIN) }
    }

    // Return null if no custom config found
    return Object.keys(customConfig).length > 0 ? customConfig : null
  } catch (error) {
    console.error('Error parsing custom filter configuration:', error)
    return null
  }
}
