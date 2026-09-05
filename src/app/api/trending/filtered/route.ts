import { NextRequest, NextResponse } from 'next/server'
import { withUnifiedLogging, log } from '@/utils/unified-logger'
import { assessTokenRisk, formatDetailedRiskForDiscord, getRiskEmoji } from '@/utils/risk-assessment'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, bulkTrackTokenMcaps } from '@/utils/mcap-tracker'
import {
  acquireTrendingListNotificationSlot,
  trendingListDiscordViaCronOnly,
} from '@/utils/trending-notification-dedup'

// Force dynamic rendering for this route

// Import the interfaces and cache from the main trending route
// import type { TransformedToken } from '../route'
import { TransformedToken } from '@/types'
import { tokenCache, fetchAndUpdateCache } from '../route'
import { attachFirstDetections } from '@/utils/first-detection'

// Environment variable for Discord webhook URL
const DISCORD_WEBHOOK_URL =
    process.env.NODE_ENV === 'development'
        ? process.env.DISCORD_WEBHOOK_URL_DEV || process.env.DISCORD_WEBHOOK_URL
        : process.env.DISCORD_WEBHOOK_URL;
const ENABLE_DISCORD_NOTIFICATIONS = process.env.ENABLE_DISCORD_NOTIFICATIONS === 'true';

// Add auto-notification interval for filtered tokens (default 5 minutes = 300000ms)
const AUTO_NOTIFICATION_INTERVAL_MS = parseInt(process.env.FILTERED_AUTO_NOTIFICATION_INTERVAL_MS || '300000');

// Track last auto notification time for filtered tokens
let lastFilteredAutoNotificationTime = 0;

// Global cleanup tracking for filtered notifications
let filteredGlobalTimers: {
    notificationTimer?: NodeJS.Timeout;
    initialDelayTimer?: NodeJS.Timeout;
} = {};

// Function to initialize the filtered notification timer
function initializeFilteredNotificationTimer() {
    if (trendingListDiscordViaCronOnly()) {
        console.log('Filtered list Discord via Go cron — skipping route notification timer')
        return
    }
    if (typeof process !== 'undefined' && ENABLE_DISCORD_NOTIFICATIONS && !filteredGlobalTimers.notificationTimer) {
        console.log('Initializing automatic filtered notification timer...');

        // Initial delay of 45 seconds after server start before first check
        filteredGlobalTimers.initialDelayTimer = setTimeout(() => {
            console.log('Starting automatic filtered notification timer');

            // Set interval for periodic notifications
            filteredGlobalTimers.notificationTimer = setInterval(() => {
                const currentTime = Date.now();

                // Check if it's time for a notification
                if (currentTime - lastFilteredAutoNotificationTime >= AUTO_NOTIFICATION_INTERVAL_MS) {
                    console.log('Auto-filtered-notification interval triggered');

                    // Trigger filtered notification with proper error handling
                    sendFilteredTokensNotification()
                        .then(() => {
                            console.log('Scheduled filtered notification completed');
                            lastFilteredAutoNotificationTime = currentTime;
                        })
                        .catch(error => {
                            console.error('Error in scheduled filtered notification:', error);
                        });
                }
            }, Math.min(60000, AUTO_NOTIFICATION_INTERVAL_MS / 2)); // Check at least every minute or half the notification interval

            // Clear the initial delay timer reference
            filteredGlobalTimers.initialDelayTimer = undefined;
        }, 45000);
    } else if (filteredGlobalTimers.notificationTimer) {
        console.log('Filtered notification timer is already running.');
    } else {
        console.log('Automatic filtered notifications are disabled.');
    }
}

// Cleanup function for graceful shutdown
function cleanupFilteredGlobalTimers() {
    if (filteredGlobalTimers.notificationTimer) {
        clearInterval(filteredGlobalTimers.notificationTimer);
        filteredGlobalTimers.notificationTimer = undefined;
    }
    if (filteredGlobalTimers.initialDelayTimer) {
        clearTimeout(filteredGlobalTimers.initialDelayTimer);
        filteredGlobalTimers.initialDelayTimer = undefined;
    }
}

