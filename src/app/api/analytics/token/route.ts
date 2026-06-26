import { NextRequest, NextResponse } from 'next/server';
import { withUnifiedLogging } from '@/utils/unified-logger';
import { supabase } from '@/utils/supabase';
import { ZScoreAnomalyDetector } from '@/utils/algo/anomaly-detection';
import { EnhancedMomentumAnalyzer } from '@/utils/algo/momentum-analysis';
import type { EnrichedTokenData } from '@/utils/data-aggregation';

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic';

interface TokenAnalyticsRequest {
    tokenAddresses: string[];
    maxAge?: number; // Maximum age of data in minutes
}

interface TokenAnalyticsResponse {
    success: boolean;
    data?: EnrichedTokenData[];
    error?: string;
}

// Initialize analyzers
const zScoreDetector = new ZScoreAnomalyDetector();
const momentumAnalyzer = new EnhancedMomentumAnalyzer();

// Jupiter API setup with better error handling
let jupiterAPI: any = null;
try {
    if (typeof window === 'undefined') {
        // Use dynamic import instead of require for better error handling
        jupiterAPI = true; // We'll use fetch API directly
    }
} catch (error) {
    console.warn('Jupiter API setup warning:', error instanceof Error ? error.message : 'Unknown error');
}

// Helper function to safely get error message
function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'Unknown error occurred';
}

// Helper function to validate token addresses
function validateTokenAddresses(addresses: unknown): addresses is string[] {
    return Array.isArray(addresses) &&
        addresses.length > 0 &&
        addresses.every(addr => typeof addr === 'string' && addr.length > 0);
}

export const POST = withUnifiedLogging(async (request: NextRequest, logger) => {
    const startTime = Date.now();

    try {
        let body: TokenAnalyticsRequest;

        try {
            body = await request.json();
        } catch (parseError) {
            logger.error('api_request', 'Failed to parse request body', parseError instanceof Error ? parseError : undefined, {
                error: getErrorMessage(parseError)
            });
            return NextResponse.json({
                success: false,
                error: 'Invalid JSON in request body'
            } as TokenAnalyticsResponse, { status: 400 });
        }

        const { tokenAddresses, maxAge = 60 } = body;

        // Validate input
        if (!validateTokenAddresses(tokenAddresses)) {
            logger.warn('api_request', 'Invalid token addresses provided', {
                providedAddresses: tokenAddresses,
                type: typeof tokenAddresses
            });
            return NextResponse.json({
                success: false,
                error: 'Token addresses must be a non-empty array of strings'
            } as TokenAnalyticsResponse, { status: 400 });
        }

        if (tokenAddresses.length > 100) {
            logger.warn('api_request', 'Too many token addresses requested', {
                count: tokenAddresses.length,
                limit: 100
            });
            return NextResponse.json({
                success: false,
                error: 'Maximum 100 token addresses allowed per request'
            } as TokenAnalyticsResponse, { status: 400 });
        }

        logger.info('api_request', 'Token analytics request received', {
            tokenCount: tokenAddresses.length,
            maxAge,
            requestId: logger.getRequestId()
        });

        // Fetch MCap tracking data from Supabase (server-side)
        let mcapData;
        try {
            mcapData = await fetchMcapTrackingData(tokenAddresses, maxAge, logger);
        } catch (fetchError) {
            logger.error('api_request', 'Failed to fetch MCap data', fetchError instanceof Error ? fetchError : undefined, {
                error: getErrorMessage(fetchError),
                tokenCount: tokenAddresses.length
            });
            return NextResponse.json({
                success: false,
                error: 'Failed to fetch market cap data'
            } as TokenAnalyticsResponse, { status: 500 });
        }

        if (mcapData.length === 0) {
            logger.info('api_request', 'No MCap data found for provided tokens', {
                tokenAddresses: tokenAddresses.slice(0, 5), // Log first 5 for debugging
                totalRequested: tokenAddresses.length
            });
            return NextResponse.json({
                success: false,
                error: 'No market cap data found for provided token addresses'
            } as TokenAnalyticsResponse, { status: 404 });
        }

        // Fetch Jupiter price data
        let priceData;
        try {
            priceData = await fetchJupiterPriceData(tokenAddresses, logger);
        } catch (priceError) {
            logger.warn('api_request', 'Failed to fetch price data, continuing without it', {
                error: getErrorMessage(priceError),
                tokenCount: tokenAddresses.length
            });
            priceData = {}; // Continue without price data
        }

        // Enrich token data with analytics
        let enrichedTokens;
        try {
            enrichedTokens = await enrichTokenData(mcapData, priceData, logger);
        } catch (enrichError) {
            logger.error('api_request', 'Failed to enrich token data', enrichError instanceof Error ? enrichError : undefined, {
                error: getErrorMessage(enrichError),
                mcapDataCount: mcapData.length
            });
            return NextResponse.json({
                success: false,
                error: 'Failed to process analytics data'
            } as TokenAnalyticsResponse, { status: 500 });
        }

        const processingTime = Date.now() - startTime;
        logger.info('api_request', 'Token analytics completed successfully', {
            processedTokens: enrichedTokens.length,
            processingTimeMs: processingTime,
            requestId: logger.getRequestId()
        });

        return NextResponse.json({
            success: true,
            data: enrichedTokens
        } as TokenAnalyticsResponse);

    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.error('api_request', 'Token analytics request failed', error instanceof Error ? error : undefined, {
            error: getErrorMessage(error),
            processingTimeMs: processingTime,
            requestId: logger.getRequestId()
        });

        return NextResponse.json({
            success: false,
            error: 'Internal server error occurred'
        } as TokenAnalyticsResponse, { status: 500 });
    }
});

