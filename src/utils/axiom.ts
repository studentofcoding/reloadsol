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

// Helper function to get risk indicators based on Axiom data
export function getRiskIndicators(data: AxiomTokenInfo): {
  insiderRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  bundlerRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  sniperRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH'
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH'
} {
  const indicators = {
    insiderRisk: (data.insidersHoldPercent > 10 ? 'HIGH' : data.insidersHoldPercent > 5 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH',
    bundlerRisk: (data.bundlersHoldPercent > 5 ? 'HIGH' : data.bundlersHoldPercent > 2 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH',
    sniperRisk: (data.snipersHoldPercent > 15 ? 'HIGH' : data.snipersHoldPercent > 8 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH',
    concentrationRisk: (data.top10HoldersPercent > 50 ? 'HIGH' : data.top10HoldersPercent > 30 ? 'MEDIUM' : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH'
  }

  // Overall risk assessment
  const highRiskCount = Object.values(indicators).filter(risk => risk === 'HIGH').length
  const mediumRiskCount = Object.values(indicators).filter(risk => risk === 'MEDIUM').length

  let overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW'
  if (highRiskCount >= 2 || (highRiskCount >= 1 && mediumRiskCount >= 2)) {
    overallRisk = 'HIGH'
  } else if (highRiskCount >= 1 || mediumRiskCount >= 2) {
    overallRisk = 'MEDIUM'
  }

  return {
    ...indicators,
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