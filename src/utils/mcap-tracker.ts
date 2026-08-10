import { query, queryOne } from '@/utils/db'
import { log } from '@/utils/unified-logger'
import { formatAppTimeWithZone } from '@/utils/datetime'
import type { AppNetwork } from '@/utils/app-network'

/** Shared mcap tracker thresholds (no side effects — safe for unit tests). */
export const STOP_LOSS_THRESHOLD = parseFloat(
  process.env.MCAP_STOP_LOSS_THRESHOLD ||
    process.env.NEXT_PUBLIC_MCAP_STOP_LOSS_THRESHOLD ||
    '-50',
)

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

export type TokenLabel = 'valid' | 'traded_live' | 'potential' | 'rugged' | 'watching'

export interface McapSnapshot {
  token_address: string
  token_symbol: string
  chain?: AppNetwork
  first_mcap: number
  current_mcap: number
  first_seen_at: string
  last_updated_at: string
  mcap_growth_percent: number
  when_reach_80pct?: string | null
  when_reach_120pct?: string | null
  when_reach_200pct?: string | null
  when_drop_40pct?: string | null
  when_drop_80pct?: string | null
  peak_mcap?: number | null
  peak_growth_percent?: number | null
  peak_seen_at?: string | null
  is_tracking_stuck?: boolean
  label?: TokenLabel | null
  stop_reason?: string | null
  organic_score?: number | null
  top_holders_pct?: number | null
  volume_5m?: number | null
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
/** Drop milestones: first time growth falls to or below these levels. */
const DROP_THRESHOLDS = [-40, -80] as const

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

// Helper function to get threshold column name
type ThresholdColumnName = 'when_reach_80pct' | 'when_reach_120pct' | 'when_reach_200pct'
type DropColumnName = 'when_drop_40pct' | 'when_drop_80pct'

function getThresholdColumnName(threshold: number): ThresholdColumnName {
  switch (threshold) {
    case 80: return 'when_reach_80pct'
    case 120: return 'when_reach_120pct'
    case 200: return 'when_reach_200pct'
    default: throw new Error(`Unknown threshold: ${threshold}`)
  }
}

function getDropColumnName(threshold: number): DropColumnName {
  switch (threshold) {
    case -40: return 'when_drop_40pct'
    case -80: return 'when_drop_80pct'
    default: throw new Error(`Unknown drop threshold: ${threshold}`)
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

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : null
}

/** True when first_seen_at is still after any milestone (post-normalize check). */
export function isTrackingTimelineInconsistent(record: McapSnapshot): boolean {
  const firstMs = parseIsoMs(record.first_seen_at)
  if (firstMs == null) return false
  for (const threshold of GROWTH_THRESHOLDS) {
    const col = getThresholdColumnName(threshold)
    const milestoneMs = parseIsoMs(record[col])
    if (milestoneMs != null && firstMs > milestoneMs) return true
  }
  return false
}

/**
 * Bidirectional timeline repair:
 * 1) null milestones before first_seen (stale session)
 * 2) null milestones inconsistent with current growth
 * 3) clamp first_seen to earliest remaining milestone if still late
 */
export function normalizeTrackingTimeline(record: McapSnapshot): boolean {
  const firstMs = parseIsoMs(record.first_seen_at)
  if (firstMs == null) return false

  let changed = false
  const growth = record.mcap_growth_percent ?? 0

  for (const threshold of GROWTH_THRESHOLDS) {
    const columnName = getThresholdColumnName(threshold)
    const milestoneMs = parseIsoMs(record[columnName])
    if (milestoneMs != null && milestoneMs < firstMs) {
      record[columnName] = null
      changed = true
    }
  }

  for (const threshold of GROWTH_THRESHOLDS) {
    const columnName = getThresholdColumnName(threshold)
    if (record[columnName] && growth < threshold) {
      record[columnName] = null
      changed = true
    }
  }

  // Drop milestones: clear only if timestamp predates first_seen (keep after recovery)
  for (const threshold of DROP_THRESHOLDS) {
    const columnName = getDropColumnName(threshold)
    const milestoneMs = parseIsoMs(record[columnName])
    if (milestoneMs != null && milestoneMs < firstMs) {
      record[columnName] = null
      changed = true
    }
  }

  const remainingFirstMs = parseIsoMs(record.first_seen_at)
  if (remainingFirstMs == null) return changed

  const milestoneTimes = GROWTH_THRESHOLDS.map((threshold) =>
    parseIsoMs(record[getThresholdColumnName(threshold)]),
  ).filter((v): v is number => v != null)

  if (milestoneTimes.length > 0) {
    const earliest = Math.min(remainingFirstMs, ...milestoneTimes)
    if (earliest < remainingFirstMs) {
      record.first_seen_at = new Date(earliest).toISOString()
      changed = true
      log.warn('price_tracking', 'Repaired first_seen_at to earliest milestone', {
        tokenAddress: record.token_address,
        tokenSymbol: record.token_symbol,
        firstSeenAt: record.first_seen_at,
      })
    }
  }

  return changed
}

/** Backfill one missing milestone when growth already exceeds thresholds (lowest first). */
export function reconcileMilestonesFromGrowth(
  record: McapSnapshot,
  nowIso?: string,
): boolean {
  const growth = record.mcap_growth_percent ?? 0
  const milestoneIso =
    nowIso ?? record.last_updated_at ?? new Date().toISOString()
  for (const threshold of GROWTH_THRESHOLDS) {
    const columnName = getThresholdColumnName(threshold)
    if (growth >= threshold && !record[columnName]) {
      record[columnName] = milestoneIso
      return true
    }
  }
  // Backfill all unmet drop milestones in one pass (crash can skip -40 → -80)
  let dropChanged = false
  for (const threshold of DROP_THRESHOLDS) {
    const columnName = getDropColumnName(threshold)
    if (growth <= threshold && !record[columnName]) {
      record[columnName] = milestoneIso
      dropChanged = true
    }
  }
  return dropChanged
}

/** Start a fresh tracking session (new baseline, clear milestones). */
export function resetTrackingSession(
  record: McapSnapshot,
  currentMcap: number,
  nowIso: string,
): McapSnapshot {
  const normalizedMcap = normalizeMarketCap(currentMcap)
  record.first_mcap = normalizedMcap
  record.current_mcap = normalizedMcap
  record.first_seen_at = nowIso
  record.last_updated_at = nowIso
  record.mcap_growth_percent = 0
  record.when_reach_80pct = null
  record.when_reach_120pct = null
  record.when_reach_200pct = null
  record.when_drop_40pct = null
  record.when_drop_80pct = null
  record.peak_mcap = normalizedMcap
  record.peak_growth_percent = 0
  record.peak_seen_at = nowIso
  record.is_tracking_stuck = false
  log.info('price_tracking', 'Reset tracking session', {
    tokenAddress: record.token_address,
    tokenSymbol: record.token_symbol,
    firstMcap: normalizedMcap,
    firstSeenAt: nowIso,
  })
  return record
}

function shouldResetTrackingSession(record: McapSnapshot, nowMs: number): boolean {
  const firstMs = parseIsoMs(record.first_seen_at)
  if (firstMs == null) return false
  return nowMs - firstMs >= MAX_TRACKING_AGE_MS
}

/** Normalize timeline in-place; optionally persist when a repair was needed. */
export function fixTrackingTimeline(record: McapSnapshot, persist = false): McapSnapshot {
  const repaired = normalizeTrackingTimeline(record)
  const backfilled = reconcileMilestonesFromGrowth(record)
  if ((repaired || backfilled) && persist) {
    void query(
      `UPDATE token_mcap_tracking SET
         first_seen_at = $2,
         when_reach_80pct = $3,
         when_reach_120pct = $4,
         when_reach_200pct = $5,
         when_drop_40pct = $6,
         when_drop_80pct = $7
       WHERE token_address = $1`,
      [
        record.token_address,
        record.first_seen_at,
        record.when_reach_80pct,
        record.when_reach_120pct,
        record.when_reach_200pct,
        record.when_drop_40pct,
        record.when_drop_80pct,
      ],
    ).catch((error) => {
      log.warn('price_tracking', 'Failed to persist timeline repair', {
        tokenAddress: record.token_address,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return record
}

/** Reconcile milestones on a record and persist when backfilled (e.g. small-change skip path). */
export function persistMilestoneBackfillIfNeeded(record: McapSnapshot): boolean {
  normalizeTrackingTimeline(record)
  const backfilled = reconcileMilestonesFromGrowth(record)
  if (!backfilled) return false
  void updateMcapInDatabase(record, true).catch(console.error)
  mcapCache.set(record.token_address, record)
  return true
}

export function minutesBetween(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number | null {
  const startMs = parseIsoMs(startIso)
  const endMs = parseIsoMs(endIso)
  if (startMs == null || endMs == null) return null
  return (endMs - startMs) / (1000 * 60)
}

/** Update peak mcap / peak growth when current exceeds prior peak. */
export function updatePeakMcap(
  record: McapSnapshot,
  currentMcap: number,
  growthPercent: number,
  nowIso: string,
): boolean {
  const normalized = normalizeMarketCap(currentMcap)
  const priorPeak =
    typeof record.peak_mcap === 'number' && Number.isFinite(record.peak_mcap)
      ? record.peak_mcap
      : null
  if (priorPeak == null || normalized > priorPeak) {
    record.peak_mcap = normalized
    record.peak_growth_percent = growthPercent
    record.peak_seen_at = nowIso
    return true
  }
  return false
}

/**
 * Auto-label from milestones:
 * - drop -40/-80 → rugged (never overwrite traded_live)
 * - peak_growth > 0 → potential (never overwrite traded_live / rugged)
 */
export function applyAutoLabelsFromMilestones(record: McapSnapshot): boolean {
  const current = record.label ?? null

  if (record.when_drop_40pct || record.when_drop_80pct) {
    if (current === 'traded_live' || current === 'rugged') return false
    record.label = 'rugged'
    return true
  }

  const peakGrowth = record.peak_growth_percent ?? 0
  if (peakGrowth > 0 && (!current || current === 'valid' || current === 'watching')) {
    record.label = 'potential'
    return true
  }
  return false
}

// Helper: update threshold timestamp fields when growth crosses thresholds
function updateThresholdTimestamps(record: McapSnapshot, growthPercent: number, nowIso: string): boolean {
  normalizeTrackingTimeline(record)
  const firstMs = parseIsoMs(record.first_seen_at) ?? 0
  const nowMs = parseIsoMs(nowIso) ?? Date.now()
  if (nowMs < firstMs) {
    return false
  }

  let changed = false
  for (const threshold of GROWTH_THRESHOLDS) {
    const columnName = getThresholdColumnName(threshold)
    if (growthPercent >= threshold && !record[columnName]) {
      record[columnName] = nowIso
      changed = true
      break
    }
  }

  // Drop milestones: set all crossed levels in one tick (no break)
  for (const threshold of DROP_THRESHOLDS) {
    const columnName = getDropColumnName(threshold)
    if (growthPercent <= threshold && !record[columnName]) {
      record[columnName] = nowIso
      changed = true
    }
  }

  return changed
}

/** Apply peak + thresholds + auto-labels; returns true if any field changed. */
export function applyMcapSessionUpdates(
  record: McapSnapshot,
  currentMcap: number,
  growthPercent: number,
  nowIso: string,
): boolean {
  const peakChanged = updatePeakMcap(record, currentMcap, growthPercent, nowIso)
  const thresholdsChanged = updateThresholdTimestamps(record, growthPercent, nowIso)
  const labelChanged = applyAutoLabelsFromMilestones(record)
  return peakChanged || thresholdsChanged || labelChanged
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
    const chartLink = `https://reloadsol.app/chart/${tokenAddress}`
    const reloadSolLink = `https://reloadsol.app/buy?sol=0.1&mints=${tokenAddress}`

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
              value: `**First Seen:** ${formatAppTimeWithZone(firstSeenAt)}\n**Alert Time:** ${formatAppTimeWithZone(new Date().toISOString())}`,
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
        const data = await queryOne<{ notified_at: string }>(
          `SELECT notified_at FROM mcap_threshold_notifications
           WHERE token_address = $1 AND threshold = $2
           ORDER BY notified_at DESC
           LIMIT 1`,
          [record.token_address, threshold],
        )
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
          await query(
            `INSERT INTO mcap_threshold_notifications
               (token_address, token_symbol, threshold, growth_percent, notified_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              record.token_address,
              tokenSymbol,
              threshold,
              growthPercent,
              new Date().toISOString(),
            ],
          )
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
  currentMcap: number,
  chain: AppNetwork = 'sol'
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
      if (shouldResetTrackingSession(cached, now)) {
        resetTrackingSession(cached, normalizedCurrentMcap, new Date().toISOString())
        void updateMcapInDatabase(cached, true).catch(console.error)
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

        const sessionUpdated = applyMcapSessionUpdates(
          cached,
          cached.current_mcap,
          cached.mcap_growth_percent,
          cached.last_updated_at,
        )

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
        updateMcapInDatabase(cached, sessionUpdated || notificationSent).catch(console.error)
      } else if (timeSinceLastDbUpdate >= HEARTBEAT_INTERVAL_MS) {
        // Heartbeat: update without threshold columns, and record latest currentMcap and growth
        const prev = { current: cached.current_mcap, growth: cached.mcap_growth_percent }
        cached.current_mcap = normalizedCurrentMcap
        cached.mcap_growth_percent = ((normalizedCurrentMcap - cached.first_mcap) / cached.first_mcap) * 100
        cached.last_updated_at = new Date().toISOString()

        const thresholdsUpdatedHb = applyMcapSessionUpdates(
          cached,
          cached.current_mcap,
          cached.mcap_growth_percent,
          cached.last_updated_at,
        )

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
      const data = await queryOne<McapSnapshot>(
        `SELECT * FROM token_mcap_tracking
         WHERE token_address = $1 AND chain = $2
         ORDER BY last_updated_at DESC
         LIMIT 1`,
        [tokenAddress, chain],
      )
      existingRecord = data ?? null
      if (existingRecord) {
        normalizeTrackingTimeline(existingRecord)
      }
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

      if (shouldResetTrackingSession(existingRecord, Date.now())) {
        resetTrackingSession(existingRecord, normalizedCurrentMcap, currentTime)
        mcapCache.set(tokenAddress, existingRecord)
        void updateMcapInDatabase(existingRecord, true).catch(console.error)
        return {
          isFirstTime: true,
          firstMcap: existingRecord.first_mcap,
          currentMcap: normalizedCurrentMcap,
          growthPercent: 0,
          formattedGrowth: formatGrowthPercent(0),
          firstSeenAt: existingRecord.first_seen_at,
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
        persistMilestoneBackfillIfNeeded(existingRecord)
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

    if (!existingRecord) {
      const newRecord: McapSnapshot = {
        token_address: tokenAddress,
        token_symbol: tokenSymbol,
        chain,
        first_mcap: normalizedCurrentMcap,
        current_mcap: normalizedCurrentMcap,
        first_seen_at: currentTime,
        last_updated_at: currentTime,
        mcap_growth_percent: 0,
        when_reach_80pct: null,
        when_reach_120pct: null,
        when_reach_200pct: null,
        when_drop_40pct: null,
        when_drop_80pct: null,
        peak_mcap: normalizedCurrentMcap,
        peak_growth_percent: 0,
        peak_seen_at: currentTime,
        is_tracking_stuck: false,
      }

      const insertResult = await insertMcapRecord(newRecord)
      if (insertResult.status === 'inserted') {
        mcapCache.set(tokenAddress, newRecord)
        return {
          isFirstTime: true,
          currentMcap: normalizedCurrentMcap,
          firstSeenAt: currentTime,
        }
      }
      existingRecord = insertResult.existing
      normalizeTrackingTimeline(existingRecord)
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

          // Optionally update database with final state (still stamp drop/peak milestones)
          const stoppedRecord: McapSnapshot = {
            ...existingRecord,
            current_mcap: normalizedCurrentMcap,
            last_updated_at: new Date().toISOString(),
            mcap_growth_percent: growthPercent,
            is_tracking_stuck: true // Use this flag to indicate stopped tracking
          }
          applyMcapSessionUpdates(
            stoppedRecord,
            normalizedCurrentMcap,
            growthPercent,
            stoppedRecord.last_updated_at,
          )
          updateMcapInDatabase(stoppedRecord, true).catch(console.error)

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

      const thresholdsUpdatedDb = applyMcapSessionUpdates(
        updatedRecord,
        normalizedCurrentMcap,
        growthPercent,
        currentTime,
      )

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
    }

    return { isFirstTime: true, currentMcap: normalizedCurrentMcap }
  } catch (error) {
    log.error('price_tracking', 'Error in trackTokenMcap', error as Error, {
      tokenAddress,
      tokenSymbol,
      currentMcap: normalizeMarketCap(currentMcap)
    })
    return { isFirstTime: true, currentMcap: normalizeMarketCap(currentMcap) }
  }
}

type InsertMcapResult =
  | { status: 'inserted' }
  | { status: 'conflict'; existing: McapSnapshot }

async function fetchMcapRecordByAddress(
  tokenAddress: string,
  chain: 'sol' | 'robinhood' = 'sol',
): Promise<McapSnapshot | null> {
  try {
    const data = await queryOne<McapSnapshot>(
      `SELECT * FROM token_mcap_tracking WHERE token_address = $1 AND chain = $2`,
      [tokenAddress, chain],
    )
    if (!data) return null
    normalizeTrackingTimeline(data)
    return data
  } catch {
    return null
  }
}

// Helper function to insert new MCap record (insert-only; never overwrite first_seen on conflict)
async function insertMcapRecord(record: McapSnapshot): Promise<InsertMcapResult> {
  try {
    normalizeTrackingTimeline(record)
    await ensureMcapEntryMetaColumns()
    await query(
      `INSERT INTO token_mcap_tracking (
         token_address, token_symbol, first_mcap, current_mcap,
         first_seen_at, last_updated_at, mcap_growth_percent,
         when_reach_80pct, when_reach_120pct, when_reach_200pct,
         when_drop_40pct, when_drop_80pct,
         peak_mcap, peak_growth_percent, peak_seen_at,
         is_tracking_stuck, label,
         organic_score, top_holders_pct, volume_5m, chain
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        record.token_address,
        record.token_symbol,
        record.first_mcap,
        record.current_mcap,
        record.first_seen_at,
        record.last_updated_at,
        record.mcap_growth_percent,
        record.when_reach_80pct,
        record.when_reach_120pct,
        record.when_reach_200pct,
        record.when_drop_40pct ?? null,
        record.when_drop_80pct ?? null,
        record.peak_mcap ?? record.current_mcap,
        record.peak_growth_percent ?? 0,
        record.peak_seen_at ?? record.first_seen_at,
        record.is_tracking_stuck === true,
        record.label ?? null,
        record.organic_score ?? null,
        record.top_holders_pct ?? null,
        record.volume_5m ?? null,
        record.chain ?? 'sol',
      ],
    )

    log.debug('price_tracking', 'Inserted MCap record', {
      tokenAddress: record.token_address,
      tokenSymbol: record.token_symbol,
    })
    return { status: 'inserted' }
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await fetchMcapRecordByAddress(record.token_address, record.chain ?? 'sol')
      if (existing) {
        log.info('price_tracking', 'Insert conflict — using existing MCap record', {
          tokenAddress: record.token_address,
          tokenSymbol: record.token_symbol,
          firstSeenAt: existing.first_seen_at,
        })
        return { status: 'conflict', existing }
      }
    }

    log.error('price_tracking', 'Error in insertMcapRecord', error as Error, {
      tokenAddress: record.token_address,
      tokenSymbol: record.token_symbol,
    })
    const existing = await fetchMcapRecordByAddress(record.token_address, record.chain ?? 'sol')
    if (existing) return { status: 'conflict', existing }
    return { status: 'inserted' }
  }
}

// Helper function to update MCap record
async function updateMcapInDatabase(record: McapSnapshot, includeThresholds: boolean = true): Promise<void> {
  try {
    await ensureMcapEntryMetaColumns()
    const repairedTimeline = normalizeTrackingTimeline(record)
    const sets = [
      'current_mcap = $2',
      'last_updated_at = $3',
      'mcap_growth_percent = $4',
      'is_tracking_stuck = $5',
    ]
    const params: unknown[] = [
      record.token_address,
      record.current_mcap,
      record.last_updated_at,
      record.mcap_growth_percent,
      record.is_tracking_stuck === true,
    ]
    let paramIdx = 6

    if (repairedTimeline) {
      sets.push(`first_seen_at = $${paramIdx++}`)
      params.push(record.first_seen_at)
    }

    if (repairedTimeline || includeThresholds) {
      sets.push(`when_reach_80pct = $${paramIdx++}`)
      params.push(record.when_reach_80pct)
      sets.push(`when_reach_120pct = $${paramIdx++}`)
      params.push(record.when_reach_120pct)
      sets.push(`when_reach_200pct = $${paramIdx++}`)
      params.push(record.when_reach_200pct)
      sets.push(`when_drop_40pct = $${paramIdx++}`)
      params.push(record.when_drop_40pct ?? null)
      sets.push(`when_drop_80pct = $${paramIdx++}`)
      params.push(record.when_drop_80pct ?? null)
      sets.push(`peak_mcap = $${paramIdx++}`)
      params.push(record.peak_mcap ?? null)
      sets.push(`peak_growth_percent = $${paramIdx++}`)
      params.push(record.peak_growth_percent ?? null)
      sets.push(`peak_seen_at = $${paramIdx++}`)
      params.push(record.peak_seen_at ?? null)
      if (record.label != null) {
        sets.push(`label = $${paramIdx++}`)
        params.push(record.label)
      }
    }

    if (record.organic_score != null) {
      sets.push(`organic_score = $${paramIdx++}`)
      params.push(record.organic_score)
    }
    if (record.top_holders_pct != null) {
      sets.push(`top_holders_pct = $${paramIdx++}`)
      params.push(record.top_holders_pct)
    }
    if (record.volume_5m != null) {
      sets.push(`volume_5m = $${paramIdx++}`)
      params.push(record.volume_5m)
    }

    await query(
      `UPDATE token_mcap_tracking SET ${sets.join(', ')} WHERE token_address = $1 AND chain = $${paramIdx}`,
      [...params, record.chain ?? 'sol'],
    )

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
      ` (1st seen: ${formatAppTimeWithZone(trackingResult.firstSeenAt)})` : ''
    return `MCap: $${trackingResult.currentMcap.toLocaleString()}${timeStr}`
  }

  const firstMcapStr = trackingResult.firstMcap!.toLocaleString()
  const currentMcapStr = trackingResult.currentMcap.toLocaleString()
  const growthEmoji = trackingResult.growthPercent! >= 0 ? '📈' : '📉'
  const timeStr = trackingResult.firstSeenAt ?
    `, 1st seen: ${formatAppTimeWithZone(trackingResult.firstSeenAt)}` : ''

  return `MCap: $${currentMcapStr} (${growthEmoji} ${trackingResult.formattedGrowth} from $${firstMcapStr}${timeStr})`
}

// Function to check if token is in tracking range
export function isInTrackingRange(
  mcap: number,
  entry?: { mcapMin?: number; mcapMax?: number },
): boolean {
  const min = entry?.mcapMin ?? 30_000
  const max = entry?.mcapMax ?? 2_000_000
  return mcap >= min && mcap <= max
}

// Function to clean up old records (can be called periodically)
export async function cleanupOldMcapRecords(daysOld: number = 30): Promise<void> {
  try {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)

    const { rowCount } = await query(
      `DELETE FROM token_mcap_tracking WHERE last_updated_at < $1`,
      [cutoffDate.toISOString()],
    )
    console.log(`Cleaned up ${rowCount} MCap records older than ${daysOld} days`)
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

    const { rowCount } = await query(
      `DELETE FROM mcap_threshold_notifications WHERE notified_at < $1`,
      [cutoffDate.toISOString()],
    )
    console.log(`Cleaned up ${rowCount} notification records older than ${daysOld} days`)
  } catch (error) {
    console.error('Error in cleanupOldNotificationRecords:', error)
  }
}

// Function to get bulk MCap tracking for multiple tokens
export async function bulkTrackTokenMcaps(
  tokens: Array<{ address: string; symbol: string; mcap: number }>,
  chain: AppNetwork = 'sol'
): Promise<Map<string, McapTrackingResult>> {
  const results = new Map<string, McapTrackingResult>()

  // Process tokens in parallel but limit concurrency
  const BATCH_SIZE = 10
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE)
    const batchPromises = batch.map(async token => {
      const result = await trackTokenMcap(token.address, token.symbol, token.mcap, chain)
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

export type McapSimCloseReason =
  | 'stop_loss'
  | 'stuck'
  | 'max_age'
  | 'label_rugged'
  | 'tracking_stopped'
  | 'take_profit_200'
  | 'strategy_deactivated'

export type McapSimExitConfig = {
  stopLossPct?: number
  takeProfitPct?: number
  maxHoldHours?: number
}

export function getMcapSimCloseReason(
  snapshot: McapSnapshot,
  exitConfig?: McapSimExitConfig,
): McapSimCloseReason | null {
  if (snapshot.label === 'rugged') return 'label_rugged'
  const stopReason = (snapshot.stop_reason ?? '').trim()
  if (stopReason.length > 0) return 'tracking_stopped'
  const growth = snapshot.mcap_growth_percent ?? 0
  const takeProfitPct = exitConfig?.takeProfitPct ?? 200
  const stopLossPct = exitConfig?.stopLossPct ?? STOP_LOSS_THRESHOLD
  const maxHoldMs =
    (exitConfig?.maxHoldHours ?? MAX_TRACKING_AGE_MS / (1000 * 60 * 60)) *
    60 *
    60 *
    1000
  if (growth >= takeProfitPct) return 'take_profit_200'
  if (growth <= stopLossPct) return 'stop_loss'
  const ageMs = Date.now() - (parseIsoMs(snapshot.first_seen_at) ?? Date.now())
  if (ageMs >= maxHoldMs) return 'max_age'
  if (snapshot.is_tracking_stuck) return 'stuck'
  return null
}

export function computeMcapSimPnlPct(entryMcap: number, exitMcap: number): number {
  if (!entryMcap || entryMcap <= 0) return 0
  return ((exitMcap - entryMcap) / entryMcap) * 100
}

export function buildMcapOutcomeFeatures(params: {
  snapshot: McapSnapshot
  entryTemplate: 'first_seen' | 'milestone_80'
  entryMcap: number
  exitMcap: number
  closeReason?: McapSimCloseReason | null
}): Record<string, unknown> {
  const { snapshot, entryTemplate, entryMcap, exitMcap } = params
  normalizeTrackingTimeline(snapshot)
  const reached80 = !!snapshot.when_reach_80pct
  const reached120 = !!snapshot.when_reach_120pct
  const reached200 = !!snapshot.when_reach_200pct

  return {
    token_symbol: snapshot.token_symbol,
    entry_template: entryTemplate,
    first_seen_at: snapshot.first_seen_at,
    when_reach_80pct: snapshot.when_reach_80pct ?? null,
    when_reach_120pct: snapshot.when_reach_120pct ?? null,
    when_reach_200pct: snapshot.when_reach_200pct ?? null,
    reached_80: reached80,
    reached_120: reached120,
    reached_200: reached200,
    time_to_80_minutes: minutesBetween(snapshot.first_seen_at, snapshot.when_reach_80pct),
    time_to_120_minutes: minutesBetween(snapshot.first_seen_at, snapshot.when_reach_120pct),
    time_to_200_minutes: minutesBetween(snapshot.first_seen_at, snapshot.when_reach_200pct),
    entry_mcap: entryMcap,
    exit_mcap: exitMcap,
    mcap_growth_at_exit: computeMcapSimPnlPct(entryMcap, exitMcap),
    is_tracking_stuck: snapshot.is_tracking_stuck === true,
    close_reason: params.closeReason ?? null,
  }
}

export async function fetchMcapTrackingRow(
  tokenAddress: string,
  chain: 'sol' | 'robinhood' = 'sol',
): Promise<McapSnapshot | null> {
  return fetchMcapRecordByAddress(tokenAddress, chain)
}

let ensureMcapMetaPromise: Promise<void> | null = null

async function ensureMcapEntryMetaColumns(): Promise<void> {
  if (!ensureMcapMetaPromise) {
    ensureMcapMetaPromise = (async () => {
      // Run statements one-by-one — pg may not accept multi-statement in one query
      await query(
        `ALTER TABLE token_mcap_tracking ADD COLUMN IF NOT EXISTS organic_score NUMERIC`,
      )
      await query(
        `ALTER TABLE token_mcap_tracking ADD COLUMN IF NOT EXISTS top_holders_pct NUMERIC`,
      )
      await query(
        `ALTER TABLE token_mcap_tracking ADD COLUMN IF NOT EXISTS volume_5m NUMERIC`,
      )
      await query(
        `ALTER TABLE token_mcap_tracking ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'sol'`,
      )
    })()
      .then(() => undefined)
      .catch((err) => {
        ensureMcapMetaPromise = null
        throw err
      })
  }
  await ensureMcapMetaPromise
}

/** Persist organic / holders / volume onto token_mcap_tracking when known. */
export async function upsertMcapEntryMeta(
  tokenAddress: string,
  meta: {
    organicScore?: number | null
    topHoldersPct?: number | null
    volume5m?: number | null
  },
): Promise<void> {
  const organic =
    typeof meta.organicScore === 'number' && Number.isFinite(meta.organicScore)
      ? meta.organicScore
      : null
  const holders =
    typeof meta.topHoldersPct === 'number' && Number.isFinite(meta.topHoldersPct)
      ? meta.topHoldersPct
      : null
  const volume =
    typeof meta.volume5m === 'number' && Number.isFinite(meta.volume5m)
      ? meta.volume5m
      : null
  if (organic == null && holders == null && volume == null) return

  try {
    await ensureMcapEntryMetaColumns()
    await query(
      `UPDATE token_mcap_tracking SET
         organic_score = COALESCE($2, organic_score),
         top_holders_pct = COALESCE($3, top_holders_pct),
         volume_5m = COALESCE($4, volume_5m),
         last_updated_at = NOW()
       WHERE token_address = $1`,
      [tokenAddress, organic, holders, volume],
    )
  } catch (error) {
    log.debug('price_tracking', 'upsertMcapEntryMeta skipped', {
      tokenAddress,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function fetchRecentMcapTrackingRows(params: {
  recencyMinutes?: number
  limit?: number
}): Promise<McapSnapshot[]> {
  const recencyMinutes = params.recencyMinutes ?? 240
  const limit = params.limit ?? 200
  const cutoff = new Date(Date.now() - recencyMinutes * 60 * 1000).toISOString()

  const { rows: data } = await query<McapSnapshot>(
    `SELECT * FROM token_mcap_tracking
     WHERE last_updated_at >= $1
     ORDER BY last_updated_at DESC
     LIMIT $2`,
    [cutoff, limit],
  )

  if (!data) return []

  return data.map((row) => {
    normalizeTrackingTimeline(row)
    return row
  })
}

/** Union recent + high-growth rows for mcap sim-track (deduped by token_address). */
export async function fetchMcapSimCandidateRows(params: {
  recencyMinutes?: number
  recentLimit?: number
  growthLimit?: number
  minGrowthPercent?: number
  chain?: AppNetwork
}): Promise<McapSnapshot[]> {
  const recencyMinutes = params.recencyMinutes ?? 240
  const recentLimit = params.recentLimit ?? 300
  const growthLimit = params.growthLimit ?? 100
  const minGrowth = params.minGrowthPercent ?? 80
  const chain = params.chain ?? 'sol'
  const cutoff = new Date(Date.now() - recencyMinutes * 60 * 1000).toISOString()

  await ensureMcapEntryMetaColumns()
  const { rows } = await query<McapSnapshot>(
    `(SELECT * FROM token_mcap_tracking
      WHERE last_updated_at >= $1 AND chain = $5
      ORDER BY last_updated_at DESC
      LIMIT $2)
     UNION ALL
     (SELECT * FROM token_mcap_tracking
      WHERE last_updated_at >= $1 AND chain = $5
        AND mcap_growth_percent >= $3
      ORDER BY mcap_growth_percent DESC
      LIMIT $4)`,
    [cutoff, recentLimit, minGrowth, growthLimit, chain],
  )

  const byAddress = new Map<string, McapSnapshot>()
  for (const row of rows ?? []) {
    normalizeTrackingTimeline(row)
    byAddress.set(row.token_address, row)
  }
  return Array.from(byAddress.values())
}

// Add this new function for monitoring tracking health
export async function getTrackingHealthStats(): Promise<{
  totalTokens: number
  stuckTokens: number
  zeroGrowthTokens: number
  healthPercentage: number
  avgTrackingAge: number
  recentlyUpdated: number
  timelineInconsistentCount: number
}> {
  try {
    const { rows: data } = await query<{
      mcap_growth_percent: number | null
      first_seen_at: string
      last_updated_at: string
      is_tracking_stuck: boolean
      when_reach_80pct: string | null
      when_reach_120pct: string | null
      when_reach_200pct: string | null
    }>(
      `SELECT mcap_growth_percent, first_seen_at, last_updated_at, is_tracking_stuck,
              when_reach_80pct, when_reach_120pct, when_reach_200pct
       FROM token_mcap_tracking`,
    )

    const now = Date.now()
    const oneHourAgo = now - 60 * 60 * 1000

    const totalTokens = data.length
    const stuckTokens = data.filter((t) => t.is_tracking_stuck).length
    const zeroGrowthTokens = data.filter((t) => Math.abs(t.mcap_growth_percent || 0) < 0.01).length
    const recentlyUpdated = data.filter((t) => new Date(t.last_updated_at).getTime() > oneHourAgo).length

    const timelineInconsistentCount = data.filter((t) =>
      isTrackingTimelineInconsistent(t as McapSnapshot),
    ).length

    const avgTrackingAge =
      data.reduce((sum, t) => sum + (now - new Date(t.first_seen_at).getTime()), 0) /
      (data.length || 1)

    const healthPercentage =
      totalTokens > 0 ? ((totalTokens - stuckTokens) / totalTokens) * 100 : 100

    return {
      totalTokens,
      stuckTokens,
      zeroGrowthTokens,
      healthPercentage,
      avgTrackingAge: avgTrackingAge / (1000 * 60 * 60),
      recentlyUpdated,
      timelineInconsistentCount,
    }
  } catch (error) {
    log.error('price_tracking', 'Failed to get tracking health stats', error as Error)
    return {
      totalTokens: 0,
      stuckTokens: 0,
      zeroGrowthTokens: 0,
      healthPercentage: 0,
      avgTrackingAge: 0,
      recentlyUpdated: 0,
      timelineInconsistentCount: 0,
    }
  }
}