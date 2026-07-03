import { NextRequest, NextResponse } from 'next/server'
import { resolveRpcUrlsForProvider } from '@/utils/rpc-urls'
import type { TradeProvider } from '@/utils/trade-provider'
import { rpcRateLimitDelayMs, waitForRpcRateLimit } from '@/utils/rpc-rate-limit'

function parseTradeProvider(request: NextRequest): TradeProvider {
  const header = request.headers.get('x-trade-provider')?.trim()
  if (header === 'shyft') return 'shyft'
  if (header === 'raptor') return 'raptor'
  return process.env.TRADE_PROVIDER?.trim() === 'raptor' ? 'raptor' : 'shyft'
}

const getRpcUrls = (provider: TradeProvider): string[] => {
  const urls = resolveRpcUrlsForProvider(provider)
  if (urls.length === 0) {
    throw new Error('RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env')
  }
  return urls
}

// Memoized RPC URLs per provider
const cachedRpcUrls = new Map<TradeProvider, string[]>()
const getCachedRpcUrls = (provider: TradeProvider): string[] => {
  if (!cachedRpcUrls.has(provider)) {
    cachedRpcUrls.set(provider, getRpcUrls(provider))
  }
  return cachedRpcUrls.get(provider)!
}

// In-memory cache for healthy endpoints (with TTL) — keyed by provider
interface HealthyEndpoint {
  url: string
  lastChecked: number
  responseTime: number
}

const healthyEndpointsCache = new Map<TradeProvider, HealthyEndpoint[]>()
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
const getHealthyEndpoints = async (provider: TradeProvider): Promise<string[]> => {
  const now = Date.now()
  const cache = healthyEndpointsCache.get(provider) ?? []

  if (cache.length > 0 && cache.every((ep) => now - ep.lastChecked < CACHE_TTL)) {
    return cache.map((ep) => ep.url)
  }

  const rpcUrls = getCachedRpcUrls(provider)

  // Parallel health checks with timeout
  const healthResults = await Promise.allSettled(
    rpcUrls.map(url => quickHealthCheck(url, 2000)) // Reduced timeout for faster response
  )

  const nextCache: HealthyEndpoint[] = []
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
    .forEach((result) => {
      nextCache.push({
        url: result.url,
        lastChecked: now,
        responseTime: result.responseTime,
      })
    })

  healthyEndpointsCache.set(provider, nextCache)

  return nextCache.map((ep) => ep.url)
}

// Enhanced RPC request with better error handling and timeout
const makeRpcRequest = async (
  body: any,
  healthyUrls: string[],
  provider: TradeProvider,
): Promise<any> => {
  let lastError: Error | null = null
  const timeout = 8000 // 8 second timeout

  for (const url of healthyUrls) {
    let rateLimited = false

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await waitForRpcRateLimit()

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
          if (response.status === 429) {
            rateLimited = true
            if (attempt === 0) {
              console.warn(`Rate limited by ${url}, retrying after backoff`)
              await new Promise((resolve) =>
                setTimeout(resolve, rpcRateLimitDelayMs(1)),
              )
              continue
            }
            console.warn(`Rate limited by ${url}, trying next endpoint`)
            break
          }

          const errorText = await response.text().catch(() => 'Unknown error')
          throw new Error(`HTTP ${response.status}: ${errorText}`)
        }

        const data = await response.json()

        if (data.error) {
          throw new Error(`RPC Error: ${data.error.message || JSON.stringify(data.error)}`)
        }

        return data
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        console.warn(`RPC request failed for ${url}:`, errorMessage)
        lastError = error instanceof Error ? error : new Error(errorMessage)

        if (
          !rateLimited &&
          !errorMessage.includes('aborted') &&
          !errorMessage.includes('timeout')
        ) {
          const cache = healthyEndpointsCache.get(provider) ?? []
          const index = cache.findIndex((ep) => ep.url === url)
          if (index !== -1) {
            cache.splice(index, 1)
            healthyEndpointsCache.set(provider, cache)
          }
        }

        if (!rateLimited || attempt === 1) {
          break
        }
      }
    }
  }

  throw lastError || new Error('All RPC endpoints failed')
}

export async function POST(request: NextRequest) {
  try {
    const provider = parseTradeProvider(request)
    const body = await request.json()

    let healthyUrls = await getHealthyEndpoints(provider)

    if (healthyUrls.length === 0) {
      console.warn('No healthy endpoints found, using all configured endpoints')
      healthyUrls = getCachedRpcUrls(provider)
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
            'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Trade-Provider',
          },
        }
      )
    }

    // Make request with failover
    const data = await makeRpcRequest(body, healthyUrls, provider)

    // Return successful response
    return NextResponse.json(data, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Trade-Provider',
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
          'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Trade-Provider',
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