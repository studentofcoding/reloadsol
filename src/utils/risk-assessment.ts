import { fetchAxiomTokenInfo, getRiskIndicators, calculateFeeToMarketCapRatio } from './axiom'
import { fetchTokenMetadataFromJupiter } from '@/utils/jupiter-metadata'

// Types for risk assessment
export interface RiskIndicators {
  insiderRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  bundlerRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  sniperRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  feeRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH'
}

export interface TokenData {
  token_address: string
  token_symbol: string
  mcap: number
  price: number
  change_1h?: number
  change_5m?: number
  organic_score?: number
}

export interface RiskAssessmentResult {
  riskLevel: 'LOW' | 'MED' | 'HIGH'
  riskIndicators?: RiskIndicators
  assessmentMethod: 'axiom' | 'organic_volatility' | 'basic' | 'jupiter_metadata'
  organicScore?: number
  volatility?: number
  error?: string
  // Add detailed Axiom data for Discord formatting
  axiomData?: {
    insidersHoldPercent: number
    bundlersHoldPercent: number
    snipersHoldPercent: number
    top10HoldersPercent: number
    totalPairFeesPaid: number
    feeToMcapRatio: number
  }
  // Add Jupiter metadata details for Discord formatting
  jupiterDetails?: {
    bondingCurve?: number | null
    organicScore?: number | null
    topHoldersPercentage?: number | null
  }
}

export interface RiskAssessmentOptions {
  timeoutMs?: number
  enableLogging?: boolean
  fallbackToBasic?: boolean
}

/**
 * Comprehensive token risk assessment with Jupiter-first bonding check and Axiom gating
 * 
 * @param token - Token data including address, symbol, market cap, price, and optional metrics
 * @param options - Configuration options for the assessment
 * @returns Promise<RiskAssessmentResult> - Comprehensive risk assessment result
 */
