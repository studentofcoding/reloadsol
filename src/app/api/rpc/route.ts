import { NextRequest, NextResponse } from 'next/server'

// Parse RPC URLs from environment variable (comma-separated)
const getRpcUrls = (): string[] => {
  const rpcUrl = typeof window === 'undefined' ? process.env.RPC_URL : process.env.NEXT_PUBLIC_RPC_URL
  if (!rpcUrl) {
    return ['https://api.mainnet-beta.solana.com']
  }
  
  // Split by comma and trim whitespace
  return rpcUrl.split(',').map(url => url.trim()).filter(url => url.length > 0)
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

// Get healthy endpoints (with caching)
const getHealthyEndpoints = async (): Promise<string[]> => {
  const now = Date.now()
  
  // Check if cache is still valid
  if (healthyEndpointsCache.length > 0 && 
      healthyEndpointsCache.every(ep => now - ep.lastChecked < CACHE_TTL)) {
    return healthyEndpointsCache.map(ep => ep.url)
  }
  
  // Test all endpoints
  const rpcUrls = getRpcUrls()
  const healthResults = await Promise.all(
    rpcUrls.map(url => quickHealthCheck(url))
  )
  
  // Update cache with healthy endpoints
  healthyEndpointsCache.length = 0 // Clear cache
  healthResults
    .filter(result => result.healthy)
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

// Make RPC request with automatic failover
const makeRpcRequest = async (body: any, healthyUrls: string[]): Promise<any> => {
  let lastError: Error | null = null
  
  for (const url of healthyUrls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      
      // If we get here, the request was successful
      return data
      
    } catch (error) {
      console.warn(`RPC request failed for ${url}:`, error instanceof Error ? error.message : error)
      lastError = error instanceof Error ? error : new Error(String(error))
      
      // Remove failed endpoint from cache
      const index = healthyEndpointsCache.findIndex(ep => ep.url === url)
      if (index !== -1) {
        healthyEndpointsCache.splice(index, 1)
      }
      
      // Continue to next endpoint
      continue
    }
  }
  
  // If we get here, all endpoints failed
  throw lastError || new Error('All RPC endpoints failed')
}

export async function POST(request: NextRequest) {
  try {
    // Get the request body
    const body = await request.json()
    
    // Get healthy endpoints
    const healthyUrls = await getHealthyEndpoints()
    
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