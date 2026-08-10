import { NextRequest, NextResponse } from 'next/server';
import { withUnifiedLogging } from '@/utils/unified-logger';
import { dataAggregationService } from '@/utils/data-aggregation';
import { ZScoreAnomalyDetector } from '@/utils/algo/anomaly-detection';
import { EnhancedMomentumAnalyzer } from '@/utils/algo/momentum-analysis';
import CorrelationAnalyzer from '@/utils/algo/correlation-analysis';
import { LiquidityFilter } from '@/utils/algo/liquidity-analysis';
import type { TokenMetrics } from '@/utils/algo/anomaly-detection';

// Force dynamic rendering for this route

interface AnalyticsRequest {
    tokens?: string[]; // Optional array of token addresses to analyze
    timeframe?: '1h' | '4h' | '24h' | '7d'; // Analysis timeframe
    includeCorrelation?: boolean;
    includeLiquidity?: boolean;
}

interface AnomalyResult {
    address: string;
    symbol?: string;
    zScore: {
        score: number;
        isAnomaly: boolean;
        confidence: number;
    };
    momentum: {
        ema12: number;
        ema26: number;
        macd: number;
        signal: number;
        histogram: number;
        breakoutDetected: boolean;
        strength: number;
    };
    correlation?: {
        solCorrelation: number;
        beta: number;
        independenceScore: number;
    };
    liquidity?: {
        isLegitimate: boolean;
        score: number;
    };
    timestamp: number;
}

interface AnalyticsResponse {
    success: boolean;
    data?: {
        anomalies: AnomalyResult[];
        summary: {
            totalAnalyzed: number;
            anomaliesDetected: number;
            highConfidenceAnomalies: number;
            averageZScore: number;
            strongMomentumCount: number;
        };
        metadata: {
            timeframe: string;
            analysisTimestamp: number;
            processingTimeMs: number;
        };
    };
    error?: string;
}

