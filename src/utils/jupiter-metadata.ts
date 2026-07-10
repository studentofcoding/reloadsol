// Rate limiting for server requests
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 200 // 200ms between requests for batch calls

const MAX_RETRIES = 3
const RETRY_DELAYS = [400, 800, 1600]
const REQUEST_TIMEOUT = 10000 // 10 seconds timeout

// New function to fetch multiple tokens using v2 search endpoint
async function fetchTokensFromJupiterV2(mintAddresses: string[], retryCount = 0): Promise<Record<string, any>> {
  try {
    // Rate limiting: ensure minimum interval between requests
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequestTime

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve =>
        setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      )
    }

    // Create AbortController for timeout handling
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)

    // Prepare query string with comma-separated mint addresses
    const query = mintAddresses.join(',')
    const url = `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(query)}`

    let response: Response
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ReloadSol-API/1.0'
        }
      })
      lastRequestTime = Date.now()
      clearTimeout(timeoutId)
    } catch (fetchError) {
      clearTimeout(timeoutId)
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('Request timeout after 10 seconds')
      }
      throw new Error(`Network error: ${fetchError}`)
    }

    if (response.status === 429) {
      // Rate limited - implement exponential backoff
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount] || 1600
        console.warn(`Rate limited for batch request, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`)

        await new Promise(resolve => setTimeout(resolve, delay))
        return fetchTokensFromJupiterV2(mintAddresses, retryCount + 1)
      } else {
        throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries`)
      }
    }

    if (response.status === 504) {
      // Gateway timeout - retry with backoff
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount] || 1600
        console.warn(`Gateway timeout for batch request, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`)

        await new Promise(resolve => setTimeout(resolve, delay))
        return fetchTokensFromJupiterV2(mintAddresses, retryCount + 1)
      } else {
        throw new Error(`Gateway timeout after ${MAX_RETRIES} retries`)
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const tokensData = await response.json()

    // Convert array response to object keyed by mint address - include graduated pool
    const results: Record<string, any> = {}

    if (Array.isArray(tokensData)) {
      tokensData.forEach(token => {
        if (token.id) {
          results[token.id] = {
            decimals: token.decimals,
            symbol: token.symbol,
            name: token.name,
            logoURI: token.icon,
            graduatedPool: token.graduatedPool || null, // Include graduated pool if available
            bondingCurve: typeof token.bondingCurve === 'number' ? token.bondingCurve : null,
            organicScore: typeof token.organicScore === 'number' ? token.organicScore : null,
            audit: token.audit ? { topHoldersPercentage: typeof token.audit.topHoldersPercentage === 'number' ? token.audit.topHoldersPercentage : null } : undefined,
            graduatedAt: token.graduatedAt ? Number(token.graduatedAt) : null,
            launchpad: token.launchpad
          }
        }
      })
    }

    return results
  } catch (error) {
    if (retryCount < MAX_RETRIES && error instanceof Error &&
      (error.message.includes('Network error') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('timeout') ||
        (error as any).name === 'TypeError')) {
      // Network error - retry with backoff
      const delay = RETRY_DELAYS[retryCount] || 1600
      console.warn(`Network error for batch request, retrying in ${delay}ms`)

      await new Promise(resolve => setTimeout(resolve, delay))
      return fetchTokensFromJupiterV2(mintAddresses, retryCount + 1)
    }

    throw error
  }
}

// Legacy function for single token (now uses v2 search)
export async function fetchTokenMetadataFromJupiter(mintAddress: string, retryCount = 0): Promise<any> {
  const results = await fetchTokensFromJupiterV2([mintAddress], retryCount)
  const tokenData = results[mintAddress]

  if (!tokenData) {
    throw new Error(`Token not found: ${mintAddress}`)
  }

  return tokenData
}

// Export the batch fetching function as well for use in route handlers
export { fetchTokensFromJupiterV2 }

export type JupiterMarketHints = {
  usdPrice: number | null
  volume5m: number | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Parse usdPrice + 5m volume from lite-api v2 search JSON (array or single object).
 * volume_5m = stats5m.buyVolume + stats5m.sellVolume when either is present.
 */
export function parseJupiterV2MarketHints(
  raw: unknown,
  mintAddress?: string,
): JupiterMarketHints | null {
  let token: Record<string, unknown> | null = null

  if (Array.isArray(raw)) {
    const match = mintAddress
      ? raw.find(
          (t) =>
            t &&
            typeof t === 'object' &&
            (t as { id?: string }).id === mintAddress,
        )
      : raw[0]
    token =
      match && typeof match === 'object'
        ? (match as Record<string, unknown>)
        : null
  } else if (raw && typeof raw === 'object') {
    token = raw as Record<string, unknown>
  }

  if (!token) return null

  const usdPrice = finiteOrNull(token.usdPrice)
  const stats5m =
    token.stats5m && typeof token.stats5m === 'object'
      ? (token.stats5m as Record<string, unknown>)
      : null
  const buy = finiteOrNull(stats5m?.buyVolume)
  const sell = finiteOrNull(stats5m?.sellVolume)
  const volume5m =
    buy != null || sell != null ? (buy ?? 0) + (sell ?? 0) : null

  if (usdPrice == null && volume5m == null) return null

  return { usdPrice, volume5m }
}

/** Rate-limited Jupiter v2 search → price + 5m volume for monitor/entry enrichment. */
export async function fetchJupiterMarketHints(
  mintAddress: string,
): Promise<JupiterMarketHints | null> {
  try {
    const raw = await fetchJupiterV2SearchRaw(mintAddress)
    return parseJupiterV2MarketHints(raw, mintAddress)
  } catch {
    return null
  }
}

/** Full lite-api v2 search JSON (unmapped) for a single mint. */
export async function fetchJupiterV2SearchRaw(
  mintAddress: string,
  retryCount = 0,
): Promise<unknown> {
  const now = Date.now()
  const timeSinceLastRequest = now - lastRequestTime
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest),
    )
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  const url = `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mintAddress)}`

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ReloadSol-API/1.0',
      },
    })
    lastRequestTime = Date.now()
    clearTimeout(timeoutId)

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[retryCount] ?? 1600),
      )
      return fetchJupiterV2SearchRaw(mintAddress, retryCount + 1)
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return response.json()
  } catch (error) {
    clearTimeout(timeoutId)
    if (
      retryCount < MAX_RETRIES &&
      error instanceof Error &&
      (error.message.includes('Network error') ||
        error.name === 'AbortError' ||
        error.name === 'TypeError')
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[retryCount] ?? 1600),
      )
      return fetchJupiterV2SearchRaw(mintAddress, retryCount + 1)
    }
    throw error
  }
}

/** datapi.jup.ag assets search — raw JSON for token locate. */
export async function fetchJupiterDatapiSearchRaw(mintAddress: string): Promise<unknown> {
  const response = await fetch(
    `https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(mintAddress)}`,
    {
      headers: {
        accept: 'application/json',
        referer: 'https://jup.ag/',
        'user-agent': 'ReloadSol-API/1.0',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`datapi HTTP ${response.status}`)
  }
  return response.json()
}