export async function assessTokenRisk(
  token: TokenData,
  options: RiskAssessmentOptions = {}
): Promise<RiskAssessmentResult> {
  const {
    timeoutMs = 5000,
    enableLogging = true,
    fallbackToBasic = true
  } = options

  // Input validation
  if (!token?.token_address || !token?.token_symbol || typeof token?.mcap !== 'number') {
    const error = 'Invalid token data: missing required fields (token_address, token_symbol, mcap)'
    if (enableLogging) {
      console.error('❌ Risk assessment failed:', error)
    }
    return {
      riskLevel: 'HIGH',
      assessmentMethod: 'basic',
      error
    }
  }

  if (enableLogging) {
    console.log(`🔍 Starting risk assessment for ${token.token_symbol} (${token.token_address})`)
  }

  // Step 0: Consult Jupiter metadata first to determine bonding curve and organic/audit fields
  let jupMeta: any | null = null
  try {
    jupMeta = await fetchTokenMetadataFromJupiter(token.token_address)
    if (enableLogging) {
      console.log(`🛰️ Jupiter metadata for ${token.token_symbol}:`, {
        bondingCurve: jupMeta?.bondingCurve,
        organicScore: jupMeta?.organicScore,
        topHoldersPercentage: jupMeta?.audit?.topHoldersPercentage
      })
    }
  } catch (e) {
    if (enableLogging) {
      console.warn(`⚠️ Failed to fetch Jupiter metadata for ${token.token_symbol}:`, e instanceof Error ? e.message : 'Unknown error')
    }
  }

  const bondingCurve = typeof jupMeta?.bondingCurve === 'number' ? jupMeta.bondingCurve : null

  // If bondingCurve is not 100 (i.e., not fully graduated), skip Axiom and use Jupiter's organicScore and audit data
  if (bondingCurve === null || bondingCurve !== 100) {
    const organicScore = typeof jupMeta?.organicScore === 'number' ? jupMeta.organicScore : (token.organic_score ?? null)
    const topHoldersPercentage = typeof jupMeta?.audit?.topHoldersPercentage === 'number' ? jupMeta.audit.topHoldersPercentage : null

    // Derive a basic risk from these fields
    let riskLevel: 'LOW' | 'MED' | 'HIGH' = 'MED'
    if (organicScore !== null) {
      if (organicScore >= 85) riskLevel = 'LOW'
      else if (organicScore >= 70) riskLevel = 'MED'
      else riskLevel = 'HIGH'
    }

    if (typeof topHoldersPercentage === 'number') {
      // Penalize high concentration
      if (topHoldersPercentage > 60) riskLevel = 'HIGH'
      else if (topHoldersPercentage > 40 && riskLevel === 'LOW') riskLevel = 'MED'
    }

    if (enableLogging) {
      console.log(`✅ Using Jupiter metadata assessment for ${token.token_symbol} (bondingCurve=${bondingCurve ?? 'N/A'}) => ${riskLevel}`)
    }

    return {
      riskLevel,
      assessmentMethod: 'jupiter_metadata',
      organicScore: organicScore ?? undefined,
      jupiterDetails: {
        bondingCurve,
        organicScore: organicScore ?? null,
        topHoldersPercentage
      }
    }
  }

  // Primary assessment: Try Axiom API with timeout (only if bondingCurve === 100)
  try {
    if (enableLogging) {
      console.log(`📊 Attempting Axiom API assessment for ${token.token_symbol}`)
    }

    const axiomResult = await Promise.race([
      fetchAxiomTokenInfo(token.token_address),
      new Promise<{ success: false; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error('Axiom API timeout')), timeoutMs)
      )
    ])

    if (axiomResult.success && axiomResult.data) {
      const riskIndicators = getRiskIndicators(axiomResult.data, token.mcap)
      const riskLevel = riskIndicators.overallRisk === 'MEDIUM' ? 'MED' : riskIndicators.overallRisk

      // Calculate fee to market cap ratio
      const feeAnalysis = calculateFeeToMarketCapRatio(axiomResult.data.totalPairFeesPaid, token.mcap)

      if (enableLogging) {
        console.log(`✅ Axiom risk assessment for ${token.token_symbol}: ${riskLevel}`, {
          insider: riskIndicators.insiderRisk,
          bundler: riskIndicators.bundlerRisk,
          concentration: riskIndicators.concentrationRisk,
          fee: riskIndicators.feeRisk
        })
      }

      return {
        riskLevel,
        riskIndicators,
        assessmentMethod: 'axiom',
        axiomData: {
          insidersHoldPercent: axiomResult.data.insidersHoldPercent,
          bundlersHoldPercent: axiomResult.data.bundlersHoldPercent,
          snipersHoldPercent: axiomResult.data.snipersHoldPercent,
          top10HoldersPercent: axiomResult.data.top10HoldersPercent,
          totalPairFeesPaid: axiomResult.data.totalPairFeesPaid,
          feeToMcapRatio: feeAnalysis.ratio
        }
      }
    } else {
      if (enableLogging) {
        console.log(`⚠️ Axiom API failed for ${token.token_symbol}: ${axiomResult.error || 'Unknown error'}`)
      }
    }
  } catch (error) {
    if (enableLogging) {
      console.log(`⚠️ Axiom API timeout/error for ${token.token_symbol}:`, error instanceof Error ? error.message : 'Unknown error')
    }
  }

  // Secondary assessment: Organic score and volatility
  if (token.organic_score !== undefined && token.change_1h !== undefined) {
    if (enableLogging) {
      console.log(`📈 Using organic score and volatility assessment for ${token.token_symbol}`)
    }

    let riskLevel: 'LOW' | 'MED' | 'HIGH' = 'LOW'

    // Risk assessment based on organic score
    if (token.organic_score < 75) {
      riskLevel = 'HIGH'
    } else if (token.organic_score < 85) {
      riskLevel = 'MED'
    }

    // Factor in volatility
    const volatility = Math.abs(token.change_1h) * 100
    if (volatility > 100) {
      riskLevel = 'HIGH'
    } else if (volatility > 50 && riskLevel === 'LOW') {
      riskLevel = 'MED'
    }

    if (enableLogging) {
      console.log(`✅ Organic/volatility risk assessment for ${token.token_symbol}: ${riskLevel}`, {
        organicScore: token.organic_score,
        volatility: volatility.toFixed(2)
      })
    }

    return {
      riskLevel,
      assessmentMethod: 'organic_volatility',
      organicScore: token.organic_score,
      volatility
    }
  }

  // Tertiary assessment: Basic fallback
  if (fallbackToBasic) {
    if (enableLogging) {
      console.log(`🔧 Using basic risk assessment for ${token.token_symbol}`)
    }

    // Basic risk assessment based on market cap and available data
    let riskLevel: 'LOW' | 'MED' | 'HIGH' = 'MED' // Default to medium risk

    // Very low market cap is higher risk
    if (token.mcap < 50000) {
      riskLevel = 'HIGH'
    } else if (token.mcap > 500000) {
      riskLevel = 'LOW'
    }

    // Factor in 5-minute change if available
    if (token.change_5m !== undefined) {
      const volatility5m = Math.abs(token.change_5m) * 100
      if (volatility5m > 50) {
        riskLevel = 'HIGH'
      } else if (volatility5m > 25 && riskLevel === 'LOW') {
        riskLevel = 'MED'
      }
    }

    if (enableLogging) {
      console.log(`✅ Basic risk assessment for ${token.token_symbol}: ${riskLevel}`, {
        mcap: token.mcap,
        change5m: token.change_5m
      })
    }

    return {
      riskLevel,
      assessmentMethod: 'basic'
    }
  }

  // If all assessments fail and fallback is disabled
  const error = 'All risk assessment methods failed and fallback is disabled'
  if (enableLogging) {
    console.error(`❌ Risk assessment completely failed for ${token.token_symbol}:`, error)
  }

  return {
    riskLevel: 'HIGH',
    assessmentMethod: 'basic',
    error
  }
}