export const GET = withUnifiedLogging(async (request: NextRequest, logger) => {
    const startTime = Date.now();

    try {
        const { searchParams } = new URL(request.url);
        const timeframe = (searchParams.get('timeframe') as '1h' | '4h' | '24h' | '7d') || '24h';
        const includeCorrelation = searchParams.get('includeCorrelation') === 'true';
        const includeLiquidity = searchParams.get('includeLiquidity') === 'true';

        logger.info('api_request', 'Analytics anomalies request', { timeframe, includeCorrelation, includeLiquidity });

        // Initialize analyzers
        const zScoreDetector = new ZScoreAnomalyDetector();
        const momentumAnalyzer = new EnhancedMomentumAnalyzer();
        const correlationAnalyzer = includeCorrelation ? new CorrelationAnalyzer() : null;
        const liquidityFilter = includeLiquidity ? new LiquidityFilter() : null;

        // Get aggregated token data with analytics
        const aggregationResult = await dataAggregationService.aggregateTokenData({
            includeAnalytics: true,
            maxAge: timeframe === '1h' ? 60 : timeframe === '4h' ? 240 : timeframe === '24h' ? 1440 : 10080
        });

        if (!aggregationResult.tokens || aggregationResult.tokens.length === 0) {
            return NextResponse.json({
                success: false,
                error: 'No token data available for analysis'
            } as AnalyticsResponse, { status: 404 });
        }

        // Convert enriched token data to TokenMetrics format for analysis
        const tokenMetrics: TokenMetrics[] = aggregationResult.tokens.map(token => ({
            address: token.token_address,
            marketCap: token.current_mcap,
            volume24h: token.volume_24h || 0,
            timestamp: new Date(token.last_updated_at).getTime(),
            priceChange24h: token.price_change_24h || 0
        }));

        // Perform analysis
        const anomalies: AnomalyResult[] = [];

        for (const tokenData of tokenMetrics) {
            try {
                // Z-Score Analysis using existing method
                const zScoreResults = await zScoreDetector.detectAnomalies([tokenData]);
                const zScoreData = zScoreResults.get(tokenData.address);
                const zScore = {
                    score: zScoreData?.zScore || 0,
                    isAnomaly: Math.abs(zScoreData?.zScore || 0) > 2.5,
                    confidence: Math.min(Math.abs(zScoreData?.zScore || 0) / 3, 1)
                };

                // Momentum Analysis - use MCap tracking data format
                const mcapTrackingData = aggregationResult.tokens
                    .filter(t => t.token_address === tokenData.address)
                    .map(t => ({
                        token_address: t.token_address,
                        token_symbol: t.token_symbol,
                        current_mcap: t.current_mcap,
                        first_mcap: t.first_mcap,
                        mcap_growth_percent: t.mcap_growth_percent,
                        first_seen_at: t.first_seen_at,
                        last_updated_at: t.last_updated_at
                    }));

                const momentumSignals = momentumAnalyzer.detectMomentumSignals(mcapTrackingData);
                const tokenMomentumSignal = momentumSignals.find(s => s.token_address === tokenData.address);

                const momentum = {
                    ema12: 0, // These would need historical price data to calculate properly
                    ema26: 0,
                    macd: 0,
                    signal: 0,
                    histogram: 0,
                    breakoutDetected: tokenMomentumSignal?.signal_type.includes('breakout') || false,
                    strength: tokenMomentumSignal?.strength || 0
                };

                // Correlation Analysis (optional)
                let correlation;
                if (correlationAnalyzer) {
                    // This would need SOL price history - simplified for now
                    correlation = {
                        solCorrelation: 0,
                        beta: 1,
                        independenceScore: 1
                    };
                }

                // Liquidity Analysis (optional)
                let liquidity;
                if (liquidityFilter) {
                    // This would need actual liquidity metrics - simplified for now
                    liquidity = {
                        isLegitimate: true,
                        score: 0.5
                    };
                }

                anomalies.push({
                    address: tokenData.address,
                    symbol: aggregationResult.tokens.find(t => t.token_address === tokenData.address)?.token_symbol,
                    zScore,
                    momentum,
                    correlation,
                    liquidity,
                    timestamp: Date.now()
                });

            } catch (tokenError) {
                logger.error('error_handling', 'Error analyzing token', tokenError instanceof Error ? tokenError : undefined, {
                    address: tokenData.address,
                    error: tokenError instanceof Error ? tokenError.message : 'Unknown error'
                });
            }
        }

        // Calculate summary statistics
        const anomaliesDetected = anomalies.filter(a => a.zScore.isAnomaly).length;
        const highConfidenceAnomalies = anomalies.filter(a => a.zScore.confidence > 0.8).length;
        const averageZScore = anomalies.length > 0 ?
            anomalies.reduce((sum, a) => sum + Math.abs(a.zScore.score), 0) / anomalies.length : 0;
        const strongMomentumCount = anomalies.filter(a => a.momentum.breakoutDetected).length;

        const processingTime = Date.now() - startTime;

        const response: AnalyticsResponse = {
            success: true,
            data: {
                anomalies: anomalies.sort((a, b) => Math.abs(b.zScore.score) - Math.abs(a.zScore.score)),
                summary: {
                    totalAnalyzed: anomalies.length,
                    anomaliesDetected,
                    highConfidenceAnomalies,
                    averageZScore: Number(averageZScore.toFixed(3)),
                    strongMomentumCount
                },
                metadata: {
                    timeframe,
                    analysisTimestamp: Date.now(),
                    processingTimeMs: processingTime
                }
            }
        };

        logger.info('api_request', 'Analytics completed', {
            totalAnalyzed: anomalies.length,
            anomaliesDetected,
            processingTime
        });

        return NextResponse.json(response);

    } catch (error) {
        logger.error('error_handling', 'Analytics request failed', error instanceof Error ? error : undefined, { error });
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error'
        } as AnalyticsResponse, { status: 500 });
    }
});

