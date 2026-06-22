// Jupiter API utility with v2/v3 compatibility and centralized configuration

// API Configuration
const JUPITER_API_CONFIG = {
  // Primary version to try first - now using v3 only
  PRIMARY_VERSION: 'v3' as 'v2' | 'v3',
  // Fallback version if primary fails
  FALLBACK_VERSION: 'v2' as 'v2' | 'v3',
  // Disable automatic fallback - using v3 only
  AUTO_FALLBACK: false,
  BASE_URL: 'https://lite-api.jup.ag/price',
  MAX_TOKENS_PER_REQUEST: 100,
  REQUEST_TIMEOUT: 7000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
}

// Response type definitions
interface JupiterV2Response {
  data: Record<string, {
    id: string
    type: string
    price: string
  }>
  timeTaken: number
}

interface JupiterV3Response {
  [tokenId: string]: {
    usdPrice: number
    blockId: number
    decimals: number
    priceChange24h: number
  }
}

// Normalized price data interface
export interface TokenPriceData {
  price: number
  decimals?: number
  priceChange24h?: number
  blockId?: number
  source: 'v2' | 'v3'
}

// Error types
export class JupiterAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public isRateLimit: boolean = false
  ) {
    super(message)
    this.name = 'JupiterAPIError'
  }
}

// Utility function to build API URL with specific version
function buildApiUrl(tokens: string[], version: 'v2' | 'v3'): string {
  const baseUrl = JUPITER_API_CONFIG.BASE_URL
  const tokenIds = tokens.join(',')

  return `${baseUrl}/${version}?ids=${tokenIds}`
}

// Utility function to normalize response data
function normalizeResponse(
  response: JupiterV2Response | JupiterV3Response,
  version: 'v2' | 'v3'
): Record<string, TokenPriceData> {
  const normalized: Record<string, TokenPriceData> = {}

  if (version === 'v2') {
    const v2Response = response as JupiterV2Response
    if (v2Response.data) {
      Object.entries(v2Response.data).forEach(([tokenId, data]) => {
        if (data && data.price) {
          normalized[tokenId] = {
            price: parseFloat(data.price),
            source: 'v2'
          }
        }
      })
    }
  } else {
    const v3Response = response as JupiterV3Response
    Object.entries(v3Response).forEach(([tokenId, data]) => {
      if (data && typeof data.usdPrice === 'number') {
        normalized[tokenId] = {
          price: data.usdPrice,
          decimals: data.decimals,
          priceChange24h: data.priceChange24h,
          blockId: data.blockId,
          source: 'v3'
        }
      }
    })
  }

  return normalized
}

