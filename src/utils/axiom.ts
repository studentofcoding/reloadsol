interface AxiomTokenInfo {
  numHolders: number
  numBotUsers: number
  top10HoldersPercent: number
  devHoldsPercent: number
  insidersHoldPercent: number
  bundlersHoldPercent: number
  snipersHoldPercent: number
  dexPaid: boolean
  totalPairFeesPaid: number
}

interface AxiomResponse {
  success: boolean
  data?: AxiomTokenInfo
  error?: string
  requiresAuth?: boolean
  pairNotFound?: boolean
}

// Cache for Axiom API responses to avoid repeated calls
const axiomCache = new Map<string, { data: AxiomTokenInfo; timestamp: number }>()
const CACHE_DURATION = 5 * 60 * 1000 // 5 minutes cache

export async function fetchAxiomTokenInfo(mintAddress: string): Promise<AxiomResponse> {
  try {
    // Check cache first
    const cached = axiomCache.get(mintAddress)
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      return { success: true, data: cached.data }
    }

    // First, get the graduated pool from Jupiter metadata
    console.log(`🔍 Getting graduated pool for mint: ${mintAddress}`)
    const jupiterResponse = await fetch(`/api/jupiter/metadata?mint=${mintAddress}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(5000) // 5 second timeout
    })

    if (!jupiterResponse.ok) {
      throw new Error(`Failed to fetch Jupiter metadata: ${jupiterResponse.status}`)
    }

    const jupiterData = await jupiterResponse.json()
    const graduatedPool = jupiterData.data?.graduatedPool

    if (!graduatedPool) {
      console.warn(`No graduated pool found for mint: ${mintAddress}`)
      return {
        success: false,
        error: 'No graduated pool available for this token',
        pairNotFound: true
      }
    }

    console.log(`🎯 Using graduated pool: ${graduatedPool} for mint: ${mintAddress}`)

    // Fetch from our proxy API endpoint using the graduated pool
    const response = await fetch(`/api/axiom/token-info?pairAddress=${graduatedPool}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      // Add timeout
      signal: AbortSignal.timeout(10000) // 10 second timeout
    })

    const result = await response.json()

    // Handle authentication error
    if (result.requiresAuth) {
      return {
        success: false,
        error: 'Axiom API requires authentication',
        requiresAuth: true
      }
    }

    // Handle pair not found error
    if (result.pairNotFound) {
      return {
        success: false,
        error: 'Token not found in Axiom database',
        pairNotFound: true
      }
    }

    if (!response.ok) {
      throw new Error(`Axiom API error: ${response.status} ${response.statusText}`)
    }

    if (!result.success || !result.data) {
      throw new Error(result.error || 'Invalid response from Axiom API')
    }

    const data: AxiomTokenInfo = result.data

    // Validate required fields
    if (typeof data.numHolders !== 'number' || typeof data.insidersHoldPercent !== 'number' || typeof data.bundlersHoldPercent !== 'number') {
      throw new Error('Invalid response format from Axiom API')
    }

    // Cache the result
    axiomCache.set(mintAddress, { data, timestamp: Date.now() })

    return { success: true, data }
  } catch (error) {
    console.error(`Failed to fetch Axiom token info for ${mintAddress}:`, error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

// Helper function to calculate fee-to-market-cap ratio and assess organic trading
export function calculateFeeToMarketCapRatio(feesPaid: number, marketCap: number): {
  ratio: number
  organicScore: number
  feeRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  isOrganic: boolean
} {
  if (marketCap <= 0) {
    return { ratio: 0, organicScore: 0, feeRisk: 'HIGH', isOrganic: false }
  }

  // Convert market cap to thousands for easier calculation
  const mcapInK = marketCap / 1000
  const feesInSol = feesPaid

  // Calculate ratio: fees per 5K market cap
  const ratio = (feesInSol / mcapInK) * 5

  // Organic trading assessment based on your criteria:
  // - For every 5K MC, should have at least 0.5 SOL in fees
  // - At 20K MC, should have 1.5-2 SOL in fees
  // - Under 4 SOL for graduated tokens is suspicious

  let organicScore = 0
  let feeRisk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW'
  let isOrganic = false

  if (mcapInK <= 20) {
    // Small cap tokens (≤ 20K MC)
    const expectedFees = mcapInK * 0.1 // 0.1 SOL per 1K MC
    if (feesInSol >= expectedFees * 1.5) {
      organicScore = 100
      feeRisk = 'LOW'
      isOrganic = true
    } else if (feesInSol >= expectedFees) {
      organicScore = 70
      feeRisk = 'MEDIUM'
      isOrganic = true
    } else if (feesInSol >= expectedFees * 0.5) {
      organicScore = 40
      feeRisk = 'MEDIUM'
      isOrganic = false
    } else {
      organicScore = 10
      feeRisk = 'HIGH'
      isOrganic = false
    }
  } else {
    // Larger cap tokens (> 20K MC)
    const expectedFees = mcapInK * 0.075 // 0.075 SOL per 1K MC for larger caps
    if (feesInSol >= expectedFees * 1.2) {
      organicScore = 100
      feeRisk = 'LOW'
      isOrganic = true
    } else if (feesInSol >= expectedFees) {
      organicScore = 80
      feeRisk = 'MEDIUM'
      isOrganic = true
    } else if (feesInSol >= expectedFees * 0.6) {
      organicScore = 50
      feeRisk = 'MEDIUM'
      isOrganic = false
    } else {
      organicScore = 20
      feeRisk = 'HIGH'
      isOrganic = false
    }
  }

  // Special case for graduated tokens (high market cap)
  if (marketCap > 1000000) { // > 1M MC
    if (feesInSol < 4) {
      organicScore = Math.min(organicScore, 30)
      feeRisk = 'HIGH'
      isOrganic = false
    }
  }

  return { ratio, organicScore, feeRisk, isOrganic }
}

// Helper function to get risk indicators based on Axiom data
export function getRiskIndicators(data: AxiomTokenInfo, marketCap?: number): {
  insiderRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  bundlerRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  sniperRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  feeRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH'
} {
  const indicators = {
    insiderRisk: (data.insidersHoldPercent > 10 ? 'HIGH' : data.insidersHoldPercent > 5 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH',
    bundlerRisk: (data.bundlersHoldPercent > 5 ? 'HIGH' : data.bundlersHoldPercent > 2 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH',
    sniperRisk: (data.snipersHoldPercent > 15 ? 'HIGH' : data.snipersHoldPercent > 8 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH',
    concentrationRisk: (data.top10HoldersPercent > 50 ? 'HIGH' : data.top10HoldersPercent > 30 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH'
  }

  // Calculate fee risk if market cap is provided
  let feeRisk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW'
  if (marketCap) {
    const feeAnalysis = calculateFeeToMarketCapRatio(data.totalPairFeesPaid, marketCap)
    feeRisk = feeAnalysis.feeRisk
  }

  // Overall risk assessment (now includes fee risk)
  const highRiskCount = Object.values(indicators).filter(risk => risk === 'HIGH').length + (feeRisk === 'HIGH' ? 1 : 0)
  const mediumRiskCount = Object.values(indicators).filter(risk => risk === 'MEDIUM').length + (feeRisk === 'MEDIUM' ? 1 : 0)

  let overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW'
  if (highRiskCount >= 2 || (highRiskCount >= 1 && mediumRiskCount >= 2)) {
    overallRisk = 'HIGH'
  } else if (highRiskCount >= 1 || mediumRiskCount >= 2) {
    overallRisk = 'MEDIUM'
  }

  return {
    ...indicators,
    feeRisk,
    overallRisk
  }
}

// Helper function to format risk display
export function formatRiskDisplay(risk: 'LOW' | 'MEDIUM' | 'HIGH') {
  switch (risk) {
    case 'LOW':
      return { text: 'Low', color: 'text-green-400', bg: 'bg-green-900/20', border: 'border-green-500/30' }
    case 'MEDIUM':
      return { text: 'Medium', color: 'text-yellow-400', bg: 'bg-yellow-900/20', border: 'border-yellow-500/30' }
    case 'HIGH':
      return { text: 'High', color: 'text-red-400', bg: 'bg-red-900/20', border: 'border-red-500/30' }
  }
}