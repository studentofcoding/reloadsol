import { NextRequest, NextResponse } from 'next/server'

// Shared RPC URL parsing utility (matches main RPC route)
const getRpcUrls = (): string[] => {
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) {
    return ['https://rpc.shyft.to?api_key=dt_BAV8lwogCz_vn']
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

// Enhanced RPC endpoint testing with better error categorization
const testRpcEndpoint = async (url: string, timeout = 5000): Promise<{ url: string; healthy: boolean; responseTime: number; error?: string; errorType?: string }> => {
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
      const errorType = response.status === 429 ? 'rate_limit' : 
                      response.status >= 500 ? 'server_error' : 'client_error'
      return {
        url,
        healthy: false,
        responseTime,
        error: `HTTP ${response.status}: ${response.statusText}`,
        errorType
      }
    }
    
    const data = await response.json()
    
    if (data.error) {
      return {
        url,
        healthy: false,
        responseTime,
        error: `RPC Error: ${data.error.message || JSON.stringify(data.error)}`,
        errorType: 'rpc_error'
      }
    }
    
    if (typeof data.result !== 'number') {
      return {
        url,
        healthy: false,
        responseTime,
        error: 'Invalid response format',
        errorType: 'invalid_response'
      }
    }
    
    return {
      url,
      healthy: true,
      responseTime
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorType = errorMessage.includes('aborted') || errorMessage.includes('timeout') ? 'timeout' :
                     errorMessage.includes('network') || errorMessage.includes('fetch') ? 'network' : 'unknown'
    return {
      url,
      healthy: false,
      responseTime,
      error: errorMessage,
      errorType
    }
  }
}

// Generate recommendations based on health check results
function generateRecommendations(results: any[]): string[] {
  const recommendations: string[] = []
  const healthyCount = results.filter(r => r.healthy).length
  const totalCount = results.length
  
  if (healthyCount === 0) {
    recommendations.push('CRITICAL: All RPC endpoints are unhealthy. Check network connectivity and endpoint configurations.')
  } else if (healthyCount < totalCount * 0.5) {
    recommendations.push('WARNING: Less than 50% of RPC endpoints are healthy. Consider reviewing endpoint configurations.')
  }
  
  const timeoutErrors = results.filter(r => r.errorType === 'timeout').length
  if (timeoutErrors > 0) {
    recommendations.push(`${timeoutErrors} endpoint(s) experiencing timeout issues. Consider increasing timeout values or checking network latency.`)
  }
  
  const rateLimitErrors = results.filter(r => r.errorType === 'rate_limit').length
  if (rateLimitErrors > 0) {
    recommendations.push(`${rateLimitErrors} endpoint(s) are rate limited. Consider implementing request throttling or upgrading API plans.`)
  }
  
  const avgResponseTime = results
    .filter(r => r.healthy)
    .reduce((sum, r) => sum + r.responseTime, 0) / (healthyCount || 1)
    
  if (avgResponseTime > 2000) {
    recommendations.push('Average response time is high (>2s). Consider optimizing network configuration or switching to faster endpoints.')
  }
  
  if (recommendations.length === 0) {
    recommendations.push('All systems operating normally.')
  }
  
  return recommendations
}

export async function GET() {
  try {
    const rpcUrls = getCachedRpcUrls()
    
    // Test all RPC endpoints in parallel with timeout
    const healthResults = await Promise.allSettled(
      rpcUrls.map(url => testRpcEndpoint(url, 3000)) // Reduced timeout for faster health checks
    )
    
    // Process results and handle failures
    const processedResults = healthResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value
      } else {
        return {
          url: rpcUrls[index],
          healthy: false,
          responseTime: 3000,
          error: `Health check failed: ${result.reason}`,
          errorType: 'health_check_failure'
        }
      }
    })
    
    // Sort by health status (healthy first) then by response time
    const sortedResults = processedResults.sort((a, b) => {
      if (a.healthy && !b.healthy) return -1
      if (!a.healthy && b.healthy) return 1
      if (a.healthy && b.healthy) return a.responseTime - b.responseTime
      return 0
    })
    
    const healthyCount = processedResults.filter(r => r.healthy).length
    const totalCount = processedResults.length
    
    // Calculate error statistics
    const errorStats = processedResults
      .filter(r => !r.healthy)
      .reduce((acc, r) => {
        const type = r.errorType || 'unknown'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {} as Record<string, number>)
    
    return NextResponse.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      summary: {
        total: totalCount,
        healthy: healthyCount,
        unhealthy: totalCount - healthyCount,
        healthyPercentage: Math.round((healthyCount / totalCount) * 100),
        averageResponseTime: Math.round(
          processedResults
            .filter(r => r.healthy)
            .reduce((sum, r) => sum + r.responseTime, 0) / (healthyCount || 1)
        )
      },
      endpoints: sortedResults,
      healthyEndpoints: sortedResults.filter(r => r.healthy).map(r => r.url),
      errorStats,
      recommendations: generateRecommendations(processedResults)
    }, {
      headers: {
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=10'
      }
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