import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'

// Environment variable for Discord webhook URL
const DISCORD_WEBHOOK_URL =
  process.env.NODE_ENV === 'development'
    ? process.env.DISCORD_WEBHOOK_URL_DEV || process.env.DISCORD_WEBHOOK_URL
    : process.env.DISCORD_WEBHOOK_URL;
const ENABLE_DISCORD_NOTIFICATIONS = process.env.ENABLE_DISCORD_NOTIFICATIONS === 'true';

// Add auto-notification interval (default 10 minute = 600000ms)
const AUTO_NOTIFICATION_INTERVAL_MS = parseInt(process.env.AUTO_NOTIFICATION_INTERVAL_MS || '600000');

// Track last auto notification time
let lastAutoNotificationTime = 0;

// Global cleanup tracking
let globalTimers: {
  notificationTimer?: NodeJS.Timeout;
  initialDelayTimer?: NodeJS.Timeout;
} = {};

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

// Set up a timer to send notifications on schedule if enabled
// Only initialize once and with proper cleanup
if (typeof process !== 'undefined' && ENABLE_DISCORD_NOTIFICATIONS && !globalTimers.notificationTimer) {
  console.log(`Setting up automatic notification timer (${AUTO_NOTIFICATION_INTERVAL_MS}ms interval)`);
  
  // Initial delay of 30 seconds after server start before first check
  globalTimers.initialDelayTimer = setTimeout(() => {
    console.log('Starting automatic notification timer');
    
    // Set interval for periodic notifications
    globalTimers.notificationTimer = setInterval(() => {
      const currentTime = Date.now();
      
      // Check if it's time for a notification
      if (currentTime - lastAutoNotificationTime >= AUTO_NOTIFICATION_INTERVAL_MS) {
        console.log('Auto-notification interval triggered');
        
        // Determine if we need a full refresh
        const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS;
        
        // Trigger notification with proper error handling
        fetchAndUpdateCache(needsFullRefresh, currentTime, true)
          .then(tokenArray => {
            console.log(`Scheduled notification completed with ${tokenArray.length} tokens`);
          })
          .catch(error => {
            console.error('Error in scheduled notification:', error);
            // Reset refresh state on error to prevent permanent blocking
            refreshState.promise = null;
            refreshState.timeout = null;
          });
      }
    }, Math.min(60000, AUTO_NOTIFICATION_INTERVAL_MS / 2)); // Check at least every minute or half the notification interval
    
    // Clear the initial delay timer reference
    globalTimers.initialDelayTimer = undefined;
  }, 30000);
}

// Handle process termination gracefully
if (typeof process !== 'undefined') {
  process.on('SIGTERM', cleanupGlobalTimers);
  process.on('SIGINT', cleanupGlobalTimers);
  process.on('exit', cleanupGlobalTimers);
}

interface JupiterBaseAsset {
  id: string
  name: string
  symbol: string
  icon: string
  decimals: number
  usdPrice: number
  stats1h: {
    priceChange: number
    numNetBuyers: number
    buyVolume: number
  }
  stats5m: {
    priceChange: number
  }
  mcap: number
  organicScore: number
}

interface JupiterPool {
  id: string
  baseAsset: JupiterBaseAsset
  volume24h: number
  createdAt: string | number
}

interface JupiterResponse {
  pools: JupiterPool[]
}

interface TransformedToken {
  token_symbol: string
  token_address: string
  price: number
  change_1h: number
  change_5m: number
  volume_1h: number
  mcap: number
  logo_url?: string
  organic_score: number
  last_updated?: number
  price_change?: number 
  created_at?: number
}

// Cache structure to store tokens with a timestamp
interface TokenCache {
  tokens: Map<string, TransformedToken>; // Using Map for O(1) lookups by token_address
  timestamp: number;
  expiresAt: number;
  lastFullRefresh: number;
}

// In-memory cache with 5-minute expiry
let tokenCache: TokenCache = {
  tokens: new Map<string, TransformedToken>(),
  timestamp: 0,
  expiresAt: 0,
  lastFullRefresh: 0
};

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
  forceSend: boolean = false
) {
  if (!ENABLE_DISCORD_NOTIFICATIONS || !DISCORD_WEBHOOK_URL) {
    console.log('Discord notifications disabled or webhook URL not configured');
    return;
  }

  // Skip notification if not forced and no meaningful changes
  if (!forceSend && stats.added === 0 && stats.updated === 0 && stats.removed === 0) {
    console.log('No changes to report to Discord');
    return;
  }

  try {
    // Get top 5 tokens by organic score
    const topTokens = tokenArray.slice(0, 5);
    
    // Format the message
    const message = {
      embeds: [
        {
          title: `Token Update (${refreshType})`,
          description: `**Summary:** ${stats.added} added, ${stats.updated} updated, ${stats.removed} removed\n**Price movements:** ${stats.price_increased} increased, ${stats.price_decreased} decreased`,
          color: 3447003, // Blue color
          timestamp: new Date().toISOString(),
          fields: [
            {
              name: 'Top Tokens',
              value: topTokens.map(token => {
                const priceChangeEmoji = token.price_change 
                  ? (token.price_change > 0 ? '📈' : '📉') 
                  : '';
                const hourChangeEmoji = token.change_1h 
                  ? (token.change_1h > 0 ? '🟢' : '🔴') 
                  : '';
                
                return `**${token.token_symbol}** ${priceChangeEmoji}\n` +
                  `Price: $${token.price.toFixed(6)} ${hourChangeEmoji} ${(token.change_1h * 100).toFixed(2)}%\n` +
                  `Score: ${token.organic_score.toFixed(1)}, MCap: $${(token.mcap).toLocaleString()}\n`;
              }).join('\n')
            }
          ],
          footer: {
            text: 'Buy Bulk Token Tracker'
          }
        }
      ]
    };

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
        throw new Error(`Discord API responded with status: ${response.status}`);
      }

      console.log('Discord notification sent successfully');
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  } catch (error) {
    console.error('Error sending Discord notification:', error);
    // Don't throw the error to avoid disrupting the main flow
  }
}