export const POST = withUnifiedLogging(async (request: NextRequest, logger) => {
    const startTime = Date.now();

    try {
        const body: AnalyticsRequest = await request.json();
        const { tokens = [], timeframe = '24h', includeCorrelation = false, includeLiquidity = false } = body;

        logger.info('api_request', 'Analytics anomalies POST request', {
            tokenCount: tokens.length,
            timeframe,
            includeCorrelation,
            includeLiquidity
        });

        // Initialize analyzers
        const zScoreDetector = new ZScoreAnomalyDetector();
        const momentumAnalyzer = new EnhancedMomentumAnalyzer();
        const correlationAnalyzer = includeCorrelation ? new CorrelationAnalyzer() : null;
        const liquidityFilter = includeLiquidity ? new LiquidityFilter() : null;

        // Get token data
        const aggregationResult = await dataAggregationService.aggregateTokenData({
            includeAnalytics: true,
            maxAge: timeframe === '1h' ? 60 : timeframe === '4h' ? 240 : timeframe === '24h' ? 1440 : 10080
        });

        let tokenData = aggregationResult.tokens;

        // Filter by specific tokens if provided
        if (tokens.length > 0) {
            tokenData = tokenData.filter(token => tokens.includes(token.token_address));
        }

        if (!tokenData || tokenData.length === 0) {
            return NextResponse.json({
                success: false,
                error: 'No token data available for analysis'
            } as AnalyticsResponse, { status: 404 });
        }

        // Convert to TokenMetrics format and perform batch analysis
        const tokenMetrics: TokenMetrics[] = tokenData.map(token => ({
            address: token.token_address,
            marketCap: token.current_mcap,
            volume24h: token.volume_24h || 0,
            timestamp: new Date(token.last_updated_at).getTime(),
            priceChange24h: token.price_change_24h || 0
        }));

        // Perform batch analysis similar to GET method
        const anomalies: AnomalyResult[] = [];

        // Process in batches for better performance
        const batchSize = 10;
        for (let i = 0; i < tokenMetrics.length; i += batchSize) {
            const batch = tokenMetrics.slice(i, i + batchSize);

            const batchPromises = batch.map(async (tokenMetric) => {
                try {
                    // Similar analysis logic as GET method
                    const zScoreResults = await zScoreDetector.detectAnomalies([tokenMetric]);
                    const zScoreData = zScoreResults.get(tokenMetric.address);

                    const zScore = {
                        score: zScoreData?.zScore || 0,
                        isAnomaly: Math.abs(zScoreData?.zScore || 0) > 2.5,
                        confidence: Math.min(Math.abs(zScoreData?.zScore || 0) / 3, 1)
                    };

                    // Simplified momentum analysis
                    const momentum = {
                        ema12: 0,
                        ema26: 0,
                        macd: 0,
                        signal: 0,
                        histogram: 0,
                        breakoutDetected: false,
                        strength: 0
                    };

                    return {
                        address: tokenMetric.address,
                        symbol: tokenData.find(t => t.token_address === tokenMetric.address)?.token_symbol,
                        zScore,
                        momentum,
                        correlation: correlationAnalyzer ? { solCorrelation: 0, beta: 1, independenceScore: 1 } : undefined,
                        liquidity: liquidityFilter ? { isLegitimate: true, score: 0.5 } : undefined,
                        timestamp: Date.now()
                    };
                } catch (error) {
                    logger.error('error_handling', 'Error in batch analysis', error instanceof Error ? error : undefined, { 
                        address: tokenMetric.address, 
                        error: error instanceof Error ? error.message : 'Unknown error'
                    });
                }
            });

            const batchResults = await Promise.all(batchPromises);
            anomalies.push(...batchResults.filter(result => result !== null) as AnomalyResult[]);
        }

        // Calculate summary statistics
        const anomaliesDetected = anomalies.filter(a => a.zScore.isAnomaly).length;
        const highConfidenceAnomalies = anomalies.filter(a => a.zScore.confidence > 0.8).length;
        const averageZScore = anomalies.length > 0 ?
            anomalies.reduce((sum, a) => sum + Math.abs(a.zScore.score), 0) / anomalies.length : 0;
        const strongMomentumCount = anomalies.filter(a => a.momentum.breakoutDetected).length;

        const processingTime = Date.now() - startTime;

        const response: AnalyticsResponse = {
            success: true,
            data: {
                anomalies: anomalies.sort((a, b) => Math.abs(b.zScore.score) - Math.abs(a.zScore.score)),
                summary: {
                    totalAnalyzed: anomalies.length,
                    anomaliesDetected,
                    highConfidenceAnomalies,
                    averageZScore: Number(averageZScore.toFixed(3)),
                    strongMomentumCount
                },
                metadata: {
                    timeframe,
                    analysisTimestamp: Date.now(),
                    processingTimeMs: processingTime
                }
            }
        };

        logger.info('api_request', 'POST Analytics completed', {
            totalAnalyzed: anomalies.length,
            anomaliesDetected,
            processingTime
        });

        return NextResponse.json(response);

    } catch (error) {
        logger.error('error_handling', 'POST Analytics request failed', error instanceof Error ? error : undefined, { error });
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error'
        } as AnalyticsResponse, { status: 500 });
    }
});