import { supabase } from '@/utils/supabase'
import { McapSnapshot } from '@/utils/mcap-tracker'
import { ZScoreAnomalyDetector, TokenMetrics } from '@/utils/algo/anomaly-detection'
import { EnhancedMomentumAnalyzer } from '@/utils/algo/momentum-analysis'

// Import Jupiter price utilities with better error handling
let jupiterAPI: any = null;
try {
    const jupiterModule = require('@/utils/jupiter');
    if (jupiterModule.JupiterAPIManager) {
        jupiterAPI = new jupiterModule.JupiterAPIManager();
    }
} catch (error) {
    console.warn('Jupiter API not available', { error });
}

export interface EnrichedTokenData {
    // Base MCap tracking data
    token_address: string
    token_symbol: string
    first_mcap: number
    current_mcap: number
    mcap_growth_percent: number
    first_seen_at: string
    last_updated_at: string

    // Real-time price data from Jupiter
    current_price_usd: number
    price_change_24h?: number
    volume_24h?: number

    // Analytics data
    z_score?: number
    anomaly_type?: 'positive' | 'negative' | 'neutral'
    momentum_signal?: {
        type: 'bullish_breakout' | 'bearish_breakout' | 'neutral'
        strength: number
        confidence: number
        timestamp: string
    }
    momentum_category?: 'explosive' | 'strong' | 'moderate' | 'weak' | 'negative'

    // Derived metrics
    price_mcap_ratio?: number
    liquidity_score?: number
    risk_score?: number
}

export interface AggregationOptions {
    includeAnalytics?: boolean
    includePriceHistory?: boolean
    maxAge?: number // Maximum age of data in minutes
    batchSize?: number
}

export interface AggregationResult {
    tokens: EnrichedTokenData[]
    analytics: {
        totalTokens: number
        anomaliesDetected: number
        momentumSignals: number
        avgZScore: number
        priceDataCoverage: number // Percentage of tokens with price data
    }
    metadata: {
        lastUpdated: string
        dataFreshness: number // Average age of data in minutes
        jupiterApiStatus: 'healthy' | 'degraded' | 'unavailable'
    }
}

class DataAggregationService {
    private cache = new Map<string, { data: EnrichedTokenData; timestamp: number }>()
    private readonly CACHE_TTL = 2 * 60 * 1000 // 2 minutes
    private readonly BATCH_SIZE = 100
    private zScoreDetector: ZScoreAnomalyDetector
    private momentumAnalyzer: EnhancedMomentumAnalyzer

    constructor() {
        this.zScoreDetector = new ZScoreAnomalyDetector()
        this.momentumAnalyzer = new EnhancedMomentumAnalyzer()
    }

