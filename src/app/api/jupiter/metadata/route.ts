import { NextRequest, NextResponse } from 'next/server'

// Server-side cache with longer TTL since it's on the server
const serverTokenCache = new Map<string, {
  data: {
    decimals: number
    symbol: string
    name: string
    logoURI?: string
  }
  timestamp: number
}>()

const CACHE_DURATION = 1000 * 60 * 60 * 24 // 24 hours cache on server
const MAX_RETRIES = 3
const RETRY_DELAYS = [400, 800, 1600]

// Rate limiting for server requests
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 100 // 100ms between requests (10 requests per second)

async function fetchTokenMetadataFromJupiter(mintAddress: string, retryCount = 0): Promise<any> {
  try {
    // Rate limiting: ensure minimum interval between requests
    const now = Date.now()
    const timeSinceLastRequest = now - lastRequestTime
    
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => 
        setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      )
    }
    
    const response = await fetch(`https://lite-api.jup.ag/tokens/v1/token/${mintAddress}`)
    lastRequestTime = Date.now()
    
    if (response.status === 429) {
      // Rate limited - implement exponential backoff
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount] || 1600
        console.warn(`Rate limited for ${mintAddress}, retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`)
        
        await new Promise(resolve => setTimeout(resolve, delay))
        return fetchTokenMetadataFromJupiter(mintAddress, retryCount + 1)
      } else {
        throw new Error(`Rate limit exceeded after ${MAX_RETRIES} retries`)
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const tokenData = await response.json()
    return {
      decimals: tokenData.decimals,
      symbol: tokenData.symbol,
      name: tokenData.name,
      logoURI: tokenData.logoURI
    }
  } catch (error) {
    if (retryCount < MAX_RETRIES && error instanceof Error && error.message.includes('fetch')) {
      // Network error - retry with backoff
      const delay = RETRY_DELAYS[retryCount] || 1600
      console.warn(`Network error for ${mintAddress}, retrying in ${delay}ms`)
      
      await new Promise(resolve => setTimeout(resolve, delay))
      return fetchTokenMetadataFromJupiter(mintAddress, retryCount + 1)
    }
    
    throw error
  }
}

// Fallback token data for common tokens
const COMMON_TOKENS: Record<string, any> = {
  'So11111111111111111111111111111111111111112': { 
    decimals: 9, 
    symbol: 'SOL', 
    name: 'Wrapped SOL', 
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png' 
  },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { 
    decimals: 6, 
    symbol: 'USDC', 
    name: 'USD Coin', 
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png' 
  },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { 
    decimals: 6, 
    symbol: 'USDT', 
    name: 'Tether USD', 
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg' 
  },
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get('mint')
    
    if (!mintAddress) {
      return NextResponse.json({ error: 'Mint address is required' }, { status: 400 })
    }

    // Check server cache first
    const cached = serverTokenCache.get(mintAddress)
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
      return NextResponse.json({ 
        data: cached.data, 
        cached: true,
        cacheAge: Date.now() - cached.timestamp 
      })
    }

    // Check common tokens
    if (COMMON_TOKENS[mintAddress]) {
      const data = COMMON_TOKENS[mintAddress]
      // Cache common tokens too
      serverTokenCache.set(mintAddress, {
        data,
        timestamp: Date.now()
      })
      return NextResponse.json({ 
        data, 
        cached: false,
        source: 'common_tokens' 
      })
    }

    // Fetch from Jupiter API
    try {
      const tokenData = await fetchTokenMetadataFromJupiter(mintAddress)
      
      // Cache the result
      serverTokenCache.set(mintAddress, {
        data: tokenData,
        timestamp: Date.now()
      })
      
      return NextResponse.json({ 
        data: tokenData, 
        cached: false,
        source: 'jupiter_api' 
      })
    } catch (error) {
      console.warn(`Failed to fetch token metadata for ${mintAddress}:`, error)
      
      // Return default token data
      const defaultData = { 
        decimals: 6, 
        symbol: 'TOKEN', 
        name: 'Unknown Token' 
      }
      
      return NextResponse.json({ 
        data: defaultData, 
        cached: false,
        source: 'default',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  } catch (error) {
    console.error('Jupiter metadata API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' }, 
      { status: 500 }
    )
  }
}

// POST endpoint for batch requests
export async function POST(request: NextRequest) {
  try {
    const { mints } = await request.json()
    
    if (!Array.isArray(mints) || mints.length === 0) {
      return NextResponse.json({ error: 'Mints array is required' }, { status: 400 })
    }

    if (mints.length > 50) {
      return NextResponse.json({ error: 'Maximum 50 mints per batch request' }, { status: 400 })
    }

    const results: Record<string, any> = {}
    const uncachedMints: string[] = []

    // Check cache for all mints first
    mints.forEach(mint => {
      const cached = serverTokenCache.get(mint)
      if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        results[mint] = { 
          data: cached.data, 
          cached: true,
          cacheAge: Date.now() - cached.timestamp 
        }
      } else if (COMMON_TOKENS[mint]) {
        const data = COMMON_TOKENS[mint]
        // Cache common tokens
        serverTokenCache.set(mint, {
          data,
          timestamp: Date.now()
        })
        results[mint] = { 
          data, 
          cached: false,
          source: 'common_tokens' 
        }
      } else {
        uncachedMints.push(mint)
      }
    })

    // Fetch uncached mints from Jupiter API with controlled concurrency
    if (uncachedMints.length > 0) {
      const BATCH_SIZE = 10 // Process 10 at a time
      
      for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
        const batch = uncachedMints.slice(i, i + BATCH_SIZE)
        
        const batchPromises = batch.map(async (mint) => {
          try {
            const tokenData = await fetchTokenMetadataFromJupiter(mint)
            
            // Cache the result
            serverTokenCache.set(mint, {
              data: tokenData,
              timestamp: Date.now()
            })
            
            results[mint] = { 
              data: tokenData, 
              cached: false,
              source: 'jupiter_api' 
            }
          } catch (error) {
            console.warn(`Failed to fetch token metadata for ${mint}:`, error)
            
            const defaultData = { 
              decimals: 6, 
              symbol: 'TOKEN', 
              name: 'Unknown Token' 
            }
            
            results[mint] = { 
              data: defaultData, 
              cached: false,
              source: 'default',
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          }
        })

        // Wait for current batch to complete
        await Promise.all(batchPromises)
        
        // Small delay between batches to be respectful to the API
        if (i + BATCH_SIZE < uncachedMints.length) {
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
    }

    return NextResponse.json({ 
      results,
      totalRequested: mints.length,
      fromCache: mints.length - uncachedMints.length,
      fromAPI: uncachedMints.length
    })
  } catch (error) {
    console.error('Jupiter metadata batch API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' }, 
      { status: 500 }
    )
  }
}

// Cache cleanup endpoint (optional - for maintenance)
export async function DELETE() {
  try {
    const sizeBefore = serverTokenCache.size
    
    // Clean up expired entries
    const now = Date.now()
    const keysToDelete: string[] = []
    
    serverTokenCache.forEach((value, key) => {
      if (now - value.timestamp > CACHE_DURATION) {
        keysToDelete.push(key)
      }
    })
    
    keysToDelete.forEach(key => serverTokenCache.delete(key))
    
    return NextResponse.json({ 
      message: 'Cache cleaned up',
      sizeBefore,
      sizeAfter: serverTokenCache.size,
      deletedEntries: keysToDelete.length
    })
  } catch (error) {
    console.error('Cache cleanup error:', error)
    return NextResponse.json(
      { error: 'Internal server error' }, 
      { status: 500 }
    )
  }
} 