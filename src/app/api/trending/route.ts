import { NextResponse } from 'next/server'
import { NextRequest, connection } from 'next/server'
import { JupiterBaseAsset, JupiterPool, JupiterResponse, TokenCache, TransformedToken } from '@/types'
import { fetchAxiomTokenInfo, getRiskIndicators, calculateFeeToMarketCapRatio } from '@/utils/axiom'
import { assessTokenRisk, formatDetailedRiskForDiscord, getRiskEmoji } from '@/utils/risk-assessment'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, bulkTrackTokenMcaps } from '@/utils/mcap-tracker'
import { formatAppDateTimeWithZone } from '@/utils/datetime'
import {
  acquireTrendingListNotificationSlot,
  trendingListDiscordViaCronOnly,
} from '@/utils/trending-notification-dedup'

// Environment variable for Discord webhook URL
const DISCORD_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? process.env.DISCORD_WEBHOOK_URL_DEV || process.env.DISCORD_WEBHOOK_URL
    : process.env.DISCORD_WEBHOOK_URL;
const ENABLE_DISCORD_NOTIFICATIONS = process.env.ENABLE_DISCORD_NOTIFICATIONS === 'true';

// Add auto-notification interval (default 2 min — matches cron + dedup cooldown)
const AUTO_NOTIFICATION_INTERVAL_MS = parseInt(process.env.AUTO_NOTIFICATION_INTERVAL_MS || '120000');

// Track last auto notification time
let lastAutoNotificationTime = 0;

// Initialize token cache
let tokenCache: TokenCache = {
  tokens: new Map<string, TransformedToken>(),
  timestamp: 0,
  expiresAt: 0,
  lastFullRefresh: 0
};

// Global cleanup tracking
let globalTimers: {
  notificationTimer?: NodeJS.Timeout;
  initialDelayTimer?: NodeJS.Timeout;
} = {};

// Function to initialize the notification timer
function initializeNotificationTimer() {
  if (trendingListDiscordViaCronOnly()) {
    console.log('Trending list Discord via Go cron — skipping route notification timer')
    return
  }
  if (typeof process !== 'undefined' && ENABLE_DISCORD_NOTIFICATIONS && !globalTimers.notificationTimer) {
    console.log('🔔 Initializing automatic notification timer...', {
      ENABLE_DISCORD_NOTIFICATIONS,
      AUTO_NOTIFICATION_INTERVAL_MS,
      intervalMinutes: AUTO_NOTIFICATION_INTERVAL_MS / 60000
    });

    // Initial delay of 30 seconds after server start before first check
    globalTimers.initialDelayTimer = setTimeout(() => {
      console.log('⏰ Starting automatic notification timer');

      // Set interval for periodic notifications
      globalTimers.notificationTimer = setInterval(() => {
        const currentTime = Date.now();
        const timeSinceLastNotification = currentTime - lastAutoNotificationTime;

        console.log('🔄 Auto-notification timer check', {
          currentTime: new Date(currentTime).toISOString(),
          lastAutoNotificationTime: new Date(lastAutoNotificationTime).toISOString(),
          timeSinceLastNotification,
          AUTO_NOTIFICATION_INTERVAL_MS,
          shouldTrigger: timeSinceLastNotification >= AUTO_NOTIFICATION_INTERVAL_MS
        });

        // Check if it's time for a notification
        if (timeSinceLastNotification >= AUTO_NOTIFICATION_INTERVAL_MS) {
          console.log('🚨 Auto-notification interval triggered');

          // Determine if we need a full refresh
          const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS;

          console.log('🔄 Refresh check', {
            currentTime,
            lastFullRefresh: tokenCache.lastFullRefresh,
            timeSinceFullRefresh: currentTime - tokenCache.lastFullRefresh,
            FULL_REFRESH_INTERVAL_MS,
            needsFullRefresh
          });

          // Trigger notification with proper error handling
          fetchAndUpdateCache(needsFullRefresh, currentTime, true)
            .then(tokenArray => {
              console.log(`✅ Scheduled notification completed with ${tokenArray.length} tokens`);
            })
            .catch(error => {
              console.error('❌ Error in scheduled notification:', error);
              // Reset refresh state on error to prevent permanent blocking
              refreshState.promise = null;
              refreshState.timeout = null;
            });
        } else {
          console.log('⏭️ Auto-notification timer check - not time yet', {
            timeRemaining: AUTO_NOTIFICATION_INTERVAL_MS - timeSinceLastNotification,
            timeRemainingMinutes: (AUTO_NOTIFICATION_INTERVAL_MS - timeSinceLastNotification) / 60000
          });
        }
      }, Math.min(60000, AUTO_NOTIFICATION_INTERVAL_MS / 2)); // Check at least every minute or half the notification interval

      // Clear the initial delay timer reference
      globalTimers.initialDelayTimer = undefined;
    }, 30000);
  } else if (globalTimers.notificationTimer) {
    console.log('⚠️ Notification timer is already running.');
  } else {
    console.log('❌ Automatic notifications are disabled.', {
      processExists: typeof process !== 'undefined',
      ENABLE_DISCORD_NOTIFICATIONS,
      hasExistingTimer: !!globalTimers.notificationTimer
    });
  }
}

// Cleanup function for graceful shutdown
function cleanupGlobalTimers() {
  if (globalTimers.notificationTimer) {
    clearInterval(globalTimers.notificationTimer);
    globalTimers.notificationTimer = undefined;
  }
  if (globalTimers.initialDelayTimer) {
    clearTimeout(globalTimers.initialDelayTimer);
    globalTimers.initialDelayTimer = undefined;
  }
}

// Initialize the timer when the module is loaded
initializeNotificationTimer();

// Handle process termination gracefully
if (typeof process !== 'undefined') {
  process.on('SIGTERM', cleanupGlobalTimers);
  process.on('SIGINT', cleanupGlobalTimers);
  process.on('exit', cleanupGlobalTimers);
}

// In-memory cache with 5-minute expiry
// Use a specific type annotation to avoid conflicts with generated types
// (tokenCache is initialized at the top of the file)

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds
const FULL_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes in milliseconds

// Improved concurrency control with proper state management
interface RefreshState {
  promise: Promise<TransformedToken[]> | null;
  timeout: NodeJS.Timeout | null;
  startTime: number;
  requestCount: number;
}

