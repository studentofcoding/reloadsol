import { NextRequest, NextResponse } from 'next/server'

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'

// Import the interfaces and cache from the main trending route
import type { TransformedToken } from '../route'
import { tokenCache, fetchAndUpdateCache } from '../route'

// We'll import the tokenCache from the main route to access the same data
// This ensures consistency and avoids duplicate API calls
export async function GET(request: NextRequest) {
    try {
        // Import the tokenCache and related functions from the main trending route
        // const { tokenCache, fetchAndUpdateCache } = await import('../route')

        const currentTime = Date.now()
        const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
        const FULL_REFRESH_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

        // Parse query parameters
        const { searchParams } = new URL(request.url)
        const forceRefresh = searchParams.get('refresh') === 'true'
        const skipCache = searchParams.get('nocache') === 'true'

        const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS || forceRefresh

        // Get the raw token data (either from cache or fresh fetch)
        let rawTokens: TransformedToken[]

        if (tokenCache.tokens.size > 0 && currentTime < tokenCache.expiresAt && !needsFullRefresh && !skipCache) {
            // Use cached data
            rawTokens = Array.from(tokenCache.tokens.values())
        } else {
            // Fetch fresh data using the main route's logic
            rawTokens = await fetchAndUpdateCache(needsFullRefresh, currentTime, false)
        }

        // Apply TrendingTokens-specific filters
        const filteredTokens = rawTokens.filter(token =>
            token.change_5m > -0.4 &&           // Not dropping more than 40% in 5 minutes
            token.organic_score >= 70.0 &&      // High organic score
            token.mcap > 300000 &&              // Market cap above $300K
            token.mcap < 2000000                 // Market cap below $2M
        )

        // Sort tokens by criteria - prioritize tokens with highest organic score and recent price change
        const sortedTokens = filteredTokens.sort((a, b) => {
            // First by organic score (descending)
            if (b.organic_score !== a.organic_score) {
                return b.organic_score - a.organic_score
            }
            // Then by absolute price change in the last hour (descending)
            return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0)
        })

        return NextResponse.json(
            {
                tokens: sortedTokens,
                cached: currentTime < tokenCache.expiresAt,
                cache_age: Math.round((currentTime - tokenCache.timestamp) / 1000),
                expires_in: Math.round((tokenCache.expiresAt - currentTime) / 1000),
                filtered: true,
                filter_criteria: {
                    min_change_5m: -0.4,
                    max_change_1h: 0.5,
                    min_organic_score: 70.0,
                    min_mcap: 350000,
                    max_mcap: 2000000
                },
                total_before_filter: rawTokens.length,
                total_after_filter: sortedTokens.length
            },
            {
                status: 200,
                headers: {
                    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
                }
            }
        )
    } catch (error) {
        console.error('Error in filtered trending endpoint:', error)
        return NextResponse.json(
            {
                error: 'Failed to fetch filtered trending tokens',
                message: error instanceof Error ? error.message : 'Unknown error'
            },
            { status: 500 }
        )
    }
}