    /**
     * Main aggregation method - combines MCap tracking with Jupiter price feeds
     */
    async aggregateTokenData(options: AggregationOptions = {}): Promise<AggregationResult> {
        const startTime = Date.now()

        try {
            console.info('Starting token data aggregation', { options });

            // 1. Fetch MCap tracking data
            const mcapData = await this.fetchMcapTrackingData(options.maxAge)

            // 2. Extract unique token addresses
            const tokenAddresses = mcapData.map(token => token.token_address)

            // 3. Fetch Jupiter price data in batches
            const priceData = await this.fetchJupiterPriceData(tokenAddresses)

            // 4. Combine data and enrich with analytics
            const enrichedTokens = await this.enrichTokenData(mcapData, priceData, options)

            // 5. Generate analytics summary
            const analytics = this.generateAnalyticsSummary(enrichedTokens)

            // 6. Create metadata
            const metadata = {
                lastUpdated: new Date().toISOString(),
                dataFreshness: this.calculateDataFreshness(enrichedTokens),
                jupiterApiStatus: await this.checkJupiterApiHealth()
            }

            const result: AggregationResult = {
                tokens: enrichedTokens,
                analytics,
                metadata
            }

            console.info('Aggregation completed', {
                tokensProcessed: enrichedTokens.length,
                executionTime: Date.now() - startTime,
                priceDataCoverage: analytics.priceDataCoverage
            });

            return result;

        } catch (error) {
            console.error('Aggregation failed', { error, options });
            throw new Error(`Data aggregation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Fetch MCap tracking data from Supabase
     */
    private async fetchMcapTrackingData(maxAge?: number): Promise<McapSnapshot[]> {
        let query = supabase
            .from('token_mcap_tracking')
            .select('*')
            .order('last_updated_at', { ascending: false })

        // Apply age filter if specified
        if (maxAge) {
            const cutoffTime = new Date(Date.now() - maxAge * 60 * 1000).toISOString()
            query = query.gte('last_updated_at', cutoffTime)
        }

        const { data, error } = await query

        if (error) {
            throw new Error(`Failed to fetch MCap data: ${error.message}`)
        }

        return data || []
    }

    /**
     * Fetch Jupiter price data for token addresses
     */
    private async fetchJupiterPriceData(tokenAddresses: string[]): Promise<Record<string, { price: number; volume24h?: number }>> {
        if (!jupiterAPI || tokenAddresses.length === 0) {
            return {}
        }

        try {
            // Use existing Jupiter API manager for efficient batch fetching
            const priceResult = await jupiterAPI.fetchTokenPrices(tokenAddresses, {
                timeout: 15000,
                retries: 2
            })

            // Transform to our expected format
            const priceData: Record<string, { price: number; volume24h?: number }> = {}

            Object.entries(priceResult).forEach(([address, data]: [string, any]) => {
                if (data && typeof data.price === 'number') {
                    priceData[address] = {
                        price: data.price,
                        volume24h: data.volume24h || undefined
                    };
                }
            });

            return priceData;
        } catch (error) {
            console.warn('Jupiter price fetch failed', { error, tokenCount: tokenAddresses.length });
            return {};
        }
    }

    /**
     * Enrich MCap data with price data and analytics
     */
    private async enrichTokenData(
        mcapData: McapSnapshot[],
        priceData: Record<string, { price: number; volume24h?: number }>,
        options: AggregationOptions
    ): Promise<EnrichedTokenData[]> {
        const enrichedTokens: EnrichedTokenData[] = []

        // Prepare analytics if requested
        let zScoreResults: Map<string, { zScore: number; anomalyType: 'positive' | 'negative' | 'neutral' }> | undefined
        let momentumResults: Map<string, any> | undefined

        if (options.includeAnalytics) {
            try {
                // Convert MCap data for analytics
                const analyticsData: TokenMetrics[] = mcapData.map(token => ({
                    address: token.token_address,
                    marketCap: token.current_mcap,
                    volume24h: priceData[token.token_address]?.volume24h || 0,
                    timestamp: new Date(token.last_updated_at).getTime(),
                    priceChange24h: 0 // Would need historical data
                }))

                // Run analytics
                zScoreResults = await this.zScoreDetector.detectAnomalies(analyticsData);
                const momentumAnalysis = await this.momentumAnalyzer.analyzeMcapMomentum(mcapData);

                // Convert momentum analysis to Map format
                momentumResults = new Map();
                mcapData.forEach(token => {
                    const category = this.categorizeMomentum(token.mcap_growth_percent);
                    momentumResults!.set(token.token_address, {
                        category,
                        signal: {
                            type: 'neutral' as const,
                            strength: 0,
                            confidence: 0,
                            timestamp: token.last_updated_at
                        }
                    });
                });
            } catch (error) {
                console.warn('Analytics processing failed', { error });
            }
        }

        // Enrich each token
        for (const token of mcapData) {
            const price = priceData[token.token_address]
            const zScore = zScoreResults?.get(token.token_address)
            const momentum = momentumResults?.get(token.token_address)

            const enrichedToken: EnrichedTokenData = {
                // Base MCap data
                ...token,

                // Price data
                current_price_usd: price?.price || 0,
                volume_24h: price?.volume24h,

                // Analytics data
                z_score: zScore?.zScore,
                anomaly_type: zScore?.anomalyType,
                momentum_signal: momentum?.signal,
                momentum_category: momentum?.category,

                // Derived metrics
                price_mcap_ratio: price?.price ? token.current_mcap / price.price : undefined,
                liquidity_score: this.calculateLiquidityScore(token.current_mcap, price?.volume24h),
                risk_score: this.calculateRiskScore(token, zScore, momentum)
            }

            enrichedTokens.push(enrichedToken)
        }

        return enrichedTokens
    }

    /**
     * Categorize momentum based on growth percentage
     */
    private categorizeMomentum(growthPercent: number): 'explosive' | 'strong' | 'moderate' | 'weak' | 'negative' {
        if (growthPercent >= 1000) return 'explosive';
        if (growthPercent >= 500) return 'strong';
        if (growthPercent >= 100) return 'moderate';
        if (growthPercent >= 0) return 'weak';
        return 'negative';
    }

    /**
     * Generate analytics summary
     */
    private generateAnalyticsSummary(tokens: EnrichedTokenData[]) {
        const totalTokens = tokens.length
        const tokensWithPrice = tokens.filter(t => t.current_price_usd > 0).length
        const anomalies = tokens.filter(t => t.anomaly_type && t.anomaly_type !== 'neutral').length
        const momentumSignals = tokens.filter(t => t.momentum_signal && t.momentum_signal.type !== 'neutral').length

        const zScores = tokens.map(t => t.z_score).filter(z => z !== undefined) as number[]
        const avgZScore = zScores.length > 0 ? zScores.reduce((a, b) => a + b, 0) / zScores.length : 0

        return {
            totalTokens,
            anomaliesDetected: anomalies,
            momentumSignals,
            avgZScore,
            priceDataCoverage: totalTokens > 0 ? (tokensWithPrice / totalTokens) * 100 : 0
        }
    }

    /**
     * Calculate average data freshness
     */
    private calculateDataFreshness(tokens: EnrichedTokenData[]): number {
        if (tokens.length === 0) return 0

        const now = Date.now()
        const ages = tokens.map(token => {
            const lastUpdate = new Date(token.last_updated_at).getTime()
            return (now - lastUpdate) / (1000 * 60) // Convert to minutes
        })

        return ages.reduce((a, b) => a + b, 0) / ages.length
    }

    /**
     * Check Jupiter API health
     */
    private async checkJupiterApiHealth(): Promise<'healthy' | 'degraded' | 'unavailable'> {
        if (!jupiterAPI) return 'unavailable'

        try {
            // Test with a known token (SOL)
            const testResult = await jupiterAPI.fetchTokenPrices(['So11111111111111111111111111111111111111112'], {
                timeout: 5000,
                retries: 1
            })

            return Object.keys(testResult).length > 0 ? 'healthy' : 'degraded'
        } catch {
            return 'degraded'
        }
    }

    /**
     * Calculate liquidity score based on market cap and volume
     */
    private calculateLiquidityScore(marketCap: number, volume24h?: number): number {
        if (!volume24h || volume24h === 0) return 0

        // Volume to market cap ratio as a liquidity indicator
        const ratio = volume24h / marketCap

        // Normalize to 0-100 scale
        return Math.min(100, ratio * 1000)
    }

    /**
     * Calculate risk score based on various factors
     */
    private calculateRiskScore(
        token: McapSnapshot,
        zScore?: { zScore: number; anomalyType: string },
        momentum?: any
    ): number {
        let riskScore = 50 // Base risk score

        // Adjust based on growth rate
        if (token.mcap_growth_percent > 1000) riskScore += 30 // Very high growth = higher risk
        else if (token.mcap_growth_percent > 500) riskScore += 20
        else if (token.mcap_growth_percent > 200) riskScore += 10
        else if (token.mcap_growth_percent < 0) riskScore += 15 // Negative growth = risk

        // Adjust based on Z-score anomalies
        if (zScore) {
            if (Math.abs(zScore.zScore) > 3) riskScore += 25 // Extreme anomaly
            else if (Math.abs(zScore.zScore) > 2) riskScore += 15
        }

        // Adjust based on momentum
        if (momentum?.category === 'explosive') riskScore += 20
        else if (momentum?.category === 'negative') riskScore += 10

        return Math.min(100, Math.max(0, riskScore))
    }

    /**
     * Get cached token data
     */
    getCachedTokenData(tokenAddress: string): EnrichedTokenData | null {
        const cached = this.cache.get(tokenAddress)
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            return cached.data
        }
        return null
    }

    /**
     * Clear expired cache entries
     */
    cleanup(): void {
        const now = Date.now()
        for (const [key, value] of Array.from(this.cache.entries())) {
            if (now - value.timestamp > this.CACHE_TTL) {
                this.cache.delete(key)
            }
        }
    }
}

// Export singleton instance
export const dataAggregationService = new DataAggregationService()

// Cleanup cache every 5 minutes
setInterval(() => dataAggregationService.cleanup(), 5 * 60 * 1000)

// Convenience functions
export async function getEnrichedTokenData(options?: AggregationOptions): Promise<AggregationResult> {
    return dataAggregationService.aggregateTokenData(options)
}

export async function getTokenWithAnalytics(tokenAddress: string): Promise<EnrichedTokenData | null> {
    const cached = dataAggregationService.getCachedTokenData(tokenAddress)
    if (cached) return cached

    const result = await dataAggregationService.aggregateTokenData({
        includeAnalytics: true,
        maxAge: 60 // Only recent data
    })

    return result.tokens.find(token => token.token_address === tokenAddress) || null
}