// Initialize the filtered timer when the module is loaded
initializeFilteredNotificationTimer();

// Handle process termination gracefully
if (typeof process !== 'undefined') {
    process.on('SIGTERM', cleanupFilteredGlobalTimers);
    process.on('SIGINT', cleanupFilteredGlobalTimers);
    process.on('exit', cleanupFilteredGlobalTimers);
}

// Track previous notification state for comparison
let previousFilteredTokens: Map<string, TransformedToken> = new Map();

// Add Discord message size validation constants (similar to track route)
const DISCORD_MAX_LENGTH = 2000
const DISCORD_SAFE_LENGTH = 1900
const DISCORD_EMBED_MAX_LENGTH = 6000
const DISCORD_FIELD_MAX_LENGTH = 1024
const DISCORD_DESCRIPTION_MAX_LENGTH = 4096

// Add message size validation function
function validateDiscordMessage(message: any): { valid: boolean; issues: string[]; sizes: any } {
    const issues: string[] = []
    const sizes = {
        totalFields: 0,
        fieldSizes: [] as number[],
        descriptionSize: 0,
        totalEmbedSize: 0
    }

    if (message.embeds && message.embeds.length > 0) {
        const embed = message.embeds[0]

        // Check description size
        if (embed.description) {
            sizes.descriptionSize = embed.description.length
            if (embed.description.length > DISCORD_DESCRIPTION_MAX_LENGTH) {
                issues.push(`Description too long: ${embed.description.length}/${DISCORD_DESCRIPTION_MAX_LENGTH}`)
            }
        }

        // Check fields
        if (embed.fields) {
            sizes.totalFields = embed.fields.length
            if (embed.fields.length > 25) {
                issues.push(`Too many fields: ${embed.fields.length}/25`)
            }

            embed.fields.forEach((field: any, index: number) => {
                const fieldSize = (field.name?.length || 0) + (field.value?.length || 0)
                sizes.fieldSizes.push(fieldSize)

                if (field.value && field.value.length > DISCORD_FIELD_MAX_LENGTH) {
                    issues.push(`Field ${index} value too long: ${field.value.length}/${DISCORD_FIELD_MAX_LENGTH}`)
                }
            })
        }

        // Estimate total embed size
        const embedJson = JSON.stringify(embed)
        sizes.totalEmbedSize = embedJson.length
        if (embedJson.length > DISCORD_EMBED_MAX_LENGTH) {
            issues.push(`Total embed too large: ${embedJson.length}/${DISCORD_EMBED_MAX_LENGTH}`)
        }
    }

    return {
        valid: issues.length === 0,
        issues,
        sizes
    }
}

// Add field truncation function
function truncateFieldValue(value: string, maxLength: number = DISCORD_FIELD_MAX_LENGTH - 50): string {
    if (value.length <= maxLength) return value

    // Try to truncate at a token boundary
    const lines = value.split('\n')
    let truncated = ''

    for (const line of lines) {
        if ((truncated + line + '\n').length > maxLength) {
            break
        }
        truncated += line + '\n'
    }

    // Add truncation indicator
    truncated += `\n... (${lines.length - truncated.split('\n').length + 1} more tokens truncated)`

    return truncated.trim()
}

