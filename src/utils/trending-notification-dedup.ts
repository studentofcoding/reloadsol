/**
 * Gate for the trending track strategy's filtering-summary Discord alerts.
 *
 * The list-style trending Discord notifications (POST /api/trending and
 * /api/trending/filtered, route timers, dedup slots) were removed. Only this
 * flag remains because trending-track/cycle.ts still reads it to decide whether
 * to skip its own filtering summary.
 */

/** When true (default), the track cycle skips its filtering-summary Discord alerts. */
export function trendingListDiscordViaCronOnly(): boolean {
  return process.env.TRENDING_LIST_DISCORD_VIA_CRON !== 'false'
}
