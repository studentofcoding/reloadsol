import { supabase } from '@/utils/supabase'
import { log } from '@/utils/unified-logger'

export type TokenLabel = 'valid' | 'traded_live' | 'potential' | 'rugged'

export interface McapSnapshot {
  token_address: string
  token_symbol: string
  first_mcap: number
  current_mcap: number
  first_seen_at: string
  last_updated_at: string
  mcap_growth_percent: number
  when_reach_80mc?: string | null
  when_reach_120mc?: string | null
  when_reach_200mc?: string | null
  is_tracking_stuck?: boolean
  label?: TokenLabel | null
}

export interface McapTrackingResult {
  isFirstTime: boolean
  firstMcap?: number
  currentMcap: number
  growthPercent?: number
  formattedGrowth?: string
  firstSeenAt?: string
}

// Cache for MCap data to avoid frequent database calls
const mcapCache = new Map<string, McapSnapshot>()
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 minutes cache

// Update stuck detection defaults to 6 hours (env override still applies)
const STUCK_MIN_AGE_MS = parseInt(process.env.MCAP_STUCK_MIN_AGE_MS || '21600000') // 6 hours
const STUCK_EPSILON_PERCENT = parseFloat(process.env.MCAP_STUCK_EPSILON_PERCENT || '0.01') // 0.01%

export const STOP_LOSS_THRESHOLD = parseFloat(
  process.env.MCAP_STOP_LOSS_THRESHOLD || process.env.NEXT_PUBLIC_MCAP_STOP_LOSS_THRESHOLD || '-50'
) // -50%

// New: maximum tracking age (default 4 days)
export const MAX_TRACKING_AGE_MS = parseInt(process.env.MCAP_MAX_TRACKING_AGE_MS || '345600000')

// One-time configuration log for ops visibility
log.info('mcap_tracker', 'MCap tracker configuration', {
  stuckMinAgeMs: STUCK_MIN_AGE_MS,
  stuckEpsilonPercent: STUCK_EPSILON_PERCENT,
  stopLossThreshold: STOP_LOSS_THRESHOLD,
  cacheTtlMs: CACHE_TTL_MS,
  maxTrackingAgeMs: MAX_TRACKING_AGE_MS
})

// Growth thresholds for notifications (in percentages)
const GROWTH_THRESHOLDS = [80, 120, 200]

// Discord webhook configuration
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_AUTO_TRADE || process.env.DISCORD_WEBHOOK_URL || ''
const ENABLE_MCAP_NOTIFICATIONS = process.env.ENABLE_MCAP_NOTIFICATIONS === 'true'

// Helper function to check if notifications should be enabled
function shouldEnableNotifications(): boolean {
  const webhookUrl = DISCORD_WEBHOOK_URL
  const enabled = ENABLE_MCAP_NOTIFICATIONS && webhookUrl !== ''

  log.debug('discord_notification', 'MCap notification status check', {
    enabled,
    webhookConfigured: !!webhookUrl,
    mcapNotificationsEnabled: ENABLE_MCAP_NOTIFICATIONS
  })

  return enabled
}

// Helper function to convert MCap to integer (round to nearest dollar)
function normalizeMarketCap(mcap: number): number {
  return Math.round(mcap)
}

// Helper function to format timestamp to GMT+7
function formatTimestampGMT7(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  // GMT+7 is UTC+7, so add 7 hours
  const gmt7Date = new Date(date.getTime() + (7 * 60 * 60 * 1000))

  const hours = gmt7Date.getUTCHours().toString().padStart(2, '0')
  const minutes = gmt7Date.getUTCMinutes().toString().padStart(2, '0')

  return `${hours}:${minutes} GMT+7`
}

// Helper function to get threshold column name
type ThresholdColumnName = 'when_reach_80mc' | 'when_reach_120mc' | 'when_reach_200mc'

function getThresholdColumnName(threshold: number): ThresholdColumnName {
  switch (threshold) {
    case 80: return 'when_reach_80mc'
    case 120: return 'when_reach_120mc'
    case 200: return 'when_reach_200mc'
    default: throw new Error(`Unknown threshold: ${threshold}`)
  }
}

// Helper function to check if threshold notification was already sent (within 24 hours)
function wasThresholdNotified(record: McapSnapshot, threshold: number): boolean {
  const columnName = getThresholdColumnName(threshold)
  const notificationTime = record[columnName]

  if (!notificationTime) {
    return false
  }

  // Check if notification was sent within the last 24 hours
  const notificationDate = new Date(notificationTime)
  const now = new Date()
  const hoursSinceNotification = (now.getTime() - notificationDate.getTime()) / (1000 * 60 * 60)

  return hoursSinceNotification < 24
}