// Core function to fetch prices from Jupiter API with automatic fallback
export async function fetchTokenPrices(
  tokens: string[],
  options: {
    timeout?: number
    retries?: number
    retryDelay?: number
  } = {}
): Promise<Record<string, TokenPriceData>> {
  if (tokens.length === 0) {
    return {}
  }

  if (tokens.length > JUPITER_API_CONFIG.MAX_TOKENS_PER_REQUEST) {
    throw new JupiterAPIError(
      `Too many tokens requested. Maximum ${JUPITER_API_CONFIG.MAX_TOKENS_PER_REQUEST} per request.`
    )
  }

  const {
    timeout = JUPITER_API_CONFIG.REQUEST_TIMEOUT,
    retries = JUPITER_API_CONFIG.RETRY_ATTEMPTS,
    retryDelay = JUPITER_API_CONFIG.RETRY_DELAY
  } = options

  // Try primary version first
  const primaryVersion = JUPITER_API_CONFIG.PRIMARY_VERSION
  const fallbackVersion = JUPITER_API_CONFIG.FALLBACK_VERSION

  try {
    return await fetchTokenPricesWithVersion(tokens, primaryVersion, { timeout, retries, retryDelay })
  } catch (error: unknown) {
    // Since auto-fallback is disabled in v3-only mode, just throw the error
    // Log the error for monitoring
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[Jupiter API] v3 request failed:`, {
      error: errorMessage,
      statusCode: error instanceof JupiterAPIError ? error.statusCode : 'unknown',
      tokenCount: tokens.length,
      timestamp: new Date().toISOString()
    })

    throw error
  }
}

// Internal function to fetch prices with a specific API version
async function fetchTokenPricesWithVersion(
  tokens: string[],
  version: 'v2' | 'v3',
  options: {
    timeout: number
    retries: number
    retryDelay: number
  }
): Promise<Record<string, TokenPriceData>> {
  const { timeout, retries, retryDelay } = options
  const url = buildApiUrl(tokens, version)

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`Fetching prices for ${tokens.length} tokens (attempt ${attempt + 1}/${retries + 1})`, {
        version,
        url: url.replace(/ids=[^&]*/, 'ids=...')
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'cache-control': 'no-cache',
          'user-agent': 'BuyBulk/1.0'
        },
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (response.status === 429) {
        throw new JupiterAPIError('Rate limited by Jupiter API', 429, true)
      }

      if (!response.ok) {
        throw new JupiterAPIError(
          `Jupiter API error: ${response.status} ${response.statusText}`,
          response.status
        )
      }

      const data = await response.json()
      const normalized = normalizeResponse(data, version)

      console.log(`Successfully fetched ${Object.keys(normalized).length}/${tokens.length} prices`)

      // Fill in missing tokens with zero price
      tokens.forEach(token => {
        if (!(token in normalized)) {
          normalized[token] = {
            price: 0,
            source: version
          }
        }
      })

      return normalized

    } catch (error) {
      const isLastAttempt = attempt === retries

      if (error instanceof JupiterAPIError) {
        if (error.isRateLimit && !isLastAttempt) {
          console.warn(`Rate limited, retrying in ${retryDelay}ms...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay))
          continue
        }
        throw error
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new JupiterAPIError('Request timeout')
      }

      if (isLastAttempt) {
        throw new JupiterAPIError(
          `Failed to fetch prices after ${retries + 1} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }

      console.warn(`Attempt ${attempt + 1} failed, retrying in ${retryDelay}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }

  // This should never be reached, but TypeScript requires it
  throw new JupiterAPIError('Unexpected error in fetchTokenPricesWithVersion')
}

// Batch function to handle large token lists
export async function fetchTokenPricesBatch(
  tokens: string[],
  options: {
    batchSize?: number
    batchDelay?: number
    timeout?: number
    retries?: number
    retryDelay?: number
  } = {}
): Promise<Record<string, TokenPriceData>> {
  const {
    batchSize = JUPITER_API_CONFIG.MAX_TOKENS_PER_REQUEST,
    batchDelay = 100,
    ...fetchOptions
  } = options

  if (tokens.length <= batchSize) {
    return fetchTokenPrices(tokens, fetchOptions)
  }

  const results: Record<string, TokenPriceData> = {}
  const chunks = []

  for (let i = 0; i < tokens.length; i += batchSize) {
    chunks.push(tokens.slice(i, i + batchSize))
  }

  console.log(`Processing ${tokens.length} tokens in ${chunks.length} batches`)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]

    try {
      const chunkResults = await fetchTokenPrices(chunk, fetchOptions)
      Object.assign(results, chunkResults)

      // Add delay between batches to avoid rate limiting
      if (i < chunks.length - 1 && batchDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, batchDelay))
      }
    } catch (error) {
      console.error(`Batch ${i + 1}/${chunks.length} failed:`, error)

      // Fill failed batch with zero prices
      chunk.forEach(token => {
        results[token] = {
          price: 0,
          source: JUPITER_API_CONFIG.PRIMARY_VERSION
        }
      })
    }
  }

  return results
}

// Helper function to get just the prices (backward compatibility)
export async function getTokenPrices(tokens: string[]): Promise<Record<string, number>> {
  const priceData = await fetchTokenPricesBatch(tokens)
  const prices: Record<string, number> = {}

  Object.entries(priceData).forEach(([token, data]) => {
    prices[token] = data.price
  })

  return prices
}

