// Client-side price fetching utility with intelligent batching
interface ClientPriceCache {
  price: number
  timestamp: number
  expiresAt: number
}

class PriceClient {
  private cache = new Map<string, ClientPriceCache>()
  private pendingRequests = new Map<string, Promise<number>>()
  private batchQueue = new Set<string>()
  private batchTimeout: NodeJS.Timeout | null = null
  
  // Cache configuration
  private readonly CACHE_TTL_MS = 90 * 1000 // 90 seconds client cache
  private readonly BATCH_DELAY_MS = 50 // Aggregate requests for 50ms
  private readonly MAX_BATCH_SIZE = 100 // Jupiter API limit
  
  // Popular tokens get longer cache
  private readonly POPULAR_TOKENS = new Set([
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  ])
  
  private getCachedPrice(token: string): number | null {
    const cached = this.cache.get(token)
    if (!cached) return null
    
    const now = Date.now()
    if (now <= cached.expiresAt) {
      return cached.price
    }
    
    // Remove expired cache
    this.cache.delete(token)
    return null
  }
  
  private setCachedPrice(token: string, price: number): void {
    const now = Date.now()
    const ttl = this.POPULAR_TOKENS.has(token) ? this.CACHE_TTL_MS * 2 : this.CACHE_TTL_MS
    
    this.cache.set(token, {
      price,
      timestamp: now,
      expiresAt: now + ttl
    })
  }
  
  private async processBatch(): Promise<void> {
    if (this.batchQueue.size === 0) return
    
    const tokens = Array.from(this.batchQueue)
    this.batchQueue.clear()
    
    console.log(`Processing client batch: ${tokens.length} tokens`)
    
    try {
      const response = await fetch('/api/tokens/prices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tokens })
      })
      
      if (!response.ok) {
        throw new Error(`Price API error: ${response.status}`)
      }
      
      const data = await response.json()
      const prices = data.prices || {}
      
      // Cache all received prices
      Object.entries(prices).forEach(([token, price]) => {
        if (typeof price === 'number') {
          this.setCachedPrice(token, price)
        }
      })
      
      console.log(`Cached ${Object.keys(prices).length} prices, cache hits: ${data.cached_tokens}, fresh: ${data.fresh_tokens}`)
    } catch (error) {
      console.error('Batch price fetch failed:', error)
    }
  }
  
  private scheduleBatch(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout)
    }
    
    this.batchTimeout = setTimeout(() => {
      this.processBatch()
    }, this.BATCH_DELAY_MS)
  }
  
  async getPrice(token: string): Promise<number> {
    // Check cache first
    const cached = this.getCachedPrice(token)
    if (cached !== null) {
      return cached
    }
    
    // Check if request is already pending
    const pending = this.pendingRequests.get(token)
    if (pending) {
      return pending
    }
    
    // Create new request promise
    const promise = new Promise<number>((resolve, reject) => {
      // Add to batch queue
      this.batchQueue.add(token)
      this.scheduleBatch()
      
      // Set timeout to resolve with cached value
      const timeout = setTimeout(() => {
        const price = this.getCachedPrice(token)
        if (price !== null) {
          resolve(price)
        } else {
          resolve(0) // Default price if all fails
        }
        this.pendingRequests.delete(token)
      }, this.BATCH_DELAY_MS + 1000) // Wait for batch + 1 second
      
      // Check periodically for cache updates
      const checkInterval = setInterval(() => {
        const price = this.getCachedPrice(token)
        if (price !== null) {
          clearTimeout(timeout)
          clearInterval(checkInterval)
          resolve(price)
          this.pendingRequests.delete(token)
        }
      }, 100)
    })
    
    this.pendingRequests.set(token, promise)
    return promise
  }
  
  async getPrices(tokens: string[]): Promise<Record<string, number>> {
    // Split into cached and uncached
    const prices: Record<string, number> = {}
    const tokensToFetch: string[] = []
    
    tokens.forEach(token => {
      const cached = this.getCachedPrice(token)
      if (cached !== null) {
        prices[token] = cached
      } else {
        tokensToFetch.push(token)
      }
    })
    
    // Fetch uncached tokens in batch
    if (tokensToFetch.length > 0) {
      const freshPrices = await Promise.all(
        tokensToFetch.map(token => this.getPrice(token))
      )
      
      tokensToFetch.forEach((token, index) => {
        prices[token] = freshPrices[index]
      })
    }
    
    return prices
  }
  
  // Pre-warm cache with common tokens
  async preWarmCache(tokens: string[] = []): Promise<void> {
    const commonTokens = [
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      ...tokens
    ]
    
    const uniqueTokens = Array.from(new Set(commonTokens))
    const uncachedTokens = uniqueTokens.filter(token => this.getCachedPrice(token) === null)
    
    if (uncachedTokens.length > 0) {
      console.log(`Pre-warming cache for ${uncachedTokens.length} tokens`)
      await this.getPrices(uncachedTokens)
    }
  }
  
  // Clear cache (useful for testing)
  clearCache(): void {
    this.cache.clear()
    this.pendingRequests.clear()
  }
  
  // Get cache stats
  getCacheStats(): {
    cacheSize: number
    popularTokensCached: number
    hitRate: number
  } {
    const cacheSize = this.cache.size
    const popularTokensCached = Array.from(this.cache.keys()).filter(token => 
      this.POPULAR_TOKENS.has(token)
    ).length
    
    return {
      cacheSize,
      popularTokensCached,
      hitRate: 0 // Would need to track hits/misses for real hit rate
    }
  }
}

// Global singleton instance
const priceClient = new PriceClient()

// Exported functions for easy use
export async function getTokenPrice(token: string): Promise<number> {
  return priceClient.getPrice(token)
}

export async function getTokenPrices(tokens: string[]): Promise<Record<string, number>> {
  return priceClient.getPrices(tokens)
}

export async function preWarmPriceCache(tokens: string[] = []): Promise<void> {
  return priceClient.preWarmCache(tokens)
}

export function clearPriceCache(): void {
  priceClient.clearCache()
}

export function getPriceCacheStats(): {
  cacheSize: number
  popularTokensCached: number
  hitRate: number
} {
  return priceClient.getCacheStats()
}

// Hook for React components
export function usePriceClient() {
  return {
    getTokenPrice,
    getTokenPrices,
    preWarmPriceCache,
    clearPriceCache,
    getCacheStats: getPriceCacheStats
  }
}

export default priceClient 