/**
 * Format risk assessment result for Discord messages
 * 
 * @param token - Token data
 * @param riskResult - Risk assessment result
 * @returns Formatted string for Discord message
 */
export function formatRiskForDiscord(token: TokenData, riskResult: RiskAssessmentResult): string {
  const riskLevel = riskResult.riskLevel
  const organicScore = riskResult.organicScore || token.organic_score || 0

  return `Score: ${organicScore.toFixed(1)}, MCap: $${token.mcap.toLocaleString()}, Risk: ${riskLevel}`
}

/**
 * Format detailed risk assessment result for Discord messages with Axiom or Jupiter metrics
 * 
 * @param token - Token data
 * @param riskResult - Risk assessment result
 * @returns Formatted string for Discord message with detailed metrics
 */
export function formatDetailedRiskForDiscord(token: TokenData, riskResult: RiskAssessmentResult): string {
  // If we have Axiom data, show detailed metrics
  if (riskResult.axiomData) {
    const { insidersHoldPercent, bundlersHoldPercent, snipersHoldPercent, top10HoldersPercent, feeToMcapRatio } = riskResult.axiomData
    return `I:${insidersHoldPercent.toFixed(1)}% B:${bundlersHoldPercent.toFixed(1)}% S:${snipersHoldPercent.toFixed(1)}% T10:${top10HoldersPercent.toFixed(1)}% F/Mcap:${feeToMcapRatio.toFixed(2)}`
  }

  // If we have Jupiter metadata details, show those
  if (riskResult.jupiterDetails) {
    const bc = riskResult.jupiterDetails.bondingCurve
    const os = riskResult.jupiterDetails.organicScore
    const thp = riskResult.jupiterDetails.topHoldersPercentage
    const parts: string[] = []
    if (typeof bc === 'number') parts.push(`BC:${bc}`)
    if (typeof os === 'number') parts.push(`Org:${os.toFixed(1)}`)
    if (typeof thp === 'number') parts.push(`TopH:${thp.toFixed(1)}%`)
    if (parts.length) return parts.join(' ')
  }

  // Fallback to regular format
  return formatRiskForDiscord(token, riskResult)
}

/**
 * Batch risk assessment for multiple tokens
 * 
 * @param tokens - Array of token data
 * @param options - Configuration options
 * @returns Promise<Map<string, RiskAssessmentResult>> - Map of token address to risk result
 */
export async function assessMultipleTokenRisks(
  tokens: TokenData[],
  options: RiskAssessmentOptions = {}
): Promise<Map<string, RiskAssessmentResult>> {
  const results = new Map<string, RiskAssessmentResult>()

  // Process tokens in parallel with controlled concurrency
  const batchSize = 5 // Process 5 tokens at a time to avoid overwhelming the API

  for (let i = 0; i < tokens.length; i += batchSize) {
    const batch = tokens.slice(i, i + batchSize)
    const batchPromises = batch.map(async (token) => {
      try {
        const result = await assessTokenRisk(token, options)
        return { address: token.token_address, result }
      } catch (error) {
        return {
          address: token.token_address,
          result: {
            riskLevel: 'HIGH' as const,
            assessmentMethod: 'basic' as const,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        }
      }
    })

    const batchResults = await Promise.all(batchPromises)
    batchResults.forEach(({ address, result }) => {
      results.set(address, result)
    })
  }

  return results
}

/**
 * Get risk level emoji for display
 * 
 * @param riskLevel - Risk level
 * @returns Emoji string
 */
export function getRiskEmoji(riskLevel: 'LOW' | 'MED' | 'HIGH'): string {
  switch (riskLevel) {
    case 'LOW':
      return '✅'
    case 'MED':
      return '⚡'
    case 'HIGH':
      return '⚠️'
    default:
      return '❓'
  }
}