// Helper: update threshold timestamp fields when growth crosses thresholds
function updateThresholdTimestamps(record: McapSnapshot, growthPercent: number, nowIso: string): boolean {
  let changed = false
  for (const threshold of GROWTH_THRESHOLDS) {
    const columnName = getThresholdColumnName(threshold)
    const alreadySet = !!record[columnName]
    if (growthPercent >= threshold && !alreadySet) {
      record[columnName] = nowIso
      changed = true
    }
  }
  return changed
}

// Function to send Discord notification for growth threshold
async function sendGrowthThresholdNotification(params: {
  tokenAddress: string
  tokenSymbol: string
  threshold: number
  currentMcap: number
  firstMcap: number
  growthPercent: number
  firstSeenAt: string
}): Promise<void> {
  if (!shouldEnableNotifications()) {
    return
  }

  const {
    tokenAddress,
    tokenSymbol,
    threshold,
    currentMcap,
    firstMcap,
    growthPercent,
    firstSeenAt
  } = params

  try {
    const chartLink = `https://v2.reloadsol.xyz/chart/${tokenAddress}`
    const reloadSolLink = `https://v2.reloadsol.xyz/buy?sol=0.1&mints=${tokenAddress}`

    // Determine emoji and color based on threshold
    let emoji = '🚀'
    let color = 3447003 // Blue

    if (threshold >= 200) {
      emoji = '🌟'
      color = 16776960 // Gold
    } else if (threshold >= 120) {
      emoji = '🔥'
      color = 16753920 // Orange
    }

    const message = {
      embeds: [
        {
          title: `${emoji} Market Cap Growth Alert - ${threshold}%+`,
          description: `**${tokenSymbol}** has reached **${growthPercent.toFixed(1)}%** growth! @everyone`,
          color,
          timestamp: new Date().toISOString(),
          fields: [
            {
              name: '📊 Market Cap Details',
              value: `**Current:** $${currentMcap.toLocaleString()}\n**Initial:** $${firstMcap.toLocaleString()}\n**Growth:** +${growthPercent.toFixed(1)}% (${formatGrowthPercent(growthPercent)})`,
              inline: true
            },
            {
              name: '⏰ Timeline',
              value: `**First Seen:** ${formatTimestampGMT7(firstSeenAt)}\n**Alert Time:** ${formatTimestampGMT7(new Date().toISOString())}`,
              inline: true
            },
            {
              name: '🔗 Quick Actions',
              value: `[📈 View Chart](${chartLink})\n[💰 Trade on reloadSOL](${reloadSolLink})`,
              inline: false
            }
          ],
          footer: {
            text: `MCap Growth Tracker | Threshold: ${threshold}%`
          }
        }
      ]
    }

    log.info('discord_notification', 'Sending growth threshold notification', {
      tokenSymbol,
      tokenAddress,
      threshold,
      growthPercent
    })

    // Send the message to Discord with timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error response')
        throw new Error(`Discord API responded with status: ${response.status} - ${errorText}`)
      }

      log.info('discord_notification', 'Growth threshold notification sent successfully', {
        tokenSymbol,
        threshold,
        growthPercent
      })

    } catch (error) {
      clearTimeout(timeoutId)
      log.error('discord_notification', 'Error sending growth threshold notification', error as Error, {
        tokenSymbol,
        tokenAddress,
        threshold
      })
      throw error
    }
  } catch (error) {
    log.error('discord_notification', 'Error in sendGrowthThresholdNotification', error as Error, {
      tokenSymbol,
      tokenAddress,
      threshold
    })
  }
}