// Function to send filtered tokens to Discord
async function sendFilteredTokensNotification() {
    if (!ENABLE_DISCORD_NOTIFICATIONS || !DISCORD_WEBHOOK_URL) {
        console.log('Discord notifications disabled or webhook URL not configured');
        return;
    }

    if (!acquireTrendingListNotificationSlot('trending_filtered')) {
        console.log('Skipping filtered Discord notification — dedup cooldown active');
        return;
    }

    const SERVER_URL = process.env.PUBLIC_SERVER_URL || process.env.VERCEL_URL || '';

    // Extract hostname from URL for more robust comparison
    let hostname = '';
    try {
        if (SERVER_URL) {
            // Handle URLs with or without protocol
            const urlToCheck = SERVER_URL.startsWith('http') ? SERVER_URL : `https://${SERVER_URL}`;
            const url = new URL(urlToCheck);
            hostname = url.hostname;
        }
    } catch (error) {
        console.log(`Invalid server URL format: ${SERVER_URL}`);
        return;
    }

    if (hostname !== 'reloadsol.app') {
        console.log(`Skipping Discord notification: server hostname is '${hostname}', not 'reloadsol.app'`);
        return;
    }

    try {
        // Get current filtered tokens
        const currentTime = Date.now();
        const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
        const FULL_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

        const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS;

        // Get the raw token data
        let rawTokens: TransformedToken[];
        if (tokenCache.tokens.size > 0 && currentTime < tokenCache.expiresAt && !needsFullRefresh) {
            rawTokens = Array.from(tokenCache.tokens.values());
        } else {
            rawTokens = await fetchAndUpdateCache(needsFullRefresh, currentTime, false);
        }

        // Updated filtering criteria with new market cap ranges
        const filterCriteria = {
            min_change_5m: -0.4,
            min_organic_score: 70.0,
            min_mcap: 30000,      // Changed from 300k to 30k
            max_mcap: 3000000     // Changed from 2M to 3M
        };

        const filteredTokens = rawTokens.filter(token =>
            token.change_5m > filterCriteria.min_change_5m &&
            token.organic_score >= filterCriteria.min_organic_score &&
            token.mcap > filterCriteria.min_mcap &&
            token.mcap < filterCriteria.max_mcap
        );

        // Sort tokens by organic score and price change
        const sortedTokens = filteredTokens.sort((a, b) => {
            if (b.organic_score !== a.organic_score) {
                return b.organic_score - a.organic_score;
            }
            return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0);
        });

        if (sortedTokens.length === 0) {
            console.log('No filtered tokens to report to Discord');
            return;
        }

        // Track MCap for tokens in the tracking range (30k-2M)
        const tokensInTrackingRange = sortedTokens.filter(token => isInTrackingRange(token.mcap));
        let mcapTrackingResults = new Map();

        if (tokensInTrackingRange.length > 0) {
            console.log(`Tracking MCap for ${tokensInTrackingRange.length} tokens in range 30k-2M`);
            mcapTrackingResults = await bulkTrackTokenMcaps(
                tokensInTrackingRange.map(token => ({
                    address: token.token_address,
                    symbol: token.token_symbol,
                    mcap: token.mcap
                }))
            );
        }

        // Calculate summary statistics
        const currentTokensMap = new Map(sortedTokens.map(token => [token.token_address, token]));

        let addedCount = 0;
        let updatedCount = 0;
        let increasedCount = 0;
        let decreasedCount = 0;

        // Compare with previous tokens to get statistics
        Array.from(currentTokensMap).forEach(([address, token]) => {
            const previousToken = previousFilteredTokens.get(address);
            if (!previousToken) {
                addedCount++;
            } else {
                updatedCount++;
                if (token.price > previousToken.price) {
                    increasedCount++;
                } else if (token.price < previousToken.price) {
                    decreasedCount++;
                }
            }
        });

        const removedCount = previousFilteredTokens.size - updatedCount;

        // Update previous tokens for next comparison
        previousFilteredTokens = currentTokensMap;

        // Updated market cap categories
        const categories = [
            { label: '$30k - $70k MCap', min: 30_000, max: 70_000 },
            { label: '$71k - $120k MCap', min: 71_000, max: 120_000 },
            { label: '$121k - $200k MCap', min: 121_000, max: 200_000 },
            { label: '$201k - $500k MCap', min: 201_000, max: 500_000 },
            { label: '$501k - $1M MCap', min: 501_000, max: 1_000_000 },
            { label: '$1M - $3M MCap', min: 1_000_001, max: 3_000_000 }
        ];

        // Create category fields for embed format with size validation
        const categoryFields = await Promise.all(categories.map(async cat => {
            const tokens = sortedTokens.filter(token => token.mcap >= cat.min && token.mcap <= cat.max).slice(0, 10);
            if (tokens.length === 0) return null;

            const fieldValue = await Promise.all(tokens.map(async token => {
                const hourChangeEmoji = token.change_1h
                    ? (token.change_1h > 0 ? '🟢' : '🔴')
                    : '⚪';

                const hourChangePercent = token.change_1h ? (token.change_1h * 100).toFixed(2) : '0.00';

                // Use centralized risk assessment
                const riskResult = await assessTokenRisk({
                    token_address: token.token_address,
                    token_symbol: token.token_symbol,
                    mcap: token.mcap,
                    price: token.price,
                    change_1h: token.change_1h,
                    change_5m: token.change_5m,
                    organic_score: token.organic_score
                }, {
                    timeoutMs: 5000,
                    enableLogging: true,
                    fallbackToBasic: true
                });

                const riskEmoji = getRiskEmoji(riskResult.riskLevel);
                const riskDisplay = formatDetailedRiskForDiscord(token, riskResult);

                // Get MCap tracking info
                const mcapTracking = mcapTrackingResults.get(token.token_address);
                const mcapDisplay = mcapTracking
                    ? getMcapDisplayString(mcapTracking)
                    : `MCap: $${token.mcap.toLocaleString()}`;

                // Construct chart link
                const chartLink = `https://reloadsol.app/chart/${token.token_address}`;

                return `**[${token.token_symbol}](${chartLink})** ${riskEmoji}\n` +
                    `Price: $${token.price.toFixed(6)} ${hourChangeEmoji} ${hourChangePercent}%\n` +
                    `${mcapDisplay}\n` +
                    `${riskDisplay}\n`;
            }));

            const joinedFieldValue = fieldValue.join('\n');

            // Truncate field value if too long
            const truncatedValue = truncateFieldValue(joinedFieldValue);

            return {
                name: `${cat.label}`,
                value: truncatedValue
            };
        }));

        // Filter out null values
        const validCategoryFields = categoryFields.filter(Boolean);

        // If no tokens in any category, show a fallback field
        const fields = validCategoryFields.length > 0 ? validCategoryFields : [{
            name: 'No Filtered Tokens Found',
            value: 'No tokens match the current filter criteria.'
        }];

        // Create embed message
        const message = {
            embeds: [
                {
                    title: ` 📜 Filtered Token Update`,
                    description: `**Summary:** ${addedCount} added, ${updatedCount} updated, ${removedCount} removed\n**Price movements:** ${increasedCount} increased, ${decreasedCount} decreased\n**MCap Tracking:** ${mcapTrackingResults.size} tokens tracked for growth`,
                    color: 3447003, // Blue color
                    timestamp: new Date().toISOString(),
                    fields,
                    footer: {
                        text: `Filtered: Score ≥${filterCriteria.min_organic_score}, MCap $${(filterCriteria.min_mcap / 1000).toFixed(0)}k-$${(filterCriteria.max_mcap / 1000000).toFixed(0)}M, 5m change >-40% | MCap growth tracked for 30k-2M range`
                    }
                }
            ]
        };

        // Validate message size before sending
        const validation = validateDiscordMessage(message);

        console.log('Discord message validation:', {
            valid: validation.valid,
            issues: validation.issues,
            sizes: validation.sizes,
            tokensCount: sortedTokens.length,
            fieldsCount: fields.length
        });

        if (!validation.valid) {
            console.warn('Discord message validation failed:', validation.issues);

            // If validation fails, try to create a simplified message
            const simplifiedMessage = {
                embeds: [
                    {
                        title: ` 📜 Filtered Token Update (Simplified)`,
                        description: `**Summary:** ${addedCount} added, ${updatedCount} updated, ${removedCount} removed\n**Price movements:** ${increasedCount} increased, ${decreasedCount} decreased\n\n**Total filtered tokens:** ${sortedTokens.length}\n\n*Message was too large for full display. Check the API directly for complete data.*`,
                        color: 3447003,
                        timestamp: new Date().toISOString(),
                        fields: [], // Add empty fields array to match the expected type structure
                        footer: {
                            text: `Filtered: Score ≥${filterCriteria.min_organic_score}, MCap $${(filterCriteria.min_mcap / 1000).toFixed(0)}k-$${(filterCriteria.max_mcap / 1000000).toFixed(0)}M`
                        }
                    }
                ]
            };

            // Use simplified message instead
            message.embeds = simplifiedMessage.embeds;
        }

        // Send the message to Discord with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
            const response = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const responseText = await response.text().catch(() => 'Unable to read response');
                throw new Error(`Discord API responded with status: ${response.status}, body: ${responseText}`);
            }

            console.log('Discord filtered notification sent successfully', {
                tokensCount: sortedTokens.length,
                fieldsCount: fields.length,
                messageValid: validation.valid,
                summary: { addedCount, updatedCount, removedCount, increasedCount, decreasedCount }
            });
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    } catch (error) {
        console.error('Error sending Discord filtered notification:', error);
        // Don't throw the error to avoid disrupting the main flow
    }
}

