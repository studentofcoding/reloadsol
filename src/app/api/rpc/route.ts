import { NextRequest, NextResponse } from 'next/server'

// Shared RPC URL parsing utility
const getRpcUrls = (): string[] => {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    return ['https://mainnet.helius-rpc.com/?api-key=9b707ec2-17da-4c3a-b17d-19bb3a58dd2d']
  }

  // Split by comma and trim whitespace
  return rpcUrl.split(',').map(url => url.trim()).filter(url => url.length > 0)
}

// Memoized RPC URLs to avoid repeated parsing
let cachedRpcUrls: string[] | null = null
const getCachedRpcUrls = (): string[] => {
  if (!cachedRpcUrls) {
    cachedRpcUrls = getRpcUrls()
  }
  return cachedRpcUrls
}

// In-memory cache for healthy endpoints (with TTL)
interface HealthyEndpoint {
  url: string
  lastChecked: number
  responseTime: number
}

const healthyEndpointsCache: HealthyEndpoint[] = []
const CACHE_TTL = 60 * 1000 // 1 minute cache

// Test a single RPC endpoint quickly
const quickHealthCheck = async (url: string, timeout = 3000): Promise<{ url: string; healthy: boolean; responseTime: number }> => {
  const startTime = Date.now()

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSlot',
        params: []
      }),
      signal: controller.signal
    })

    clearTimeout(timeoutId)
    const responseTime = Date.now() - startTime

    if (!response.ok) {
      return { url, healthy: false, responseTime }
    }

    const data = await response.json()

    if (data.error || typeof data.result !== 'number') {
      return { url, healthy: false, responseTime }
    }

    return { url, healthy: true, responseTime }

  } catch (error) {
    return { url, healthy: false, responseTime: Date.now() - startTime }
  }
}

// Enhanced health check with better error handling and circuit breaker
const getHealthyEndpoints = async (): Promise<string[]> => {
  const now = Date.now()

  // Check if cache is still valid
  if (healthyEndpointsCache.length > 0 &&
    healthyEndpointsCache.every(ep => now - ep.lastChecked < CACHE_TTL)) {
    return healthyEndpointsCache.map(ep => ep.url)
  }

  // Use cached RPC URLs
  const rpcUrls = getCachedRpcUrls()

  // Parallel health checks with timeout
  const healthResults = await Promise.allSettled(
    rpcUrls.map(url => quickHealthCheck(url, 2000)) // Reduced timeout for faster response
  )

  // Update cache with healthy endpoints
  healthyEndpointsCache.length = 0 // Clear cache
  healthResults
    .filter((result, index) => {
      if (result.status === 'fulfilled' && result.value.healthy) {
        return true
      }
      if (result.status === 'rejected') {
        console.warn(`Health check failed for ${rpcUrls[index]}:`, result.reason)
      }
      return false
    })
    .map((result, index) => ({
      ...(result as PromiseFulfilledResult<any>).value,
      originalIndex: index
    }))
    .sort((a, b) => a.responseTime - b.responseTime) // Sort by response time
    .forEach(result => {
      healthyEndpointsCache.push({
        url: result.url,
        lastChecked: now,
        responseTime: result.responseTime
      })
    })

  return healthyEndpointsCache.map(ep => ep.url)
}

// Enhanced RPC request with better error handling and timeout
const makeRpcRequest = async (body: any, healthyUrls: string[]): Promise<any> => {
  let lastError: Error | null = null
  const timeout = 8000 // 8 second timeout

  for (const url of healthyUrls) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        // Handle rate limiting specifically
        if (response.status === 429) {
          console.warn(`Rate limited by ${url}, trying next endpoint`)
          continue
        }

        const errorText = await response.text().catch(() => 'Unknown error')
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const data = await response.json()

      // Validate response structure
      if (data.error) {
        throw new Error(`RPC Error: ${data.error.message || JSON.stringify(data.error)}`)
      }

      return data

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.warn(`RPC request failed for ${url}:`, errorMessage)
      lastError = error instanceof Error ? error : new Error(errorMessage)

      // Remove failed endpoint from cache only on non-timeout errors
      if (!errorMessage.includes('aborted') && !errorMessage.includes('timeout')) {
        const index = healthyEndpointsCache.findIndex(ep => ep.url === url)
        if (index !== -1) {
          healthyEndpointsCache.splice(index, 1)
        }
      }

      continue
    }
  }

  throw lastError || new Error('All RPC endpoints failed')
}

export async function POST(request: NextRequest) {
  try {
    // Get the request body
    const body = await request.json()

    // Get healthy endpoints with fallback
    let healthyUrls = await getHealthyEndpoints()

    // Fallback to all URLs if no healthy endpoints found
    if (healthyUrls.length === 0) {
      console.warn('No healthy endpoints found, using all configured endpoints')
      healthyUrls = getCachedRpcUrls()
    }

    if (healthyUrls.length === 0) {
      console.error('No healthy RPC endpoints available')
      return NextResponse.json(
        {
          error: 'No healthy RPC endpoints available',
          details: 'All configured RPC endpoints are currently unhealthy'
        },
        {
          status: 503,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
          },
        }
      )
    }

    // Make request with failover
    const data = await makeRpcRequest(body, healthyUrls)

    // Return successful response
    return NextResponse.json(data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'X-RPC-Endpoint': healthyUrls[0], // Indicate which endpoint was used
      },
    })

  } catch (error) {
    console.error('RPC proxy error:', error)
    return NextResponse.json(
      {
        error: 'RPC request failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      {
        status: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
        },
      }
    )
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  })
}