// Helper function to check and send threshold notifications
async function checkAndSendThresholdNotifications(
  record: McapSnapshot,
  tokenSymbol: string,
  currentMcap: number,
  firstMcap: number,
  growthPercent: number,
  firstSeenAt: string
): Promise<boolean> {
  if (!shouldEnableNotifications() || growthPercent <= 0) {
    return false
  }

  let notificationSent = false

  // Check each threshold
  for (const threshold of GROWTH_THRESHOLDS) {
    if (growthPercent >= threshold) {
      // Check recent notification from dedicated table
      let recentlyNotified = false
      try {
        const { data, error } = await supabase
          .from('mcap_threshold_notifications')
          .select('notified_at')
          .eq('token_address', record.token_address)
          .eq('threshold', threshold)
          .order('notified_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (error) throw error
        if (data?.notified_at) {
          const notifiedAt = new Date(data.notified_at).getTime()
          const hoursSince = (Date.now() - notifiedAt) / (1000 * 60 * 60)
          recentlyNotified = hoursSince < 24
        }
      } catch (e) {
        log.error('discord_notification', 'Failed checking notification history', e as Error, {
          tokenAddress: record.token_address,
          threshold
        })
      }

      if (!recentlyNotified) {
        log.info('discord_notification', 'Growth threshold reached', {
          tokenSymbol,
          tokenAddress: record.token_address,
          threshold,
          growthPercent
        })

        // Send notification
        await sendGrowthThresholdNotification({
          tokenAddress: record.token_address,
          tokenSymbol,
          threshold,
          currentMcap,
          firstMcap,
          growthPercent,
          firstSeenAt
        })

        // Record notification
        try {
          const { error } = await supabase
            .from('mcap_threshold_notifications')
            .insert({
              token_address: record.token_address,
              token_symbol: tokenSymbol,
              threshold,
              growth_percent: growthPercent,
              notified_at: new Date().toISOString()
            })
          if (error) throw error
        } catch (e) {
          log.error('discord_notification', 'Failed recording threshold notification', e as Error, {
            tokenAddress: record.token_address,
            threshold
          })
        }

        notificationSent = true
      }
    }
  }

  return notificationSent
}

// Function to track MCap for a token
export async function trackTokenMcap(
  tokenAddress: string,
  tokenSymbol: string,
  currentMcap: number
): Promise<McapTrackingResult> {
  // Validate input data
  if (!currentMcap || currentMcap <= 0) {
    console.warn('Invalid MCap value for tracking:', { tokenAddress, currentMcap })
    return { isFirstTime: true, currentMcap: 0 }
  }

  try {
    // Normalize MCap to integer
    const normalizedCurrentMcap = normalizeMarketCap(currentMcap)

    // Invocation log (debug-level; high-rate path)
    log.debug('price_tracking', 'Track invocation start', {
      tokenAddress,
      tokenSymbol,
      currentMcap: normalizedCurrentMcap
    })

    // Check cache first
    const cached = mcapCache.get(tokenAddress)
    const now = Date.now()

    // If we have cached data, check max tracking age first
    if (cached) {
      const ageMs = now - new Date(cached.first_seen_at).getTime()
      if (ageMs >= MAX_TRACKING_AGE_MS) {
        log.info('price_tracking', 'Max tracking age reached - finishing (cached path)', {
          tokenAddress,
          tokenSymbol,
          ageHours: Math.round(ageMs / (1000 * 60 * 60)),
        })
        // Stop tracking: remove from cache and return current snapshot without DB writes
        mcapCache.delete(tokenAddress)
        return {
          isFirstTime: false,
          firstMcap: cached.first_mcap,
          currentMcap: cached.current_mcap,
          growthPercent: cached.mcap_growth_percent,
          formattedGrowth: formatGrowthPercent(cached.mcap_growth_percent),
          firstSeenAt: cached.first_seen_at
        }
      }
    }

    // Configurable thresholds (perf-sensible defaults)
    const HEARTBEAT_INTERVAL_MS = parseInt(process.env.MCAP_HEARTBEAT_MS || '600000') // 10 minutes
    const MIN_CHANGE_PERCENT = parseFloat(process.env.MCAP_MIN_CHANGE_PERCENT || '0.1') // 0.1%
    const DB_WRITE_PERCENT = parseFloat(process.env.MCAP_DB_WRITE_PERCENT || '1') // 1%
    // Removed STUCK_MIN_AGE_MS and STUCK_EPSILON_PERCENT here; use module-scope constants

    if (cached && (now - new Date(cached.last_updated_at).getTime()) < CACHE_TTL_MS) {
      // Use cached data but update current MCap if different
      const absDelta = Math.abs(cached.current_mcap - normalizedCurrentMcap)
      const dbWriteThreshold = cached.current_mcap * (DB_WRITE_PERCENT / 100)
      const timeSinceLastDbUpdate = now - new Date(cached.last_updated_at).getTime()

      if (absDelta > dbWriteThreshold) {
        const previousGrowthPercent = cached.mcap_growth_percent
        cached.current_mcap = normalizedCurrentMcap
        cached.last_updated_at = new Date().toISOString()
        cached.mcap_growth_percent = ((normalizedCurrentMcap - cached.first_mcap) / cached.first_mcap) * 100

        // Update threshold timestamps independent of notifications
        const thresholdsUpdated = updateThresholdTimestamps(cached, cached.mcap_growth_percent, cached.last_updated_at)

        // Compute stuck flag
        const ageMs = now - new Date(cached.first_seen_at).getTime()
        const isZero = Math.abs(cached.mcap_growth_percent) <= STUCK_EPSILON_PERCENT
        const prevStuck = cached.is_tracking_stuck === true
        cached.is_tracking_stuck = isZero && ageMs >= STUCK_MIN_AGE_MS

        if (prevStuck !== cached.is_tracking_stuck) {
          log.info('price_tracking', 'Stuck status changed (cached path)', {
            tokenAddress,
            tokenSymbol,
            is_tracking_stuck: cached.is_tracking_stuck,
            growthPercent: cached.mcap_growth_percent,
            ageMs
          })
        }

        // Check for threshold notifications
        const notificationSent = await checkAndSendThresholdNotifications(
          cached,
          tokenSymbol,
          cached.current_mcap,
          cached.first_mcap,
          cached.mcap_growth_percent,
          cached.first_seen_at
        )

        // Update database asynchronously (include threshold columns if thresholdsUpdated or notifications were sent)
        updateMcapInDatabase(cached, thresholdsUpdated || notificationSent).catch(console.error)
      } else if (timeSinceLastDbUpdate >= HEARTBEAT_INTERVAL_MS) {
        // Heartbeat: update without threshold columns, and record latest currentMcap and growth
        const prev = { current: cached.current_mcap, growth: cached.mcap_growth_percent }
        cached.current_mcap = normalizedCurrentMcap
        cached.mcap_growth_percent = ((normalizedCurrentMcap - cached.first_mcap) / cached.first_mcap) * 100
        cached.last_updated_at = new Date().toISOString()

        // Update threshold timestamps on heartbeat as well
        const thresholdsUpdatedHb = updateThresholdTimestamps(cached, cached.mcap_growth_percent, cached.last_updated_at)

        // Compute stuck flag on heartbeat
        const ageMs = now - new Date(cached.first_seen_at).getTime()
        const isZero = Math.abs(cached.mcap_growth_percent) <= STUCK_EPSILON_PERCENT
        const prevStuck = cached.is_tracking_stuck === true
        cached.is_tracking_stuck = isZero && ageMs >= STUCK_MIN_AGE_MS

        if (prevStuck !== cached.is_tracking_stuck) {
          log.info('price_tracking', 'Stuck status changed (heartbeat cached path)', {
            tokenAddress,
            tokenSymbol,
            is_tracking_stuck: cached.is_tracking_stuck,
            growthPercent: cached.mcap_growth_percent,
            ageMs
          })
        }

        updateMcapInDatabase(cached, thresholdsUpdatedHb).catch(console.error)
        log.info('price_tracking', 'Heartbeat DB write executed', {
          tokenAddress,
          tokenSymbol,
          prevCurrentMcap: prev.current,
          newCurrentMcap: cached.current_mcap,
          prevGrowth: prev.growth,
          newGrowth: cached.mcap_growth_percent,
          timeSinceLastDbUpdate
        })
      } else {
        // Skip small change in cached path; just return cached snapshot
        log.info('price_tracking', 'Skip: cached path small-change or db-write gating', {
          tokenAddress,
          tokenSymbol,
          absDelta,
          dbWriteThreshold,
          timeSinceLastDbUpdate,
          heartbeatInterval: HEARTBEAT_INTERVAL_MS
        })
      }

      return {
        isFirstTime: false,
        firstMcap: cached.first_mcap,
        currentMcap: cached.current_mcap,
        growthPercent: cached.mcap_growth_percent,
        formattedGrowth: formatGrowthPercent(cached.mcap_growth_percent),
        firstSeenAt: cached.first_seen_at
      }
    }

    // Check database for existing record (robust handling)
    let existingRecord: McapSnapshot | null = null
    try {
      const { data, error } = await supabase
        .from('token_mcap_tracking')
        .select('*')
        .eq('token_address', tokenAddress)
        .order('last_updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        throw error
      }
      existingRecord = (data as any) ?? null
    } catch (fetchErr: any) {
      // Only degrade on transient fetch/network failures
      const message = String(fetchErr?.message ?? '').toLowerCase()
      const codeOrName = String(fetchErr?.code ?? fetchErr?.name ?? '').toLowerCase()
      const isTransient =
        message.includes('fetch failed') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('socket hang up') ||
        codeOrName.includes('abort') ||
        codeOrName.includes('econnreset') ||
        codeOrName.includes('etimedout') ||
        codeOrName.includes('enotfound') ||
        codeOrName.includes('eai_again')
      log.error('price_tracking', 'Error fetching MCap record', fetchErr as Error, {
        tokenAddress,
        tokenSymbol,
        currentMcap: normalizedCurrentMcap,
        transient: isTransient,
      })
      if (isTransient) {
        // Graceful degrade: proceed as first-time to avoid blocking tracking when DB is briefly unavailable
        return { isFirstTime: true, currentMcap: normalizedCurrentMcap }
      }
      throw fetchErr
    }

    const currentTime = new Date().toISOString()

    // Prevent too frequent updates
    if (existingRecord) {
      const timeSinceLastUpdate = new Date().getTime() - new Date(existingRecord.last_updated_at).getTime()
      const minUpdateInterval = 60000 // 1 minute minimum

      // Check max tracking age on DB path before any updates
      const ageMsDb = Date.now() - new Date(existingRecord.first_seen_at).getTime()
      if (ageMsDb >= MAX_TRACKING_AGE_MS) {
        log.info('price_tracking', 'Max tracking age reached - finishing (db path)', {
          tokenAddress,
          tokenSymbol,
          ageHours: Math.round(ageMsDb / (1000 * 60 * 60)),
        })
        // Ensure no further tracking; clear any cache entry
        mcapCache.delete(tokenAddress)
        return {
          isFirstTime: false,
          firstMcap: existingRecord.first_mcap,
          currentMcap: existingRecord.current_mcap,
          growthPercent: existingRecord.mcap_growth_percent,
          formattedGrowth: formatGrowthPercent(existingRecord.mcap_growth_percent),
          firstSeenAt: existingRecord.first_seen_at
        }
      }

      if (timeSinceLastUpdate < minUpdateInterval) {
        log.info('price_tracking', 'Skip: min-interval gating', {
          tokenAddress,
          tokenSymbol,
          timeSinceLastUpdate,
          minUpdateInterval
        })
        return {
          isFirstTime: false,
          firstMcap: existingRecord.first_mcap,
          currentMcap: existingRecord.current_mcap,
          growthPercent: existingRecord.mcap_growth_percent,
          formattedGrowth: formatGrowthPercent(existingRecord.mcap_growth_percent),
          firstSeenAt: existingRecord.first_seen_at
        }
      }
    }

    // Minimum change threshold gating
    if (existingRecord) {
      const mcapDifference = Math.abs(normalizedCurrentMcap - existingRecord.current_mcap)
      const changeThreshold = existingRecord.current_mcap * (MIN_CHANGE_PERCENT / 100) // e.g. 0.1%

      if (mcapDifference < changeThreshold) {
        log.info('price_tracking', 'Skip: small-change gating', {
          tokenAddress,
          tokenSymbol,
          mcapDifference,
          changeThreshold,
          percent: MIN_CHANGE_PERCENT
        })
        return {
          isFirstTime: false,
          firstMcap: existingRecord.first_mcap,
          currentMcap: existingRecord.current_mcap,
          growthPercent: existingRecord.mcap_growth_percent,
          formattedGrowth: formatGrowthPercent(existingRecord.mcap_growth_percent),
          firstSeenAt: existingRecord.first_seen_at
        }
      }
    }

    if (existingRecord) {
      // Token exists, update current MCap
      const previousGrowthPercent = existingRecord.mcap_growth_percent
      const growthPercent = ((normalizedCurrentMcap - existingRecord.first_mcap) / existingRecord.first_mcap) * 100

      // 🔍 DEBUG: Log zero PnL cases
      if (Math.abs(growthPercent) < 0.01) {
        console.log('🔍 ZERO PNL DEBUG:', {
          tokenAddress,
          tokenSymbol,
          firstMcap: existingRecord.first_mcap,
          currentMcap: normalizedCurrentMcap,
          growthPercent,
          firstSeenAt: existingRecord.first_seen_at,
          lastUpdatedAt: existingRecord.last_updated_at,
          timeSinceFirstSeen: new Date().getTime() - new Date(existingRecord.first_seen_at).getTime(),
          mcapDifference: normalizedCurrentMcap - existingRecord.first_mcap
        })
      }

      // Add new environment variable for stop loss threshold
      // const STOP_LOSS_THRESHOLD = parseFloat(process.env.MCAP_STOP_LOSS_THRESHOLD || process.env.NEXT_PUBLIC_MCAP_STOP_LOSS_THRESHOLD || '-50') // -50%

      // In trackTokenMcap function, after calculating growthPercent:
      if (existingRecord) {
        const growthPercent = ((normalizedCurrentMcap - existingRecord.first_mcap) / existingRecord.first_mcap) * 100

        // Check for stop loss condition
        if (growthPercent <= STOP_LOSS_THRESHOLD) {
          log.info('price_tracking', 'Stop loss triggered - halting tracking', {
            tokenAddress,
            tokenSymbol,
            growthPercent,
            stopLossThreshold: STOP_LOSS_THRESHOLD,
            firstMcap: existingRecord.first_mcap,
            currentMcap: normalizedCurrentMcap
          })

          // Mark token as stopped and remove from cache
          mcapCache.delete(tokenAddress)

          // Optionally update database with final state
          const stoppedRecord = {
            ...existingRecord,
            current_mcap: normalizedCurrentMcap,
            last_updated_at: new Date().toISOString(),
            mcap_growth_percent: growthPercent,
            is_tracking_stuck: true // Use this flag to indicate stopped tracking
          }
          updateMcapInDatabase(stoppedRecord, false).catch(console.error)

          return {
            isFirstTime: false,
            firstMcap: existingRecord.first_mcap,
            currentMcap: normalizedCurrentMcap,
            growthPercent,
            formattedGrowth: formatGrowthPercent(growthPercent),
            firstSeenAt: existingRecord.first_seen_at
          }
        }
      }

      const updatedRecord: McapSnapshot = {
        ...existingRecord,
        current_mcap: normalizedCurrentMcap,
        last_updated_at: currentTime,
        mcap_growth_percent: growthPercent
      }

      // Compute stuck flag in DB path
      const ageMs = new Date(currentTime).getTime() - new Date(existingRecord.first_seen_at).getTime()
      const isZero = Math.abs(growthPercent) <= STUCK_EPSILON_PERCENT
      const prevStuck = existingRecord.is_tracking_stuck === true
      updatedRecord.is_tracking_stuck = isZero && ageMs >= STUCK_MIN_AGE_MS

      if (prevStuck !== updatedRecord.is_tracking_stuck) {
        log.info('price_tracking', 'Stuck status changed (db path)', {
          tokenAddress,
          tokenSymbol,
          is_tracking_stuck: updatedRecord.is_tracking_stuck,
          growthPercent,
          ageMs
        })
      }

      // Update threshold timestamps independent of notifications
      const thresholdsUpdatedDb = updateThresholdTimestamps(updatedRecord, growthPercent, currentTime)

      // Update cache
      mcapCache.set(tokenAddress, updatedRecord)

      // Check for threshold notifications
      const notificationSent = await checkAndSendThresholdNotifications(
        updatedRecord,
        tokenSymbol,
        normalizedCurrentMcap,
        existingRecord.first_mcap,
        growthPercent,
        existingRecord.first_seen_at
      )

      // Update database asynchronously:
      const absDelta = Math.abs(existingRecord.current_mcap - normalizedCurrentMcap)
      const dbWriteThreshold = existingRecord.current_mcap * (DB_WRITE_PERCENT / 100)
      const timeSinceLastDbUpdate = new Date().getTime() - new Date(existingRecord.last_updated_at).getTime()

      if (absDelta > dbWriteThreshold) {
        updateMcapInDatabase(updatedRecord, thresholdsUpdatedDb || notificationSent).catch(console.error)
      } else if (timeSinceLastDbUpdate >= HEARTBEAT_INTERVAL_MS) {
        updateMcapInDatabase(updatedRecord, thresholdsUpdatedDb).catch(console.error)
        log.info('price_tracking', 'Heartbeat DB write executed (db path)', {
          tokenAddress,
          tokenSymbol,
          absDelta,
          dbWriteThreshold,
          timeSinceLastDbUpdate
        })
      } else {
        log.info('price_tracking', 'Skip: db-write gating (db path)', {
          tokenAddress,
          tokenSymbol,
          absDelta,
          dbWriteThreshold,
          timeSinceLastDbUpdate,
          heartbeatInterval: HEARTBEAT_INTERVAL_MS
        })
      }

      return {
        isFirstTime: false,
        firstMcap: existingRecord.first_mcap,
        currentMcap: normalizedCurrentMcap,
        growthPercent,
        formattedGrowth: formatGrowthPercent(growthPercent),
        firstSeenAt: existingRecord.first_seen_at
      }
    } else {
      // First time seeing this token
      const newRecord: McapSnapshot = {
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        first_mcap: normalizedCurrentMcap,
        current_mcap: normalizedCurrentMcap,
        first_seen_at: currentTime,
        last_updated_at: currentTime,
        mcap_growth_percent: 0,
        when_reach_80mc: null,
        when_reach_120mc: null,
        when_reach_200mc: null,
        is_tracking_stuck: false
      }

      // Add to cache
      mcapCache.set(tokenAddress, newRecord)

      // Insert into database asynchronously
      insertMcapRecord(newRecord).catch(console.error)

      return {
        isFirstTime: true,
        currentMcap: normalizedCurrentMcap,
        firstSeenAt: currentTime
      }
    }
  } catch (error) {
    log.error('price_tracking', 'Error in trackTokenMcap', error as Error, {
      tokenAddress,
      tokenSymbol,
      currentMcap: normalizeMarketCap(currentMcap)
    })
    return { isFirstTime: true, currentMcap: normalizeMarketCap(currentMcap) }
  }
}

// Helper function to insert new MCap record
async function insertMcapRecord(record: McapSnapshot): Promise<void> {
  try {
    const { error } = await supabase
      .from('token_mcap_tracking')
      .upsert({
        token_address: record.token_address,
        token_symbol: record.token_symbol,
        first_mcap: record.first_mcap,
        current_mcap: record.current_mcap,
        first_seen_at: record.first_seen_at,
        last_updated_at: record.last_updated_at,
        mcap_growth_percent: record.mcap_growth_percent,
        when_reach_80mc: record.when_reach_80mc,
        when_reach_120mc: record.when_reach_120mc,
        when_reach_200mc: record.when_reach_200mc,
        is_tracking_stuck: record.is_tracking_stuck === true
      }, { onConflict: 'token_address' })

    if (error) {
      log.error('price_tracking', 'Error inserting MCap record', error as Error, {
        tokenAddress: record.token_address,
        tokenSymbol: record.token_symbol
      })
      return
    }
    log.debug('price_tracking', 'Inserted MCap record', {
      tokenAddress: record.token_address,
      tokenSymbol: record.token_symbol
    })
  } catch (error) {
    log.error('price_tracking', 'Error in insertMcapRecord', error as Error, {
      tokenAddress: record.token_address,
      tokenSymbol: record.token_symbol
    })
  }
}

// Helper function to update MCap record
async function updateMcapInDatabase(record: McapSnapshot, includeThresholds: boolean = true): Promise<void> {
  try {
    const updateData: any = {
      current_mcap: record.current_mcap,
      last_updated_at: record.last_updated_at,
      mcap_growth_percent: record.mcap_growth_percent,
      is_tracking_stuck: record.is_tracking_stuck === true
    }

    // Only include threshold columns if they were updated
    if (includeThresholds) {
      updateData.when_reach_80mc = record.when_reach_80mc
      updateData.when_reach_120mc = record.when_reach_120mc
      updateData.when_reach_200mc = record.when_reach_200mc
    }

    const { error } = await supabase
      .from('token_mcap_tracking')
      .update(updateData)
      .eq('token_address', record.token_address)

    if (error) {
      log.error('price_tracking', 'Error updating MCap record', error as Error, {
        tokenAddress: record.token_address,
        tokenSymbol: record.token_symbol,
        includeThresholds
      })
      return
    }

    log.debug('price_tracking', 'Updated MCap record', {
      tokenAddress: record.token_address,
      tokenSymbol: record.token_symbol,
      includeThresholds
    })
  } catch (error) {
    log.error('price_tracking', 'Error in updateMcapInDatabase', error as Error, {
      tokenAddress: record.token_address,
      tokenSymbol: record.token_symbol,
      includeThresholds
    })
  }
}

// Helper function to format growth percentage
function formatGrowthPercent(growthPercent: number): string {
  const sign = growthPercent >= 0 ? '+' : ''
  return `${sign}${growthPercent.toFixed(1)}%`
}

// Function to get MCap display string for Discord
export function getMcapDisplayString(trackingResult: McapTrackingResult): string {
  if (trackingResult.isFirstTime) {
    const timeStr = trackingResult.firstSeenAt ?
      ` (1st seen: ${formatTimestampGMT7(trackingResult.firstSeenAt)})` : ''
    return `MCap: $${trackingResult.currentMcap.toLocaleString()}${timeStr}`
  }

  const firstMcapStr = trackingResult.firstMcap!.toLocaleString()
  const currentMcapStr = trackingResult.currentMcap.toLocaleString()
  const growthEmoji = trackingResult.growthPercent! >= 0 ? '📈' : '📉'
  const timeStr = trackingResult.firstSeenAt ?
    `, 1st seen: ${formatTimestampGMT7(trackingResult.firstSeenAt)}` : ''

  return `MCap: $${currentMcapStr} (${growthEmoji} ${trackingResult.formattedGrowth} from $${firstMcapStr}${timeStr})`
}

// Function to check if token is in tracking range
export function isInTrackingRange(mcap: number): boolean {
  return mcap >= 30_000 && mcap <= 2_000_000 // 30k to 2M range
}

// Function to clean up old records (can be called periodically)
export async function cleanupOldMcapRecords(daysOld: number = 30): Promise<void> {
  try {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    const { error } = await supabase
      .from('token_mcap_tracking')
      .delete()
      .lt('last_updated_at', cutoffDate.toISOString())

    if (error) {
      console.error('Error cleaning up old MCap records:', error)
    } else {
      console.log(`Cleaned up MCap records older than ${daysOld} days`)
    }
  } catch (error) {
    console.error('Error in cleanupOldMcapRecords:', error)
  }
}

// Remove the separate notification cleanup function since we no longer need it
// export async function cleanupOldNotificationRecords(daysOld: number = 7): Promise<void> {
//   // This function is no longer needed with the single table approach
// }

// Function to clean up old notification records
export async function cleanupOldNotificationRecords(daysOld: number = 7): Promise<void> {
  try {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    const { error } = await supabase
      .from('mcap_threshold_notifications')
      .delete()
      .lt('notified_at', cutoffDate.toISOString())

    if (error) {
      console.error('Error cleaning up old notification records:', error)
    } else {
      console.log(`Cleaned up notification records older than ${daysOld} days`)
    }
  } catch (error) {
    console.error('Error in cleanupOldNotificationRecords:', error)
  }
}

// Function to get bulk MCap tracking for multiple tokens
export async function bulkTrackTokenMcaps(
  tokens: Array<{ address: string; symbol: string; mcap: number }>
): Promise<Map<string, McapTrackingResult>> {
  const results = new Map<string, McapTrackingResult>()

  // Process tokens in parallel but limit concurrency
  const BATCH_SIZE = 10
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE)
    const batchPromises = batch.map(async token => {
      const result = await trackTokenMcap(token.address, token.symbol, token.mcap)
      return { address: token.address, result }
    })

    const batchResults = await Promise.all(batchPromises)
    batchResults.forEach(({ address, result }) => {
      results.set(address, result)
    })
  }

  return results
}