// Add a test function for filtered Discord notifications
async function testFilteredDiscordNotification() {
    if (!ENABLE_DISCORD_NOTIFICATIONS || !DISCORD_WEBHOOK_URL) {
        throw new Error('Discord notifications disabled or webhook URL not configured');
    }

    const testMessage = {
        embeds: [
            {
                title: `🧪 Filtered Discord Test Notification`,
                description: `**Test Message from Filtered API**\nThis is a test notification to verify Discord webhook configuration for filtered tokens.`,
                color: 16776960, // Yellow color for test
                timestamp: new Date().toISOString(),
                fields: [
                    {
                        name: 'Configuration Status',
                        value: `✅ Webhook URL: Configured\n✅ Notifications: Enabled\n✅ Environment: ${process.env.NODE_ENV || 'unknown'}\n✅ Filter: Score ≥70, MCap $300k-$2M`
                    }
                ],
                footer: {
                    text: 'Buy Bulk Filtered Token Tracker - Test'
                }
            }
        ]
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testMessage),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Discord API responded with status: ${response.status}`);
        }

        return { success: true, message: 'Test filtered notification sent successfully' };
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// Add a PUT endpoint for testing Discord notifications
export async function PUT(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const secretKey = searchParams.get('key');
        const expectedSecretKey = process.env.NOTIFICATION_SECRET_KEY;

        // Validate secret key if configured
        if (expectedSecretKey && secretKey !== expectedSecretKey) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Check Discord configuration
        const webhookUrl = process.env.DISCORD_WEBHOOK_AUTO_TRADE || process.env.DISCORD_WEBHOOK_URL || '';

        console.log('Filtered Discord Configuration Test:', {
            enabled: ENABLE_DISCORD_NOTIFICATIONS,
            webhookConfigured: !!webhookUrl,
            webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 50)}...` : 'Not configured',
            env: {
                DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
                DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
                DISCORD_WEBHOOK_URL_DEV: !!process.env.DISCORD_WEBHOOK_URL_DEV,
                ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
            }
        });

        // Test Discord notification
        let testResult;
        try {
            testResult = await testFilteredDiscordNotification();
        } catch (error) {
            testResult = {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }

        return NextResponse.json({
            success: true,
            message: 'Filtered Discord configuration test completed',
            discord: {
                enabled: ENABLE_DISCORD_NOTIFICATIONS,
                webhookConfigured: !!webhookUrl,
                testResult
            },
            environment: {
                NODE_ENV: process.env.NODE_ENV,
                DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
                DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
                DISCORD_WEBHOOK_URL_DEV: !!process.env.DISCORD_WEBHOOK_URL_DEV,
                ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
            }
        });
    } catch (error) {
        console.error('Error in filtered Discord test endpoint:', error);
        return NextResponse.json({
            error: 'Failed to test filtered Discord configuration',
            message: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
}

// Add a POST endpoint for scheduled filtered notifications
export async function POST(request: NextRequest) {
    try {
        // Verify secret key
        const { searchParams } = new URL(request.url)
        const secretKey = searchParams.get('key')
        const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'

        if (secretKey !== expectedSecretKey) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // Send filtered tokens notification
        await sendFilteredTokensNotification()

        return NextResponse.json({
            success: true,
            message: 'Filtered tokens notification sent successfully'
        })
    } catch (error) {
        console.error('Error in filtered trending POST handler:', error)
        return NextResponse.json({
            error: 'Failed to process filtered trending request',
            message: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
    }
}

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
            tokens: await attachFirstDetections(sortedTokens, 'sol'),
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