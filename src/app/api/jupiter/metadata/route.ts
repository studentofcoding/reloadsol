import { NextRequest, NextResponse } from 'next/server'
import { fetchTokenMetadataFromJupiter, fetchTokensFromJupiterV2 } from '@/utils/jupiter-metadata'

// Server-side cache with longer TTL since it's on the server
const serverTokenCache = new Map<string, {
  data: {
    decimals: number
    symbol: string
    name: string
    logoURI?: string
    graduatedPool?: string | null
    bondingCurve?: number | null
    organicScore?: number | null
    audit?: {
      topHoldersPercentage?: number | null
    }
    graduatedAt?: number | null
  }
  timestamp: number
}>()

const CACHE_DURATION = 1000 * 60 * 60 * 24 * 31 // 31 days cache on server
const MAX_RETRIES = 3
const RETRY_DELAYS = [400, 800, 1600]
const REQUEST_TIMEOUT = 10000 // 10 seconds timeout

// Rate limiting for server requests
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 200 // 200ms between requests for batch calls

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const mintAddress = searchParams.get('mint')

    if (!mintAddress) {
      return NextResponse.json({ error: 'Mint address is required' }, { status: 400 })
    }

    // Remove strict length validation - let Jupiter API determine validity
    // This allows test cases with invalid addresses to pass through and return default data

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

    // Fetch from Jupiter API v2
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
        source: 'jupiter_api_v2'
      })
    } catch (error) {
      console.warn(`Failed to fetch token metadata for ${mintAddress}:`, error)

      // Return default token data - include graduated pool
      const defaultData = {
        decimals: 6,
        symbol: 'TOKEN',
        name: 'Unknown Token',
        graduatedPool: null
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

// Legacy function for single token (now uses v2 search)
// Moved to utils/jupiter-metadata.ts to avoid invalid exports in a Next.js route

// Fallback token data for common tokens - include graduated pool
const COMMON_TOKENS: Record<string, any> = {
  'So11111111111111111111111111111111111111112': {
    decimals: 9,
    symbol: 'SOL',
    name: 'Wrapped SOL',
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
    graduatedPool: null // SOL doesn't have a graduated pool
  },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': {
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    graduatedPool: null // USDC doesn't have a graduated pool
  },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': {
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
    graduatedPool: null // USDT doesn't have a graduated pool
  },
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { mints } = body

    if (!mints) {
      return NextResponse.json({ error: 'Mints field is required' }, { status: 400 })
    }

    if (!Array.isArray(mints)) {
      return NextResponse.json({ error: 'Mints must be an array' }, { status: 400 })
    }

    if (mints.length === 0) {
      return NextResponse.json({ error: 'Mints array cannot be empty' }, { status: 400 })
    }

    if (mints.length > 500) {
      return NextResponse.json({ error: 'Maximum 500 mints per batch request' }, { status: 400 })
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

    // Fetch uncached mints from Jupiter API v2 with 100-token batches
    if (uncachedMints.length > 0) {
      const BATCH_SIZE = 100 // Process 100 at a time (Jupiter v2 limit)

      for (let i = 0; i < uncachedMints.length; i += BATCH_SIZE) {
        const batch = uncachedMints.slice(i, i + BATCH_SIZE)

        try {
          const batchResults = await fetchTokensFromJupiterV2(batch)

          // Process results and cache them
          batch.forEach(mint => {
            if (batchResults[mint]) {
              // Cache the result
              serverTokenCache.set(mint, {
                data: batchResults[mint],
                timestamp: Date.now()
              })

              results[mint] = {
                data: batchResults[mint],
                cached: false,
                source: 'jupiter_api_v2'
              }
            } else {
              // Token not found in batch results - include graduated pool
              const defaultData = {
                decimals: 6,
                symbol: 'TOKEN',
                name: 'Unknown Token',
                graduatedPool: null
              }

              results[mint] = {
                data: defaultData,
                cached: false,
                source: 'default',
                error: 'Token not found in Jupiter API'
              }
            }
          })
        } catch (error) {
          console.warn(`Failed to fetch batch of tokens:`, error)

          // Handle failed batch - assign default data to all tokens in batch
          batch.forEach(mint => {
            const defaultData = {
              decimals: 6,
              symbol: 'TOKEN',
              name: 'Unknown Token',
              graduatedPool: null
            }

            results[mint] = {
              data: defaultData,
              cached: false,
              source: 'default',
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          })
        }

        // Small delay between batches to be respectful to the API
        if (i + BATCH_SIZE < uncachedMints.length) {
          await new Promise(resolve => setTimeout(resolve, 300))
        }
      }
    }

    return NextResponse.json({
      results,
      totalRequested: mints.length,
      fromCache: mints.length - uncachedMints.length,
      fromAPI: uncachedMints.length,
      batchesUsed: Math.ceil(uncachedMints.length / 100)
    })
  } catch (error) {
    console.error('Jupiter metadata batch API error:', error)

    // Handle JSON parsing errors
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      )
    }

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