/**
 * Connection health check utility for SSE and API endpoints
 */

export interface HealthCheckResult {
  isHealthy: boolean
  latency: number
  error?: string
}

export class ConnectionHealthChecker {
  private static instance: ConnectionHealthChecker
  private healthCache = new Map<string, { result: HealthCheckResult; timestamp: number }>()
  private readonly CACHE_TTL = 30000 // 30 seconds

  static getInstance(): ConnectionHealthChecker {
    if (!ConnectionHealthChecker.instance) {
      ConnectionHealthChecker.instance = new ConnectionHealthChecker()
    }
    return ConnectionHealthChecker.instance
  }

  /**
   * Check if SSE endpoint is available
   */
  async checkSSEHealth(baseUrl: string): Promise<HealthCheckResult> {
    const cacheKey = `sse-${baseUrl}`
    const cached = this.healthCache.get(cacheKey)
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.result
    }

    const startTime = Date.now()
    
    try {
      // Test with a simple HEAD request to the SSE endpoint
      const response = await fetch(`${baseUrl}/api/trading/subscribe?wallet=test`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000) // 5 second timeout
      })
      
      const latency = Date.now() - startTime
      const result: HealthCheckResult = {
        isHealthy: response.ok,
        latency,
        error: response.ok ? undefined : `HTTP ${response.status}`
      }
      
      this.healthCache.set(cacheKey, { result, timestamp: Date.now() })
      return result
      
    } catch (error) {
      const latency = Date.now() - startTime
      const result: HealthCheckResult = {
        isHealthy: false,
        latency,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
      
      this.healthCache.set(cacheKey, { result, timestamp: Date.now() })
      return result
    }
  }

  /**
   * Check if API endpoint is available
   */
  async checkAPIHealth(baseUrl: string): Promise<HealthCheckResult> {
    const cacheKey = `api-${baseUrl}`
    const cached = this.healthCache.get(cacheKey)
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.result
    }

    const startTime = Date.now()
    
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      })
      
      const latency = Date.now() - startTime
      const result: HealthCheckResult = {
        isHealthy: response.ok,
        latency,
        error: response.ok ? undefined : `HTTP ${response.status}`
      }
      
      this.healthCache.set(cacheKey, { result, timestamp: Date.now() })
      return result
      
    } catch (error) {
      const latency = Date.now() - startTime
      const result: HealthCheckResult = {
        isHealthy: false,
        latency,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
      
      this.healthCache.set(cacheKey, { result, timestamp: Date.now() })
      return result
    }
  }

  /**
   * Clear health check cache
   */
  clearCache(): void {
    this.healthCache.clear()
  }
}

export const connectionHealthChecker = ConnectionHealthChecker.getInstance()