let refreshState: RefreshState = {
  promise: null,
  timeout: null,
  startTime: 0,
  requestCount: 0
};

// Maximum time to wait for a refresh operation (30 seconds)
const MAX_REFRESH_WAIT_MS = 30000;

// Function to safely clear refresh state
function clearRefreshState() {
  if (refreshState.timeout) {
    clearTimeout(refreshState.timeout);
  }
  refreshState.promise = null;
  refreshState.timeout = null;
  refreshState.startTime = 0;
  refreshState.requestCount = 0;
}

// Helper function to truncate field values that are too long
function truncateFieldValue(value: string, maxLength: number = 1024): string {
  if (value.length <= maxLength) return value;

  const truncated = value.substring(0, maxLength - 50);
  const lastNewline = truncated.lastIndexOf('\n');
  return lastNewline > 0 ? truncated.substring(0, lastNewline) + '\n\n*...truncated*' : truncated + '\n\n*...truncated*';
}

// Lightweight Discord embed validator (mirrors filtered route approach)
const DISCORD_FIELD_MAX_LENGTH = 1024;
const DISCORD_DESCRIPTION_MAX_LENGTH = 4096;

function validateDiscordMessage(message: any): { valid: boolean; issues: string[]; sizes: any } {
  const issues: string[] = [];
  const sizes: any = {
    totalFields: 0,
    fieldSizes: [] as number[],
    descriptionSize: 0,
    totalEmbedSize: 0
  };

  if (message?.embeds && message.embeds.length > 0) {
    const embed = message.embeds[0];

    if (embed.description) {
      sizes.descriptionSize = embed.description.length;
      if (embed.description.length > DISCORD_DESCRIPTION_MAX_LENGTH) {
        issues.push(`Description too long: ${embed.description.length}/${DISCORD_DESCRIPTION_MAX_LENGTH}`);
      }
    }

    if (embed.fields) {
      sizes.totalFields = embed.fields.length;
      if (embed.fields.length > 25) {
        issues.push(`Too many fields: ${embed.fields.length}/25`);
      }

      embed.fields.forEach((field: any, index: number) => {
        const fieldSize = (field.name?.length || 0) + (field.value?.length || 0);
        sizes.fieldSizes.push(fieldSize);
        if (typeof field.value !== 'string') {
          issues.push(`Field ${index} value is not a string`);
        } else if (field.value.length > DISCORD_FIELD_MAX_LENGTH) {
          issues.push(`Field ${index} value too long: ${field.value.length}/${DISCORD_FIELD_MAX_LENGTH}`);
        }
      });
    }

    // Rough total size estimate
    try {
      const embedJson = JSON.stringify(embed);
      sizes.totalEmbedSize = embedJson.length;
      if (sizes.totalEmbedSize > 5500) {
        issues.push(`Embed JSON size is large: ${sizes.totalEmbedSize} (limit ~6000)`);
      }
    } catch { }
  }

  return { valid: issues.length === 0, issues, sizes };
}

