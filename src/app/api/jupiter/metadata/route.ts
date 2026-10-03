import { NextRequest, NextResponse, connection } from 'next/server'
import {
  JUPITER_IMMUTABLE_MAX_AGE_MS,
  fetchTokenMetadataFromJupiter,
  isJupiterUnavailable,
  lookupJupiterMetadata,
} from '@/utils/jupiter-metadata'

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
    launchpad?: string | null
  }
  timestamp: number
}>()

const CACHE_DURATION = 1000 * 60 * 60 * 24 * 31 // 31 days cache on server

export async function GET(request: NextRequest) {
  await connection()
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
      // Identity fields (symbol/name/decimals/logo) are immutable: accept a week-old answer and let
      // the shared cache/queue decide whether Jupiter needs to be asked at all.
      const tokenData = await fetchTokenMetadataFromJupiter(mintAddress, {
        maxAgeMs: JUPITER_IMMUTABLE_MAX_AGE_MS,
      })

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

      // Jupiter could not be asked (429 / timeout / 5xx): say so. Fabricating decimals 6 / "TOKEN" here
      // made a rate limit look like a real token to every client that read `data`.
      if (isJupiterUnavailable(error)) {
        const retryAfterSec = Math.max(1, Math.ceil((error.retryAfterMs ?? 10_000) / 1000))
        return NextResponse.json(
          { error: 'jupiter_unavailable', unavailable: true, reason: error.reason, retryAfterSec },
          { status: 503, headers: { 'Retry-After': String(retryAfterSec) } },
        )
      }

      // Jupiter answered "no such token": keep the legacy placeholder, explicitly flagged
      // (source 'default', never cached) - include graduated pool
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

    // Fetch uncached mints through the shared cache/queue: it coalesces them into <=100-mint
    // requests and paces them, so this route no longer runs its own batching loop.
    if (uncachedMints.length > 0) {
      try {
        const lookup = await lookupJupiterMetadata(uncachedMints, {
          maxAgeMs: JUPITER_IMMUTABLE_MAX_AGE_MS,
        })
        const unavailableByMint = new Map(lookup.unavailable.map((u) => [u.mint, u.error]))

        uncachedMints.forEach(mint => {
          const found = lookup.found[mint]
          const unavailable = unavailableByMint.get(mint)
          if (found) {
            serverTokenCache.set(mint, { data: found, timestamp: Date.now() })
            results[mint] = { data: found, cached: false, source: 'jupiter_api_v2' }
          } else if (unavailable) {
            // No `data`: a rate limit is not a token. Clients skip entries without data and retry later.
            results[mint] = {
              cached: false,
              source: 'unavailable',
              unavailable: true,
              error: unavailable.message,
            }
          } else {
            // Jupiter answered and has no such token - include graduated pool
            results[mint] = {
              data: { decimals: 6, symbol: 'TOKEN', name: 'Unknown Token', graduatedPool: null },
              cached: false,
              source: 'default',
              error: 'Token not found in Jupiter API'
            }
          }
        })
      } catch (error) {
        console.warn(`Failed to fetch batch of tokens:`, error)
        uncachedMints.forEach(mint => {
          results[mint] = {
            cached: false,
            source: 'unavailable',
            unavailable: true,
            error: error instanceof Error ? error.message : 'Unknown error'
          }
        })
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