// Export threshold constants for external use
export { GROWTH_THRESHOLDS }

// Add this new function for monitoring tracking health
export async function getTrackingHealthStats(): Promise<{
  totalTokens: number
  stuckTokens: number
  zeroGrowthTokens: number
  healthPercentage: number
  avgTrackingAge: number
  recentlyUpdated: number
}> {
  try {
    const { data, error } = await supabase
      .from('token_mcap_tracking')
      .select('mcap_growth_percent, first_seen_at, last_updated_at, is_tracking_stuck')

    if (error) throw error

    const now = Date.now()
    const oneHourAgo = now - (60 * 60 * 1000)

    const totalTokens = data.length
    const stuckTokens = data.filter(t => t.is_tracking_stuck).length
    const zeroGrowthTokens = data.filter(t => Math.abs(t.mcap_growth_percent || 0) < 0.01).length
    const recentlyUpdated = data.filter(t => new Date(t.last_updated_at).getTime() > oneHourAgo).length

    const avgTrackingAge = data.reduce((sum, t) => {
      return sum + (now - new Date(t.first_seen_at).getTime())
    }, 0) / (data.length || 1)

    const healthPercentage = totalTokens > 0 ? ((totalTokens - stuckTokens) / totalTokens) * 100 : 100

    return {
      totalTokens,
      stuckTokens,
      zeroGrowthTokens,
      healthPercentage,
      avgTrackingAge: avgTrackingAge / (1000 * 60 * 60), // in hours
      recentlyUpdated
    }
  } catch (error) {
    log.error('price_tracking', 'Failed to get tracking health stats', error as Error)
    return {
      totalTokens: 0,
      stuckTokens: 0,
      zeroGrowthTokens: 0,
      healthPercentage: 0,
      avgTrackingAge: 0,
      recentlyUpdated: 0
    }
  }
}