// Function to send updates to Discord
async function sendDiscordNotification(
  tokenArray: TransformedToken[],
  stats: {
    added: number,
    updated: number,
    removed: number,
    unchanged: number,
    price_increased: number,
    price_decreased: number
  },
  refreshType: 'full' | 'incremental',
  forceSend: boolean = false,
  newlyAddedTokens: TransformedToken[] = [],
  mcapTrackingResults?: Map<string, any>
) {
  console.log('🔔 Discord notification check started', {
    enabled: ENABLE_DISCORD_NOTIFICATIONS,
    webhookConfigured: !!DISCORD_WEBHOOK_URL,
    forceSend,
    stats,
    newlyAddedTokensCount: newlyAddedTokens.length
  });

  if (!ENABLE_DISCORD_NOTIFICATIONS || !DISCORD_WEBHOOK_URL) {
    console.log('❌ Discord notifications disabled or webhook URL not configured', {
      ENABLE_DISCORD_NOTIFICATIONS,
      webhookConfigured: !!DISCORD_WEBHOOK_URL,
      webhookUrl: DISCORD_WEBHOOK_URL ? `${DISCORD_WEBHOOK_URL.substring(0, 50)}...` : 'Not set'
    });
    return;
  }

  // const SERVER_URL = process.env.PUBLIC_SERVER_URL || process.env.VERCEL_URL || '';
  // console.log('🌐 Server URL check', {
  //   SERVER_URL,
  //   PUBLIC_SERVER_URL: process.env.PUBLIC_SERVER_URL,
  //   VERCEL_URL: process.env.VERCEL_URL,
  //   matches: SERVER_URL === 'reloadsol.app'
  // });

  // if (SERVER_URL !== 'reloadsol.app') {
  //   console.log(`⏭️ Skipping Discord notification: server URL is ${SERVER_URL}, not reloadsol.app`);
  //   return;
  // }

  // Always send if there are new tokens, updates, removals, or price movements in filter categories
  const hasPriceMovement = stats.price_increased > 0 || stats.price_decreased > 0;
  const hasChanges = stats.added > 0 || stats.updated > 0 || stats.removed > 0 || hasPriceMovement;

  console.log('📊 Change detection', {
    hasChanges,
    hasPriceMovement,
    forceSend,
    shouldSend: forceSend || hasChanges
  });

  if (!forceSend && !hasChanges) {
    console.log('📭 No changes to report to Discord');
    return;
  }

  try {
    console.log('🚀 Starting Discord notification preparation...');

    // Process tokens by market cap categories with risk assessment
    const categories = [
      { label: '$30k - $70k MCap', min: 30_000, max: 70_000 },
      { label: '$71k - $120k MCap', min: 71_000, max: 120_000 },
      { label: '$121k - $200k MCap', min: 121_000, max: 200_000 },
      { label: '$201k - $500k MCap', min: 201_000, max: 500_000 },
      { label: '$501k - $1M MCap', min: 501_000, max: 1_000_000 },
      { label: '$1M - $3M MCap', min: 1_000_001, max: 3_000_000 }
    ];

    // If no new tokens, but there are price movements, include those tokens in the message
    let tokensToShare = newlyAddedTokens;
    if (tokensToShare.length === 0 && hasPriceMovement) {
      // Find tokens in the filter categories with price movement
      tokensToShare = tokenArray.filter(token => {
        return categories.some(cat => token.mcap >= cat.min && token.mcap <= cat.max) &&
          (token.price_change && Math.abs(token.price_change) > 0);
      });
    }

    console.log('🎯 Tokens to share', {
      newlyAddedCount: newlyAddedTokens.length,
      tokensToShareCount: tokensToShare.length,
      hasPriceMovement
    });

    // Sort tokens for better display
    const sortedTokens = tokensToShare.sort((a, b) => {
      if (b.organic_score !== a.organic_score) {
        return b.organic_score - a.organic_score;
      }
      return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0);
    });

    console.log(`📊 Processing ${sortedTokens.length} tokens for Discord notification`);

    // Create category fields for embed format with size validation
    const categoryFields = await Promise.all(categories.map(async cat => {
      const tokens = sortedTokens.filter(token => token.mcap >= cat.min && token.mcap <= cat.max).slice(0, 10);
      if (tokens.length === 0) return null;

      console.log(`🏷️ Processing ${tokens.length} tokens in category: ${cat.label}`);

      const tokenEntries = await Promise.all(tokens.map(async token => {
        const hourChangeEmoji = token.change_1h
          ? (token.change_1h > 0 ? '🟢' : '🔴')
          : '⚪';

        const hourChangePercent = token.change_1h && isFinite(token.change_1h) ? (token.change_1h * 100).toFixed(2) : '0.00';

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
        const trackingResults = mcapTrackingResults || new Map();
        const mcapTracking = trackingResults.get(token.token_address);
        const mcapDisplay = mcapTracking
          ? getMcapDisplayString(mcapTracking)
          : `MCap: $${isFinite(token.mcap) ? token.mcap.toLocaleString() : '0'}`;

        // Construct chart link
        const chartLink = `https://reloadsol.app/chart/${token.token_address}`;

        return `**[${token.token_symbol}](${chartLink})** ${riskEmoji}\n` +
          `Price: $${isFinite(token.price) ? token.price.toFixed(6) : '0.000000'} ${hourChangeEmoji} ${hourChangePercent}%\n` +
          `${mcapDisplay}\n` +
          `${riskDisplay}\n`;
      }));

      const fieldValue = tokenEntries.join('\n');

      // Truncate field value if too long
      const truncatedValue = truncateFieldValue(fieldValue);

      return {
        name: `${cat.label}`,
        value: truncatedValue
      };
    }));

    // Filter out null categories and ensure we have content
    const validFields = categoryFields.filter(field => field !== null);

    // Create daily ranking section
    const dailyRankingField = createDailyRankingSection(tokenArray, mcapTrackingResults);

    console.log('📋 Discord message fields prepared', {
      totalCategories: categories.length,
      validFields: validFields.length,
      hasContent: validFields.length > 0,
      hasDailyRanking: !!dailyRankingField
    });

    // Combine daily ranking with category fields
    const allFields = [];
    if (dailyRankingField) {
      allFields.push(dailyRankingField);
    }
    allFields.push(...validFields);

    // If no tokens in any category, show a fallback field
    const fields = allFields.length > 0 ? allFields : [{
      name: 'No New Tokens ≤ $3M MCap Added',
      value: 'No new tokens ≤ $3M market cap were added in this update.'
    }];

    // Calculate daily statistics
    const dailyStats = calculateDailyStats(tokenArray);
    const volumeFormatted = isFinite(dailyStats.totalVolume) && dailyStats.totalVolume >= 1000000
      ? `$${(dailyStats.totalVolume / 1000000).toFixed(1)}M`
      : isFinite(dailyStats.totalVolume) && dailyStats.totalVolume >= 1000
        ? `$${(dailyStats.totalVolume / 1000).toFixed(1)}k`
        : `$${isFinite(dailyStats.totalVolume) ? dailyStats.totalVolume.toFixed(0) : '0'}`;

    // Create daily summary header
    const dailySummaryHeader = createDailySummaryHeader(tokenArray, mcapTrackingResults);

    // Build description and ensure it stays within safe Discord limits
    const fullDescription = `${dailySummaryHeader}\n\n**Summary:** ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed\n**Price movements:** ${stats.price_increased} increased, ${stats.price_decreased} decreased\n**MCap Tracking:** ${mcapTrackingResults?.size || 0} tokens tracked for growth`;
    const safeDescription = truncateFieldValue(fullDescription, 1500);

    // Create embed message with simple approach (no complex validation)
    const message = {
      embeds: [
        {
          title: ` 🧪 Trending Token Update (${refreshType})`,
          description: safeDescription,
          color: 3447003, // Blue color
          timestamp: new Date().toISOString(),
          // Ensure we do not exceed Discord's 25 fields limit
          fields: fields.length > 25 ? [
            ...fields.slice(0, 24),
            { name: 'More', value: `... (${fields.length - 24} additional sections truncated)` }
          ] : fields,
          footer: {
            text: `Trending tokens (non filtered) | MCap growth tracked for 30k-2M range | Active: ${dailyStats.activeTokens} tokens`
          }
        }
      ]
    };

    // Log the final message structure for debugging
    console.log('📤 Final Discord message structure:', {
      embedsCount: message.embeds?.length || 0,
      fieldsCount: message.embeds?.[0]?.fields?.length || 0,
      titleLength: message.embeds?.[0]?.title?.length || 0,
      descriptionLength: message.embeds?.[0]?.description?.length || 0,
      footerTextLength: message.embeds?.[0]?.footer?.text?.length || 0
    });

    // Validate message size before sending; if invalid, simplify
    const validation = validateDiscordMessage(message);
    if (!validation.valid) {
      console.warn('⚠️ Discord message validation failed, simplifying:', validation.issues);
      const simplified = {
        embeds: [
          {
            title: ` 🧪 Trending Token Update (${refreshType}) — Simplified`,
            description: truncateFieldValue(
              `Summary only due to size: ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed. Active tokens: ${dailyStats.activeTokens}.`,
              1000
            ),
            color: 3447003,
            timestamp: new Date().toISOString(),
            fields: [],
            footer: {
              text: 'Message simplified to meet Discord embed limits.'
            }
          }
        ]
      };
      message.embeds = simplified.embeds;
    }

    // Additional safety check: ensure embeds array contains valid objects
    if (!Array.isArray(message.embeds) || message.embeds.length === 0) {
      console.error('🚨 Invalid embeds array detected, using fallback');
      message.embeds = [{
        title: 'Trending Token Update',
        description: 'Embed validation failed - using fallback',
        color: 3447003,
        timestamp: new Date().toISOString(),
        fields: [{ name: 'Status', value: 'System error - please check logs' }],
        footer: { text: 'Trending tokens update' }
      }];
    }

    console.log('📤 Sending Discord message...', {
      embedsCount: message.embeds.length,
      fieldsCount: message.embeds[0]?.fields?.length || 0,
      webhookUrl: DISCORD_WEBHOOK_URL.substring(0, 50) + '...'
    });

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
        const errorText = await response.text().catch(() => 'Unable to read error response');
        throw new Error(`Discord API responded with status: ${response.status} - ${errorText}`);
      }

      console.log('✅ Discord notification sent successfully');
    } catch (error: any) {
      clearTimeout(timeoutId);

      // Enhanced error logging to identify the exact cause
      console.error('❌ Error sending Discord message:', error);
      console.error('🔍 Discord Error Debug Info:', {
        errorMessage: error?.message || 'Unknown error',
        embedsLength: message.embeds?.length,
        embedsStructure: message.embeds?.map((embed: any, index: number) => ({
          embedIndex: index,
          title: embed.title,
          description: embed.description?.substring(0, 100) + '...',
          fieldsCount: embed.fields?.length,
          fieldsPreview: embed.fields?.slice(0, 3).map((field: any) => ({
            name: field.name?.substring(0, 50),
            value: field.value?.substring(0, 100),
            valueType: typeof field.value,
            hasInvalidChars: field.value?.includes('NaN') || field.value?.includes('Infinity')
          }))
        })),
        messageSize: JSON.stringify(message).length,
        hasAxiomErrors: error?.message?.includes('Axiom') || false
      });

      // Log the raw message structure for debugging
      console.error('🔍 Raw Discord Message Structure:', JSON.stringify(message, null, 2).substring(0, 2000) + '...');

      throw error;
    }
  } catch (error) {
    console.error('💥 Error in Discord notification process:', error);
    // Don't throw the error to avoid disrupting the main flow
  }
}