// Helper function to get a single token price
export async function getTokenPrice(token: string): Promise<number> {
  const prices = await getTokenPrices([token])
  return prices[token] || 0
}

// Configuration functions
export function setJupiterApiVersion(version: 'v2' | 'v3'): void {
  console.log(`Switching Jupiter API primary version from ${JUPITER_API_CONFIG.PRIMARY_VERSION} to ${version}`)
  JUPITER_API_CONFIG.PRIMARY_VERSION = version
}

export function getJupiterApiVersion(): 'v2' | 'v3' {
  return JUPITER_API_CONFIG.PRIMARY_VERSION
}

export function getJupiterApiFallbackVersion(): 'v2' | 'v3' {
  return JUPITER_API_CONFIG.FALLBACK_VERSION
}

export function setJupiterApiFallbackVersion(version: 'v2' | 'v3'): void {
  JUPITER_API_CONFIG.FALLBACK_VERSION = version
  console.log(`Jupiter API fallback version set to ${version}`)
}

export function setAutoFallback(enabled: boolean): void {
  JUPITER_API_CONFIG.AUTO_FALLBACK = enabled
  console.log(`Jupiter API auto-fallback ${enabled ? 'enabled' : 'disabled'}`)
}

export function getFallbackConfig(): {
  primaryVersion: 'v2' | 'v3'
  fallbackVersion: 'v2' | 'v3'
  autoFallback: boolean
} {
  return {
    primaryVersion: JUPITER_API_CONFIG.PRIMARY_VERSION,
    fallbackVersion: JUPITER_API_CONFIG.FALLBACK_VERSION,
    autoFallback: JUPITER_API_CONFIG.AUTO_FALLBACK
  }
}

export function getJupiterApiConfig(): typeof JUPITER_API_CONFIG {
  return { ...JUPITER_API_CONFIG }
}

// Migration helper function
export async function testApiVersions(tokens: string[]): Promise<{
  v2: Record<string, TokenPriceData>
  v3: Record<string, TokenPriceData>
  comparison: {
    token: string
    v2Price: number
    v3Price: number
    difference: number
    percentDifference: number
  }[]
}> {
  const testTokens = tokens.slice(0, 5) // Test with first 5 tokens

  // Test v2
  const originalPrimaryVersion = JUPITER_API_CONFIG.PRIMARY_VERSION
  const originalAutoFallback = JUPITER_API_CONFIG.AUTO_FALLBACK

  // Disable auto-fallback for testing
  JUPITER_API_CONFIG.AUTO_FALLBACK = false

  JUPITER_API_CONFIG.PRIMARY_VERSION = 'v2'
  const v2Results = await fetchTokenPrices(testTokens)

  // Test v3
  JUPITER_API_CONFIG.PRIMARY_VERSION = 'v3'
  const v3Results = await fetchTokenPrices(testTokens)

  // Restore original configuration
  JUPITER_API_CONFIG.PRIMARY_VERSION = originalPrimaryVersion
  JUPITER_API_CONFIG.AUTO_FALLBACK = originalAutoFallback

  // Compare results
  const comparison = testTokens.map(token => {
    const v2Price = v2Results[token]?.price || 0
    const v3Price = v3Results[token]?.price || 0
    const difference = v3Price - v2Price
    const percentDifference = v2Price > 0 ? (difference / v2Price) * 100 : 0

    return {
      token,
      v2Price,
      v3Price,
      difference,
      percentDifference
    }
  })

  return {
    v2: v2Results,
    v3: v3Results,
    comparison
  }
}

const jupiterApi = {
  fetchTokenPrices,
  fetchTokenPricesBatch,
  getTokenPrices,
  getTokenPrice,
  setJupiterApiVersion,
  getJupiterApiVersion,
  getJupiterApiFallbackVersion,
  setJupiterApiFallbackVersion,
  setAutoFallback,
  getFallbackConfig,
  getJupiterApiConfig,
  testApiVersions,
  JupiterAPIError,
};

export default jupiterApi;