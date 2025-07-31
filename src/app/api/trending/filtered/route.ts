import { NextRequest, NextResponse } from 'next/server'
import { withUnifiedLogging, log } from '@/utils/unified-logger'

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'

// Import the interfaces and cache from the main trending route
import type { TransformedToken } from '../route'
import { tokenCache, fetchAndUpdateCache } from '../route'

// Enhanced GET handler with unified logging
export const GET = withUnifiedLogging(async (request: NextRequest, logger) => {
    const startTime = logger.startTimer()

    try {
        logger.info('api_request', 'Starting filtered trending tokens request')

        const currentTime = Date.now()
        const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
        const FULL_REFRESH_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

        // Parse query parameters with logging
        const { searchParams } = new URL(request.url)
        const forceRefresh = searchParams.get('refresh') === 'true'
        const skipCache = searchParams.get('nocache') === 'true'

        logger.debug('api_request', 'Query parameters parsed', {
            forceRefresh,
            skipCache,
            searchParams: Object.fromEntries(searchParams.entries())
        })

        const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS || forceRefresh

        // Log cache status
        const cacheAge = Math.round((currentTime - tokenCache.timestamp) / 1000)
        const expiresIn = Math.round((tokenCache.expiresAt - currentTime) / 1000)

        logger.info('api_request', 'Cache status evaluated', {
            cacheSize: tokenCache.tokens.size,
            cacheAge,
            expiresIn,
            needsFullRefresh,
            skipCache
        })

        // Get the raw token data (either from cache or fresh fetch)
        let rawTokens: TransformedToken[]
        const fetchStartTime = logger.startTimer()

        if (tokenCache.tokens.size > 0 && currentTime < tokenCache.expiresAt && !needsFullRefresh && !skipCache) {
            // Use cached data
            rawTokens = Array.from(tokenCache.tokens.values())
            logger.info('token_detection', 'Using cached token data', {
                tokenCount: rawTokens.length,
                cacheAge
            })
        } else {
            // Fetch fresh data using the main route's logic
            logger.info('token_detection', 'Fetching fresh token data', {
                needsFullRefresh,
                reason: needsFullRefresh ? 'full_refresh_needed' : skipCache ? 'cache_skipped' : 'cache_expired'
            })

            rawTokens = await fetchAndUpdateCache(needsFullRefresh, currentTime, false)

            logger.logPerformance('token_detection', fetchStartTime, 'Token data fetch completed', {
                tokenCount: rawTokens.length,
                refreshType: needsFullRefresh ? 'full' : 'partial'
            })
        }

        // Apply TrendingTokens-specific filters with detailed logging
        const filterStartTime = logger.startTimer()
        const filterCriteria = {
            min_change_5m: -0.4,
            min_organic_score: 70.0,
            min_mcap: 300000,
            max_mcap: 2000000
        }

        logger.debug('token_detection', 'Applying filter criteria', filterCriteria)

        const filteredTokens = rawTokens.filter(token => {
            const passes = token.change_5m > filterCriteria.min_change_5m &&
                token.organic_score >= filterCriteria.min_organic_score &&
                token.mcap > filterCriteria.min_mcap &&
                token.mcap < filterCriteria.max_mcap

            if (!passes) {
                logger.debug('token_detection', `Token ${token.token_symbol} filtered out`, {
                    change_5m: token.change_5m,
                    organic_score: token.organic_score,
                    mcap: token.mcap,
                    reason: token.change_5m <= filterCriteria.min_change_5m ? 'price_drop' :
                        token.organic_score < filterCriteria.min_organic_score ? 'low_organic_score' :
                            token.mcap <= filterCriteria.min_mcap ? 'mcap_too_low' : 'mcap_too_high'
                })
            }

            return passes
        })

        logger.logPerformance('token_detection', filterStartTime, 'Token filtering completed', {
            totalBefore: rawTokens.length,
            totalAfter: filteredTokens.length,
            filterRate: Math.round((filteredTokens.length / rawTokens.length) * 100)
        })

        // Sort tokens by criteria with logging
        const sortStartTime = logger.startTimer()
        const sortedTokens = filteredTokens.sort((a, b) => {
            // First by organic score (descending)
            if (b.organic_score !== a.organic_score) {
                return b.organic_score - a.organic_score
            }
            // Then by absolute price change in the last hour (descending)
            return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0)
        })

        logger.logPerformance('token_detection', sortStartTime, 'Token sorting completed', {
            sortedCount: sortedTokens.length
        })

        // Log top tokens for monitoring
        if (sortedTokens.length > 0) {
            const topTokens = sortedTokens.slice(0, 3).map(token => ({
                symbol: token.token_symbol,
                organic_score: token.organic_score,
                change_5m: token.change_5m,
                change_1h: token.change_1h,
                mcap: token.mcap
            }))

            logger.info('token_detection', 'Top filtered tokens identified', {
                topTokens,
                totalFiltered: sortedTokens.length
            })
        }

        // Prepare response data
        const responseData = {
            tokens: sortedTokens,
            cached: currentTime < tokenCache.expiresAt,
            cache_age: cacheAge,
            expires_in: expiresIn,
            filtered: true,
            filter_criteria: filterCriteria,
            total_before_filter: rawTokens.length,
            total_after_filter: sortedTokens.length
        }

        logger.logPerformance('api_request', startTime, 'Filtered trending request completed successfully', {
            tokensReturned: sortedTokens.length,
            filterEfficiency: Math.round((sortedTokens.length / rawTokens.length) * 100),
            cacheHit: currentTime < tokenCache.expiresAt && !needsFullRefresh && !skipCache
        })

        return NextResponse.json(
            responseData,
            {
                status: 200,
                headers: {
                    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
                }
            }
        )
    } catch (error) {
        const duration = Date.now() - startTime

        logger.error('api_request', `Filtered trending endpoint failed after ${duration}ms`, error as Error, {
            endpoint: '/api/trending/filtered',
            duration,
            cacheStatus: {
                size: tokenCache.tokens.size,
                age: Math.round((Date.now() - tokenCache.timestamp) / 1000)
            }
        })

        // Log additional context for debugging
        if (error instanceof Error) {
            logger.critical('error_handling', 'Critical error in filtered trending endpoint', error, {
                errorType: error.constructor.name,
                stack: error.stack?.split('\n').slice(0, 5) // First 5 lines of stack
            })
        }

        return NextResponse.json(
            {
                error: 'Failed to fetch filtered trending tokens',
                message: error instanceof Error ? error.message : 'Unknown error',
                requestId: logger.getRequestId()
            },
            { status: 500 }
        )
    }
})