async function testDiscordNotification() {
  if (!ENABLE_DISCORD_NOTIFICATIONS || !DISCORD_WEBHOOK_URL) {
    throw new Error('Discord notifications disabled or webhook URL not configured');
  }

  const testMessage = {
    embeds: [
      {
        title: `🧪 Discord Test Notification`,
        description: `**Test Message from Trending API**\nThis is a test notification to verify Discord webhook configuration.`,
        color: 16776960, // Yellow color for test
        timestamp: new Date().toISOString(),
        fields: [
          {
            name: 'Configuration Status',
            value: `✅ Webhook URL: Configured\n✅ Notifications: Enabled\n✅ Environment: ${process.env.NODE_ENV || 'unknown'}`
          }
        ],
        footer: {
          text: 'Buy Bulk Token Tracker - Test'
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

    return { success: true, message: 'Test notification sent successfully' };
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

    console.log('Discord Configuration Test:', {
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
      testResult = await testDiscordNotification();
    } catch (error) {
      testResult = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return NextResponse.json({
      success: true,
      message: 'Discord configuration test completed',
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
    console.error('Error in Discord test endpoint:', error);
    return NextResponse.json({
      error: 'Failed to test Discord configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

// Add a POST endpoint for scheduled notifications from cron jobs
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const secretKey = searchParams.get('key');
    const expectedSecretKey = process.env.NOTIFICATION_SECRET_KEY || process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending';

    // Validate secret key if configured
    if (expectedSecretKey && secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Force a full refresh and force notifications
    const tokenArray = await fetchAndUpdateCache(true, Date.now(), true);

    return NextResponse.json({
      success: true,
      message: 'Notifications sent',
      token_count: tokenArray.length
    });
  } catch (error) {
    console.error('Error in scheduled notification:', error);
    return NextResponse.json({
      error: 'Failed to send scheduled notification',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  await connection()
  try {
    const currentTime = Date.now();

    // Parse query parameters
    const { searchParams } = new URL(req.url, 'http://localhost');
    const forceRefresh = searchParams.get('refresh') === 'true';
    const cacheParam = searchParams.get('cache');
    const noCacheHeader = req.headers.get('x-no-cache');
    const shouldDisableCache = cacheParam === 'off' || noCacheHeader === '1';
    // If shouldDisableCache, force skipCache
    const skipCache = shouldDisableCache || searchParams.get('nocache') === 'true';

    const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS || forceRefresh;

    // Return cached data if it's still valid and doesn't need a full refresh
    if (tokenCache.tokens.size > 0 && currentTime < tokenCache.expiresAt && !needsFullRefresh && !skipCache) {
      console.log('Using cached token data, expires in', Math.round((tokenCache.expiresAt - currentTime) / 1000), 'seconds');
      const response = NextResponse.json(
        {
          // Re-use the same ordering criteria used for fresh responses
          tokens: Array.from(tokenCache.tokens.values()).sort((a, b) => {
            if (b.organic_score !== a.organic_score) {
              return b.organic_score - a.organic_score;
            }
            return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0);
          }),
          cached: true,
          cache_age: Math.round((currentTime - tokenCache.timestamp) / 1000),
          expires_in: Math.round((tokenCache.expiresAt - currentTime) / 1000)
        },
        {
          status: 200,
          headers: {
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
          }
        }
      );
      if (shouldDisableCache) {
        response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.headers.set('Pragma', 'no-cache');
        response.headers.set('Expires', '0');
      }
      return response;
    }

    // Improved concurrency control
    if (refreshState.promise) {
      const elapsedTime = currentTime - refreshState.startTime;

      // If refresh has been running too long, abandon it and start fresh
      if (elapsedTime > MAX_REFRESH_WAIT_MS) {
        console.log('Refresh operation timed out, starting fresh');
        clearRefreshState();
      } else {
        console.log(`Using existing refresh operation in progress (${refreshState.requestCount + 1} concurrent requests)`);
        refreshState.requestCount++;

        try {
          // Wait for the existing refresh operation to complete
          const tokens = await refreshState.promise;
          refreshState.requestCount = Math.max(0, refreshState.requestCount - 1);

          const response = NextResponse.json(
            {
              tokens,
              cached: false,
              cache_age: 0,
              refresh_type: needsFullRefresh ? 'full' : 'incremental',
              expires_in: Math.round((tokenCache.expiresAt - Date.now()) / 1000),
              stats: {
                concurrent_request: true,
                concurrent_count: refreshState.requestCount + 1
              }
            },
            {
              status: 200,
              headers: {
                'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
              }
            }
          );
          if (shouldDisableCache) {
            response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            response.headers.set('Pragma', 'no-cache');
            response.headers.set('Expires', '0');
          }
          return response;
        } catch (error) {
          // If the existing refresh operation failed, reset and continue with a new one
          console.error('Existing refresh operation failed:', error);
          clearRefreshState();
          // Continue to fetch fresh data
        }
      }
    }

    // Create a new refresh operation - never force notifications from frontend requests
    refreshState.promise = fetchAndUpdateCache(needsFullRefresh, currentTime, false);
    refreshState.startTime = currentTime;
    refreshState.requestCount = 1;

    try {
      // Wait for the refresh operation to complete
      const tokens = await refreshState.promise;

      const response = NextResponse.json(
        {
          tokens,
          cached: false,
          cache_age: 0,
          refresh_type: needsFullRefresh ? 'full' : 'incremental',
          expires_in: CACHE_TTL_MS / 1000,
          last_updated: currentTime,
          next_full_refresh: tokenCache.lastFullRefresh + FULL_REFRESH_INTERVAL_MS
        },
        {
          status: 200,
          headers: {
            // Set cache control to 5 minutes (300 seconds)
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'
          }
        }
      );
      if (shouldDisableCache) {
        response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.headers.set('Pragma', 'no-cache');
        response.headers.set('Expires', '0');
      }
      return response;
    } finally {
      // Set a timeout to clear the refreshState after a grace period
      // This prevents a failed request from blocking all future requests permanently
      if (refreshState.timeout) {
        clearTimeout(refreshState.timeout);
      }

      refreshState.timeout = setTimeout(() => {
        clearRefreshState();
      }, 10000); // 10 second grace period
    }
  } catch (error) {
    // Make sure to clear the refreshState if an error occurs
    clearRefreshState();
    console.error('Error fetching trending tokens:', error)
    return NextResponse.json(
      { error: 'Failed to fetch trending tokens', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// Separate async function to fetch and update the cache
async function fetchAndUpdateCache(
  needsFullRefresh: boolean,
  currentTime: number,
  forceSendNotification: boolean = false
): Promise<TransformedToken[]> {
  try {
    console.log(needsFullRefresh ? 'Performing full refresh' : 'Updating token cache');

    // Declare newlyAddedTokens at the top
    const newlyAddedTokens: TransformedToken[] = [];

    // Enhanced API fetching with parallel requests and better error handling
    const TRENDING_URLS = [
      'https://datapi.jup.ag/v1/pools/toptrending/1h',
      // 'https://api.jup.ag/v1/pools/toptrending/1h'
    ];

    const REQUEST_TIMEOUT = 8000; // 8 second timeout
    const RETRY_DELAY = 300; // Reduced delay between retries

    // Create fetch promises for all URLs with timeout
    const fetchPromises = TRENDING_URLS.map(async (url, index) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        // Add small delay for fallback URLs to prefer primary
        if (index > 0) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * index));
        }

        const response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'cache-control': 'no-cache',
            'user-agent': 'reloadsol-bot/1.0 (+https://reloadsol.xyz)'
          },
          signal: controller.signal,
          cache: 'no-store'
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return { success: true, response, url, index };
        }

        // Handle rate limiting and server errors
        if (response.status === 403 || response.status === 429) {
          console.warn(`Trending API rate limited (${response.status}) for ${url}`);
          return { success: false, error: `Rate limited: ${response.status}`, url, index, retryable: true };
        }

        return { success: false, error: `HTTP ${response.status}`, url, index, retryable: false };
      } catch (error) {
        clearTimeout(timeoutId);
        const isTimeout = error instanceof Error && error.name === 'AbortError';
        console.error(`Error fetching from ${url}:`, isTimeout ? 'Timeout' : error);
        return {
          success: false,
          error: isTimeout ? 'Timeout' : (error instanceof Error ? error.message : 'Network error'),
          url,
          index,
          retryable: !isTimeout
        };
      }
    });

    // Wait for the first successful response or all to fail
    let response: Response | null = null;
    let successfulUrl = '';

    try {
      const results = await Promise.allSettled(fetchPromises);

      // Find the first successful response
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          response = result.value.response || null;
          successfulUrl = result.value.url;
          console.log(`Successfully fetched trending data from ${successfulUrl}`);
          break;
        }
      }

      // If no successful response, log all errors
      if (!response) {
        const errors = results
          .filter(r => r.status === 'fulfilled' && !r.value.success)
          .map(r => r.status === 'fulfilled' ? `${r.value.url}: ${r.value.error}` : 'Promise rejected')
          .join(', ');
        console.error('All trending API endpoints failed:', errors);
      }
    } catch (error) {
      console.error('Error in parallel fetch operation:', error);
    }

    if (!response || !response.ok) {
      // All attempts failed – if we still have cached tokens, return them
      if (tokenCache.tokens.size > 0) {
        console.warn('All trending API endpoints failed – serving stale cached data');
        // Update cache timestamp to prevent immediate re-fetch
        tokenCache.expiresAt = currentTime + (CACHE_TTL_MS / 2); // Extend cache by half TTL
        return Array.from(tokenCache.tokens.values());
      }
      throw new Error('All Jupiter trending API endpoints failed and no cached data available');
    }

    const data = (await response.json()) as JupiterResponse;

    // Transform the data to match our component's expected format
    const transformedTokens = data.pools.map((pool): TransformedToken => {
      // Debug logging for created_at timestamp
      console.log(`Pool ${pool.baseAsset.symbol} createdAt:`, {
        rawCreatedAt: pool.createdAt,
        type: typeof pool.createdAt,
        cachedCreatedAt: tokenCache.tokens.get(pool.baseAsset.id)?.created_at,
        parsedDate: pool.createdAt ? new Date(pool.createdAt).toString() : 'N/A'
      });

      // Parse and normalize the createdAt timestamp
      let normalizedCreatedAt: number | undefined = undefined;

      if (pool.createdAt) {
        // Handle string timestamps (ISO format)
        if (typeof pool.createdAt === 'string') {
          try {
            // Try parsing as ISO date string first
            const date = new Date(pool.createdAt);
            if (!isNaN(date.getTime())) {
              normalizedCreatedAt = Math.floor(date.getTime() / 1000); // Convert to seconds
            } else {
              // Try parsing as numeric string
              normalizedCreatedAt = parseInt(pool.createdAt);
              if (isNaN(normalizedCreatedAt)) normalizedCreatedAt = undefined;
            }
          } catch (e) {
            console.error(`Failed to parse createdAt for ${pool.baseAsset.symbol}:`, pool.createdAt);
          }
        }
        // Handle numeric timestamps
        else if (typeof pool.createdAt === 'number') {
          normalizedCreatedAt = pool.createdAt;
          // If value is in milliseconds, convert to seconds
          if (normalizedCreatedAt > 1000000000000) {
            normalizedCreatedAt = Math.floor(normalizedCreatedAt / 1000);
          }
        }
      }

      // Fallback to cached value if available, or just leave as undefined
      if (!normalizedCreatedAt && tokenCache.tokens.has(pool.baseAsset.id)) {
        normalizedCreatedAt = tokenCache.tokens.get(pool.baseAsset.id)?.created_at;
      }

      return {
        token_symbol: pool.baseAsset.symbol,
        token_address: pool.baseAsset.id,
        price: pool.baseAsset.usdPrice,
        change_1h: (pool.baseAsset.stats1h?.priceChange ?? 0) / 100,
        change_5m: (pool.baseAsset.stats5m?.priceChange ?? 0) / 100,
        buy_volume_1h: pool.baseAsset.stats1h?.buyVolume ?? 0,
        sell_volume_1h: pool.baseAsset.stats1h?.sellVolume ?? 0,
        buy_volume_5m: pool.baseAsset.stats5m?.buyVolume ?? 0,
        sell_volume_5m: pool.baseAsset.stats5m?.sellVolume ?? 0,
        volume_1h: pool.baseAsset.stats1h?.buyVolume ?? 0,
        volume_5m: pool.baseAsset.stats5m?.buyVolume ?? 0,
        mcap: pool.baseAsset.mcap,
        logo_url: pool.baseAsset.icon,
        organic_score: pool.baseAsset.organicScore,
        last_updated: currentTime,
        created_at: normalizedCreatedAt
      }
    });

    // REMOVED: Filter logic - now returning all tokens unfiltered
    // const filteredTokens = transformedTokens.filter(token =>
    //   token.change_5m > -0.4 &&
    //   token.organic_score >= 70.0 &&
    //   token.mcap > 300000 &&
    //   token.mcap < 2000000
    // );

    // Use all transformed tokens instead of filtered ones
    const allTokens = transformedTokens;

    // Log timestamps for all tokens in the final set
    allTokens.forEach(token => {
      console.log(`Final token ${token.token_symbol} (${token.token_address}) created_at:`, {
        value: token.created_at,
        type: typeof token.created_at,
        parsedDate: token.created_at ? new Date(typeof token.created_at === 'number' ?
          (token.created_at > 1000000000000 ? token.created_at : token.created_at * 1000) :
          parseInt(token.created_at as any)).toString() : 'N/A'
      });
    });

    // Store the existing cache for comparison during full refresh
    const existingCache = needsFullRefresh ? new Map(tokenCache.tokens) : tokenCache.tokens;

    // Track changes for reporting
    const stats = {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      price_increased: 0,
      price_decreased: 0
    };

    // Create a new cache map for full refresh, or use existing for incremental
    const newTokenCache = needsFullRefresh ? new Map<string, TransformedToken>() : tokenCache.tokens;

    // Create a set of current token addresses for comparison
    const currentTokenAddresses = new Set<string>();
    allTokens.forEach(token => {
      currentTokenAddresses.add(token.token_address);

      const existingToken = existingCache.get(token.token_address);
      if (!existingToken) {
        // New token, add to cache and to newlyAddedTokens
        newTokenCache.set(token.token_address, token);
        stats.added++;
        newlyAddedTokens.push(token);
      } else {
        // Compare relevant fields to see if an update is needed
        if (
          token.price !== existingToken.price ||
          token.change_1h !== existingToken.change_1h ||
          token.change_5m !== existingToken.change_5m ||
          token.volume_1h !== existingToken.volume_1h ||
          token.mcap !== existingToken.mcap ||
          token.organic_score !== existingToken.organic_score
        ) {
          // Calculate price change percentage for tracking
          const priceChange = existingToken.price > 0
            ? (token.price - existingToken.price) / existingToken.price
            : 0;

          // Track price movement direction
          if (token.price > existingToken.price) {
            stats.price_increased++;
          } else if (token.price < existingToken.price) {
            stats.price_decreased++;
          }

          // Update only the changed token
          newTokenCache.set(token.token_address, {
            ...existingToken,
            price: token.price,
            change_1h: token.change_1h,
            change_5m: token.change_5m,
            volume_1h: token.volume_1h,
            mcap: token.mcap,
            organic_score: token.organic_score,
            last_updated: currentTime,
            price_change: priceChange,
            created_at: token.created_at ?? existingToken.created_at
          });
          stats.updated++;
        } else {
          // Token unchanged, but still add to new cache
          newTokenCache.set(token.token_address, {
            ...existingToken,
            last_updated: currentTime,
            created_at: token.created_at ?? existingToken.created_at
          });
          stats.unchanged++;
        }
      }
    });

    // Handle token removals
    if (!needsFullRefresh) {
      // Only perform removals during incremental updates
      for (const address of Array.from(existingCache.keys())) {
        if (!currentTokenAddresses.has(address)) {
          stats.removed++;
        }
      }
    } else {
      // During full refresh, count tokens that are no longer in the API response
      for (const address of Array.from(existingCache.keys())) {
        if (!currentTokenAddresses.has(address)) {
          stats.removed++;
        }
      }
    }

    // Update the cache with the new data
    tokenCache.tokens = newTokenCache;
    if (needsFullRefresh) {
      tokenCache.lastFullRefresh = currentTime;
      console.log('Cache fully refreshed');
    }

    // Remove tokens that are no longer in the results
    if (!needsFullRefresh) {
      // Only perform removals during incremental updates
      // During full refresh we already cleared the cache
      for (const address of Array.from(tokenCache.tokens.keys())) {
        if (!currentTokenAddresses.has(address)) {
          tokenCache.tokens.delete(address);
          stats.removed++;
        }
      }
    }

    // Update the cache timestamp and expiry
    tokenCache.timestamp = currentTime;
    tokenCache.expiresAt = currentTime + CACHE_TTL_MS;

    console.log(`Token cache updated: ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed, ${stats.unchanged} unchanged`);
    console.log(`Price movements: ${stats.price_increased} increased, ${stats.price_decreased} decreased`);

    // Soft cleanup: Mark stale tokens as 'stopped' instead of deleting
    const STALE_DAYS = 14;
    const now = Date.now();
    const staleCutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
    Array.from(tokenCache.tokens.values())
      .filter(token => token.last_updated && token.last_updated < staleCutoff && (token as any).status !== 'stopped')
      .forEach(token => {
        (token as any).status = 'stopped';
        (token as any).status_changed_at = new Date(now).toISOString();
      });
    // When calculating stats or returning tokens, filter out those with status 'stopped' from 'tracking' counts

    const tokenArray = Array.from(tokenCache.tokens.values());

    // Sort tokens by criteria - prioritize tokens with highest organic score and recent price change
    tokenArray.sort((a, b) => {
      // First by organic score (descending)
      if (b.organic_score !== a.organic_score) {
        return b.organic_score - a.organic_score;
      }
      // Then by absolute price change in the last hour (descending)
      return Math.abs(b.change_1h || 0) - Math.abs(a.change_1h || 0);
    });

    // Track MCap for tokens in the tracking range (30k-2M)
    const tokensInTrackingRange = tokenArray.filter(token => isInTrackingRange(token.mcap));
    let mcapTrackingResults: Map<string, any> = new Map(); // Initialize at function scope

    if (tokensInTrackingRange.length > 0) {
      console.log(`🎯 Tracking MCap for ${tokensInTrackingRange.length} tokens in range 30k-2M`);
      try {
        mcapTrackingResults = await bulkTrackTokenMcaps(
          tokensInTrackingRange.map(token => ({
            address: token.token_address,
            symbol: token.token_symbol,
            mcap: token.mcap
          }))
        );
        console.log(`✅ MCap tracking completed for ${mcapTrackingResults.size} tokens`);
      } catch (error) {
        console.error('❌ Error in MCap tracking:', error);
        // Continue execution even if MCap tracking fails
      }
    } else {
      console.log('ℹ️ No tokens in MCap tracking range (30k-2M)');
    }

    // List Discord: cron POST or route timer passes forceSendNotification=true; dedup is single gate
    if (forceSendNotification && acquireTrendingListNotificationSlot('trending_unfiltered')) {
      console.log('Sending scheduled Discord notification');
      lastAutoNotificationTime = currentTime;
      await sendDiscordNotification(
        tokenArray,
        stats,
        needsFullRefresh ? 'full' : 'incremental',
        forceSendNotification,
        newlyAddedTokens,
        mcapTrackingResults
      );
    } else if (forceSendNotification) {
      console.log('Skipping Discord notification — dedup cooldown active');
    }

    // Return all tokens (unfiltered) for API consumers
    return tokenArray;
  } catch (error) {
    console.error('Error in fetchAndUpdateCache:', error);
    throw error; // Re-throw to be handled by the calling function
  } finally {
    // The refresh state cleanup is handled by the calling function
    // No need to clean up here as it could interfere with concurrent requests
  }
}

// Export for use by filtered route
export { tokenCache, fetchAndUpdateCache }


// Function to get daily top performers for ranking
function getDailyTopPerformers(tokens: TransformedToken[], limit: number = 5): {
  topGainers: TransformedToken[],
  topVolume: TransformedToken[],
  topMcapGrowth: TransformedToken[]
} {
  // Filter tokens with valid data
  const validTokens = tokens.filter(token =>
    token.change_1h !== undefined &&
    token.volume_1h !== undefined &&
    token.mcap > 0
  );

  // Top gainers by 1h price change
  const topGainers = [...validTokens]
    .filter(token => token.change_1h > 0)
    .sort((a, b) => (b.change_1h || 0) - (a.change_1h || 0))
    .slice(0, limit);

  // Top volume tokens
  const topVolume = [...validTokens]
    .sort((a, b) => (b.volume_1h || 0) - (a.volume_1h || 0))
    .slice(0, limit);

  // Top MCap growth (if tracking data available)
  const topMcapGrowth = [...validTokens]
    .filter(token => token.mcap >= 30_000 && token.mcap <= 2_000_000) // Only tracked range
    .sort((a, b) => (b.change_1h || 0) - (a.change_1h || 0))
    .slice(0, limit);

  return { topGainers, topVolume, topMcapGrowth };
}

// Function to create daily ranking section for Discord
function createDailyRankingSection(
  tokens: TransformedToken[],
  mcapTrackingResults?: Map<string, any>
): { name: string; value: string } | null {
  let rankingText = ''

  // Tracker-based Top Gainers only (by mcap_growth_percent). No price-change fallback.
  const nowMs = Date.now()
  const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
  const trackerTop = mcapTrackingResults && mcapTrackingResults.size > 0
    ? Array.from(mcapTrackingResults.entries())
      .filter(([_, tracking]) => {
        const hasGrowth = isFinite(tracking.growthPercent) && tracking.growthPercent > 0
        const firstSeenMs = tracking.firstSeenAt ? new Date(tracking.firstSeenAt).getTime() : 0
        const within24h = firstSeenMs > 0 && (nowMs - firstSeenMs) <= MAX_AGE_MS
        return hasGrowth && within24h
      })
      .sort((a, b) => (b[1].growthPercent || 0) - (a[1].growthPercent || 0))
      .slice(0, 10)
    : []

  if (trackerTop.length === 0) {
    return null
  }

  rankingText += '🏆 **Top Gainers (MCap Tracker)**\n'
  trackerTop.forEach(([tokenAddress, tracking], index) => {
    const token = tokens.find(t => t.token_address === tokenAddress)
    const symbol = token?.token_symbol || 'UNKNOWN'
    const chartLink = `https://reloadsol.app/chart/${tokenAddress}`
    const growthStr = `${tracking.growthPercent >= 0 ? '+' : ''}${(tracking.growthPercent || 0).toFixed(1)}%`
    const currentStr = isFinite(tracking.currentMcap)
      ? Number(tracking.currentMcap).toLocaleString('en-US', { maximumFractionDigits: 3 })
      : '0'
    const firstStr = isFinite(tracking.firstMcap)
      ? Number(tracking.firstMcap).toLocaleString('en-US', { maximumFractionDigits: 3 })
      : '0'
    const timeStr = formatAppDateTimeWithZone(tracking.firstSeenAt)
    rankingText += `${index + 1}. [${symbol}](${chartLink}) ${growthStr} | $${currentStr} | from $${firstStr}${timeStr ? ` | ${timeStr}` : ''}\n`
  })

  // Note: Remove "🚀 MCap Growth Leaders" since it is similar to tracker-based Top Gainers

  // Truncate to stay within Discord field limits
  const truncated = truncateFieldValue(rankingText)

  return {
    name: '🎯 Daily Token Rankings',
    value: truncated.trim() || 'No significant performers today'
  }
}

// Function to calculate daily statistics
function calculateDailyStats(tokens: TransformedToken[]): {
  totalTokens: number,
  avgGrowth: number,
  topGainerPercent: number,
  totalVolume: number,
  activeTokens: number
} {
  const validTokens = tokens.filter(token =>
    token.change_1h !== undefined &&
    token.volume_1h !== undefined &&
    token.mcap > 0 &&
    !isNaN(token.change_1h) &&
    !isNaN(token.volume_1h) &&
    isFinite(token.change_1h) &&
    isFinite(token.volume_1h)
  );

  const totalTokens = validTokens.length;

  // Safe calculation of average growth
  let avgGrowth = 0;
  if (totalTokens > 0) {
    const growthSum = validTokens.reduce((sum, token) => {
      const change = token.change_1h || 0;
      return sum + (isFinite(change) ? change : 0);
    }, 0);
    avgGrowth = (growthSum / totalTokens) * 100;
  }

  // Safe calculation of top gainer percent
  let topGainerPercent = 0;
  if (validTokens.length > 0) {
    const changes = validTokens
      .map(token => (token.change_1h || 0) * 100)
      .filter(change => isFinite(change));

    if (changes.length > 0) {
      topGainerPercent = Math.max(...changes);
    }
  }

  // Safe calculation of total volume
  const totalVolume = validTokens.reduce((sum, token) => {
    const volume = token.volume_1h || 0;
    return sum + (isFinite(volume) ? volume : 0);
  }, 0);

  const activeTokens = validTokens.filter(token => {
    const volume = token.volume_1h || 0;
    return isFinite(volume) && volume > 100;
  }).length;

  // Ensure all returned values are finite
  return {
    totalTokens: isFinite(totalTokens) ? totalTokens : 0,
    avgGrowth: isFinite(avgGrowth) ? avgGrowth : 0,
    topGainerPercent: isFinite(topGainerPercent) ? topGainerPercent : 0,
    totalVolume: isFinite(totalVolume) ? totalVolume : 0,
    activeTokens: isFinite(activeTokens) ? activeTokens : 0
  };
}

// Function to create daily summary header
function createDailySummaryHeader(tokens: TransformedToken[], mcapTrackingResults?: Map<string, any>): string {
  const dailyStats = calculateDailyStats(tokens);

  const currentTime = new Date();
  const timeStr = currentTime.toLocaleTimeString('en-US', {
    hour12: false,
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit'
  });

  // Safe formatting with validation
  const formatPercent = (value: number): string => {
    if (!isFinite(value) || isNaN(value)) return '0.0';
    return value.toFixed(1);
  };

  const formatNumber = (value: number): number => {
    if (!isFinite(value) || isNaN(value)) return 0;
    return value;
  };

  let summaryLines = [
    `🏆 **Daily Market Summary** (${timeStr} GMT+7)`,
    `📊 **Overview:** ${formatNumber(dailyStats.totalTokens)} tokens tracked | ${formatNumber(dailyStats.activeTokens)} active (>$100 vol)`,
    `📈 **Performance:** Avg ${dailyStats.avgGrowth >= 0 ? '+' : ''}${formatPercent(dailyStats.avgGrowth)}% | Best: +${formatPercent(dailyStats.topGainerPercent)}%`
  ];

  // Add tracker-based top gainer if available; restricted to firstSeenAt within 24h; no price-change fallback
  if (mcapTrackingResults && mcapTrackingResults.size > 0) {
    const nowMs = Date.now()
    const MAX_AGE_MS = 24 * 60 * 60 * 1000
    const trackerTop = Array.from(mcapTrackingResults.entries())
      .filter(([_, tracking]) => {
        const hasGrowth = isFinite(tracking.growthPercent) && tracking.growthPercent > 0
        const firstSeenMs = tracking.firstSeenAt ? new Date(tracking.firstSeenAt).getTime() : 0
        const within24h = firstSeenMs > 0 && (nowMs - firstSeenMs) <= MAX_AGE_MS
        return hasGrowth && within24h
      })
      .sort((a, b) => (b[1].growthPercent || 0) - (a[1].growthPercent || 0))
      .slice(0, 1)

    if (trackerTop.length > 0) {
      const [tokenAddress, tracking] = trackerTop[0]
      const token = tokens.find(t => t.token_address === tokenAddress)
      const symbol = token?.token_symbol || 'UNKNOWN'
      const growthStr = `${tracking.growthPercent >= 0 ? '+' : ''}${formatPercent(tracking.growthPercent || 0)}`
      const currentStr = isFinite(tracking.currentMcap) ? Number(tracking.currentMcap).toLocaleString('en-US', { maximumFractionDigits: 3 }) : '0'
      const firstStr = isFinite(tracking.firstMcap) ? Number(tracking.firstMcap).toLocaleString('en-US', { maximumFractionDigits: 3 }) : '0'
      const dtStr = formatAppDateTimeWithZone(tracking.firstSeenAt)
      summaryLines.push(`🚀 **Top Gainer:** ${symbol} (${growthStr}) | $${currentStr} | from $${firstStr}${dtStr ? ` | ${dtStr}` : ''}`)
    }
  }

  return summaryLines.join('\n');
}