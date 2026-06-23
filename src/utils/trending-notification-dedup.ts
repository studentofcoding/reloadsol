/**
 * Coordinates trending list Discord alerts so cron workers, route timers, and
 * track filtering summaries do not triple-notify the same channel.
 */

export type TrendingListNotificationKind = 'trending_unfiltered' | 'trending_filtered'

const lastSentAt: Record<TrendingListNotificationKind, number> = {
  trending_unfiltered: 0,
  trending_filtered: 0,
}

/** When true (default), list-style Discord alerts come from Go cron POST workers only. */
export function trendingListDiscordViaCronOnly(): boolean {
  return process.env.TRENDING_LIST_DISCORD_VIA_CRON !== 'false'
}

function minIntervalMs(kind: TrendingListNotificationKind): number {
  if (kind === 'trending_filtered') {
    return parseInt(process.env.FILTERED_AUTO_NOTIFICATION_INTERVAL_MS || '120000', 10)
  }
  return parseInt(process.env.AUTO_NOTIFICATION_INTERVAL_MS || '120000', 10)
}

/** Returns false if the same list notification was sent too recently. */
export function acquireTrendingListNotificationSlot(
  kind: TrendingListNotificationKind,
): boolean {
  const interval = minIntervalMs(kind)
  const now = Date.now()
  if (now - lastSentAt[kind] < interval) {
    return false
  }
  lastSentAt[kind] = now
  return true
}