// Server-side MCap data fetching with improved error handling
async function fetchMcapTrackingData(tokenAddresses: string[], maxAge: number, logger: any) {
    try {
        let query = supabase
            .from('token_mcap_tracking')
            .select('*')
            .in('token_address', tokenAddresses)
            .order('last_updated_at', { ascending: false });

        // Apply age filter if specified
        if (maxAge && maxAge > 0) {
            const cutoffTime = new Date(Date.now() - maxAge * 60 * 1000).toISOString();
            query = query.gte('last_updated_at', cutoffTime);
        }

        const { data, error } = await query;

        if (error) {
            logger.error('api_request', 'Supabase query failed', undefined, {
                supabaseError: error.message,
                code: error.code,
                details: error.details
            });
            throw new Error(`Database query failed: ${error.message}`);
        }

        logger.debug('api_request', 'MCap data fetched successfully', {
            recordsFound: data?.length || 0,
            requestedTokens: tokenAddresses.length
        });

        return data || [];
    } catch (error) {
        logger.error('api_request', 'MCap data fetch error', error instanceof Error ? error : undefined, {
            error: getErrorMessage(error)
        });
        throw error;
    }
}

// Jupiter price data fetching with improved error handling
async function fetchJupiterPriceData(
    tokenAddresses: string[],
    logger: any
): Promise<Record<string, { price: number; volume24h?: number }>> {
    if (!jupiterAPI || tokenAddresses.length === 0) {
        logger.debug('api_request', 'Skipping Jupiter price fetch', {
            reason: !jupiterAPI ? 'Jupiter API not available' : 'No token addresses',
            tokenCount: tokenAddresses.length
        });
        return {};
    }

    try {
        const url = `https://price.jup.ag/v4/price?ids=${tokenAddresses.join(',')}`;
        logger.debug('api_request', 'Fetching Jupiter price data', {
            url: url.substring(0, 100) + '...', // Truncate for logging
            tokenCount: tokenAddresses.length
        });

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'TokenAnalytics/1.0'
            },
            // Add timeout
            signal: AbortSignal.timeout(10000) // 10 second timeout
        });

        if (!response.ok) {
            throw new Error(`Jupiter API responded with status ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const priceData: Record<string, { price: number; volume24h?: number }> = {};

        if (data && typeof data === 'object' && 'data' in data) {
            for (const [address, info] of Object.entries(data.data || {})) {
                if (typeof info === 'object' && info !== null && 'price' in info) {
                    const priceInfo = info as any;
                    if (typeof priceInfo.price === 'number' && priceInfo.price > 0) {
                        priceData[address] = {
                            price: priceInfo.price,
                            volume24h: typeof priceInfo.volume24h === 'number' ? priceInfo.volume24h : undefined
                        };
                    }
                }
            }
        }

        logger.debug('api_request', 'Jupiter price data processed', {
            requestedTokens: tokenAddresses.length,
            pricesFound: Object.keys(priceData).length
        });

        return priceData;
    } catch (error) {
        logger.warn('api_request', 'Jupiter price fetch failed', {
            error: getErrorMessage(error),
            tokenCount: tokenAddresses.length
        });
        return {}; // Return empty object instead of throwing
    }
}

// Enrich token data with analytics and improved error handling
async function enrichTokenData(
    mcapData: any[],
    priceData: Record<string, { price: number; volume24h?: number }>,
    logger: any
): Promise<EnrichedTokenData[]> {
    const enrichedTokens: EnrichedTokenData[] = [];
    const errors: string[] = [];

    let zScoreResults = new Map<
        string,
        { zScore: number | null; anomalyType: 'positive' | 'negative' | 'neutral'; zScoreAvailable: boolean }
    >();
    try {
        const cohortMetrics = mcapData
            .filter((token) => token && typeof token === 'object')
            .map((token) => {
                const price = priceData[token.token_address];
                const volume24h = price?.volume24h;
                const priceChange24h =
                    price?.price && token.current_mcap > 0
                        ? ((price.price * token.current_mcap) / 1_000_000 - token.first_mcap) /
                          token.first_mcap *
                          100
                        : 0;
                return {
                    address: token.token_address,
                    marketCap: token.current_mcap || 0,
                    volume24h: volume24h || 0,
                    timestamp: new Date(token.last_updated_at).getTime(),
                    priceChange24h,
                    mcapGrowthPercent: token.mcap_growth_percent || 0,
                };
            });
        zScoreResults = await zScoreDetector.detectAnomalies(cohortMetrics, {
            mode: 'crossSection',
        });
    } catch (zScoreError) {
        logger.warn('api_request', 'Cohort Z-score analysis failed', {
            error: getErrorMessage(zScoreError),
        });
    }

    for (const token of mcapData) {
        try {
            if (!token || typeof token !== 'object') {
                errors.push(`Invalid token data: ${JSON.stringify(token)}`);
                continue;
            }

            const price = priceData[token.token_address];
            const currentPriceUsd = price?.price || 0;
            const volume24h = price?.volume24h;

            const priceChange24h = currentPriceUsd > 0 && token.current_mcap > 0 ?
                ((currentPriceUsd * token.current_mcap / 1000000) - token.first_mcap) / token.first_mcap * 100 : 0;

            const zScoreData = zScoreResults.get(token.token_address);

            // Momentum analysis with error handling
            let momentumSignal;
            try {
                const momentumSignals = momentumAnalyzer.detectMomentumSignals([token]);
                momentumSignal = momentumSignals.find(s => s.token_address === token.token_address);
            } catch (momentumError) {
                logger.warn('api_request', 'Momentum analysis failed for token', {
                    tokenAddress: token.token_address,
                    error: getErrorMessage(momentumError)
                });
                momentumSignal = undefined;
            }

            // Create enriched token data
            const enrichedToken: EnrichedTokenData = {
                // Base MCap tracking data
                token_address: token.token_address,
                token_symbol: token.token_symbol || 'UNKNOWN',
                first_mcap: token.first_mcap || 0,
                current_mcap: token.current_mcap || 0,
                mcap_growth_percent: token.mcap_growth_percent || 0,
                first_seen_at: token.first_seen_at,
                last_updated_at: token.last_updated_at,

                // Real-time price data
                current_price_usd: currentPriceUsd,
                price_change_24h: priceChange24h,
                volume_24h: volume24h,

                // Analytics data
                z_score: zScoreData?.zScoreAvailable ? zScoreData.zScore ?? undefined : undefined,
                z_score_available: zScoreData?.zScoreAvailable ?? false,
                anomaly_type: zScoreData?.anomalyType as 'positive' | 'negative' | 'neutral' | undefined,
                momentum_signal: momentumSignal ? {
                    type: momentumSignal.signal_type as 'bullish_breakout' | 'bearish_breakout' | 'neutral',
                    strength: momentumSignal.strength,
                    confidence: momentumSignal.confidence,
                    timestamp: momentumSignal.timestamp
                } : undefined,
                momentum_category: categorizeMomentum(token.mcap_growth_percent || 0),

                // Additional metrics
                price_mcap_ratio: currentPriceUsd > 0 && token.current_mcap > 0 ?
                    currentPriceUsd / (token.current_mcap / 1000000) : 0,
                liquidity_score: calculateLiquidityScore(token.current_mcap || 0, volume24h),
                risk_score: calculateRiskScore(token, zScoreData, momentumSignal)
            };

            enrichedTokens.push(enrichedToken);
        } catch (tokenError) {
            const errorMsg = `Failed to process token ${token?.token_address || 'unknown'}: ${getErrorMessage(tokenError)}`;
            errors.push(errorMsg);
            logger.warn('api_request', 'Token processing failed', {
                tokenAddress: token?.token_address,
                error: getErrorMessage(tokenError)
            });
        }
    }

    if (errors.length > 0) {
        logger.warn('api_request', 'Some tokens failed to process', {
            totalTokens: mcapData.length,
            successfulTokens: enrichedTokens.length,
            failedTokens: errors.length,
            errors: errors.slice(0, 5) // Log first 5 errors
        });
    }

    return enrichedTokens;
}

// Helper functions with improved error handling
function categorizeMomentum(growthPercent: number): 'explosive' | 'strong' | 'moderate' | 'weak' | 'negative' {
    if (!isFinite(growthPercent)) return 'weak';
    if (growthPercent >= 1000) return 'explosive';
    if (growthPercent >= 500) return 'strong';
    if (growthPercent >= 100) return 'moderate';
    if (growthPercent >= 0) return 'weak';
    return 'negative';
}

function calculateLiquidityScore(marketCap: number, volume24h?: number): number {
    if (!volume24h || volume24h === 0 || !isFinite(volume24h) || !isFinite(marketCap) || marketCap === 0) {
        return 0;
    }

    const volumeToMcapRatio = volume24h / marketCap;
    const normalizedScore = Math.min(volumeToMcapRatio * 100, 100);

    return Math.round(normalizedScore * 100) / 100;
}

function calculateRiskScore(token: any, zScore?: any, momentum?: any): number {
    let riskScore = 50; // Base risk score

    try {
        // Adjust based on market cap (smaller = riskier)
        const mcap = token?.current_mcap || 0;
        if (mcap < 1000000) riskScore += 30;
        else if (mcap < 10000000) riskScore += 20;
        else if (mcap < 100000000) riskScore += 10;

        // Adjust based on Z-score anomaly
        if (zScore && typeof zScore.zScore === 'number' && isFinite(zScore.zScore)) {
            if (Math.abs(zScore.zScore) > 2.5) {
                riskScore += 20;
            }
        }

        // Adjust based on momentum
        if (momentum && typeof momentum.strength === 'number' && isFinite(momentum.strength)) {
            if (momentum.strength > 0.8) {
                riskScore += 15;
            }
        }
    } catch (error) {
        // If calculation fails, return base risk score
        console.warn('Risk score calculation failed:', getErrorMessage(error));
    }

    return Math.min(Math.max(riskScore, 0), 100);
}