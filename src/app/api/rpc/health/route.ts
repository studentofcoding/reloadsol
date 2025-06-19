import { NextRequest, NextResponse } from 'next/server'

// Parse RPC URLs from environment variable (comma-separated)
const getRpcUrls = (): string[] => {
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL
  if (!rpcUrl) {
    return ['https://api.mainnet-beta.solana.com']
  }
  
  // Split by comma and trim whitespace
  return rpcUrl.split(',').map(url => url.trim()).filter(url => url.length > 0)
}

// Test a single RPC endpoint
const testRpcEndpoint = async (url: string, timeout = 5000): Promise<{ url: string; healthy: boolean; responseTime: number; error?: string }> => {
  const startTime = Date.now()
  
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
      return {
        url,
        healthy: false,
        responseTime,
        error: `HTTP ${response.status}: ${response.statusText}`
      }
    }
    
    const data = await response.json()
    
    if (data.error) {
      return {
        url,
        healthy: false,
        responseTime,
        error: `RPC Error: ${data.error.message || JSON.stringify(data.error)}`
      }
    }
    
    if (typeof data.result !== 'number') {
      return {
        url,
        healthy: false,
        responseTime,
        error: 'Invalid response format'
      }
    }
    
    return {
      url,
      healthy: true,
      responseTime
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime
    return {
      url,
      healthy: false,
      responseTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

export async function GET() {
  try {
    const rpcUrls = getRpcUrls()
    
    // Test all RPC endpoints in parallel
    const healthResults = await Promise.all(
      rpcUrls.map(url => testRpcEndpoint(url))
    )
    
    // Sort by health status (healthy first) then by response time
    const sortedResults = healthResults.sort((a, b) => {
      if (a.healthy && !b.healthy) return -1
      if (!a.healthy && b.healthy) return 1
      if (a.healthy && b.healthy) return a.responseTime - b.responseTime
      return 0
    })
    
    const healthyCount = healthResults.filter(r => r.healthy).length
    const totalCount = healthResults.length
    
    return NextResponse.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      summary: {
        total: totalCount,
        healthy: healthyCount,
        unhealthy: totalCount - healthyCount
      },
      endpoints: sortedResults,
      healthyEndpoints: sortedResults.filter(r => r.healthy).map(r => r.url)
    })
    
  } catch (error) {
    console.error('Health check error:', error)
    return NextResponse.json(
      { 
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
} 