// Add a POST endpoint for scheduled notifications from cron jobs
export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const secretKey = searchParams.get('key');
    const expectedSecretKey = process.env.NOTIFICATION_SECRET_KEY;
    
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

export async function GET(request: NextRequest) {
  try {
    const currentTime = Date.now();
    
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const skipCache = searchParams.get('nocache') === 'true';
    
    const needsFullRefresh = currentTime - tokenCache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS || forceRefresh;
    
    // Return cached data if it's still valid and doesn't need a full refresh
    if (tokenCache.tokens.size > 0 && currentTime < tokenCache.expiresAt && !needsFullRefresh && !skipCache) {
      console.log('Using cached token data, expires in', Math.round((tokenCache.expiresAt - currentTime) / 1000), 'seconds');
      return NextResponse.json(
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
      )
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
          
          return NextResponse.json(
            { 
              tokens,
              cached: false,
              cache_age: 0,
              refresh_type: 'concurrent',
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
          )
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
      
      return NextResponse.json(
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
      )
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
    const response = await fetch('https://datapi.jup.ag/v1/pools/toptrending/1h', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
      // Ensure we're not using a stale response from the browser cache
      next: { revalidate: 0 } // Force fresh data from API
    });

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json() as JupiterResponse;
    
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
        volume_1h: pool.baseAsset.stats1h.buyVolume,
      mcap: pool.baseAsset.mcap,
      logo_url: pool.baseAsset.icon,
      organic_score: pool.baseAsset.organicScore,
      last_updated: currentTime,
        created_at: normalizedCreatedAt
      }
    });
    
    // Filter out tokens with extreme negative price movement (less than -40%) and low organic score
    const filteredTokens = transformedTokens.filter(token => 
      token.change_5m > -0.4 && 
      token.organic_score >= 70.0 &&
      token.mcap > 300000 &&
      token.mcap < 2000000
    );
    
    // Log timestamps for all tokens in the final set
    filteredTokens.forEach(token => {
      console.log(`Final token ${token.token_symbol} (${token.token_address}) created_at:`, {
        value: token.created_at,
        type: typeof token.created_at,
        parsedDate: token.created_at ? new Date(typeof token.created_at === 'number' ? 
          (token.created_at > 1000000000000 ? token.created_at : token.created_at * 1000) : 
          parseInt(token.created_at as any)).toString() : 'N/A'
      });
    });
    
    // If doing a full refresh, reset the cache
    if (needsFullRefresh) {
      tokenCache.tokens = new Map<string, TransformedToken>();
      tokenCache.lastFullRefresh = currentTime;
      console.log('Cache fully refreshed');
    }
    
    // Track changes for reporting
    const stats = {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      price_increased: 0,
      price_decreased: 0
    };
    
    // Create a set of current token addresses for comparison
    const currentTokenAddresses = new Set<string>();
    filteredTokens.forEach(token => {
      currentTokenAddresses.add(token.token_address);
      
      const existingToken = tokenCache.tokens.get(token.token_address);
      if (!existingToken) {
        // New token, add to cache
        tokenCache.tokens.set(token.token_address, token);
        stats.added++;
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
          tokenCache.tokens.set(token.token_address, {
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
          stats.unchanged++;
        }
      }
    });
    
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
    
    // Only send notification if this is a scheduled run or forced notification
    // Regular frontend API calls will no longer trigger notifications
    const shouldSendNotification = 
      (currentTime - lastAutoNotificationTime >= AUTO_NOTIFICATION_INTERVAL_MS) || 
      forceSendNotification;
    
    if (shouldSendNotification) {
      console.log('Sending scheduled Discord notification');
      lastAutoNotificationTime = currentTime;
      await sendDiscordNotification(
        tokenArray, 
        stats, 
        needsFullRefresh ? 'full' : 'incremental',
        forceSendNotification
      );
    } else {
      console.log('Skipping Discord notification - not on schedule');
    }
    
    return tokenArray;
  } catch (error) {
    console.error('Error in fetchAndUpdateCache:', error);
    throw error; // Re-throw to be handled by the calling function
  } finally {
    // The refresh state cleanup is handled by the calling function
    // No need to clean up here as it could interfere with concurrent requests
  }
}