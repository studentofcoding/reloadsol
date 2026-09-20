/**
 * Tracker catch-train flags. Default on; set `false` / `0` to disable.
 * Client checks NEXT_PUBLIC_* first (inlined); server also reads the bare name.
 */
function parseBoolEnv(keys: readonly string[], fallback: boolean): boolean {
  for (const key of keys) {
    const v = process.env[key]
    if (v === undefined || v === '') continue
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return fallback
}

/** Join trending social/web onto GET /api/mcap-tracking?action=list */
export function isTrackerSocialJoinEnabled(): boolean {
  return parseBoolEnv(
    ['NEXT_PUBLIC_TRACKER_SOCIAL_JOIN', 'TRACKER_SOCIAL_JOIN'],
    true,
  )
}

/** Decision line + catch-train strip */
export function isTrackerCatchTrainEnabled(): boolean {
  return parseBoolEnv(
    ['NEXT_PUBLIC_TRACKER_CATCH_TRAIN', 'TRACKER_CATCH_TRAIN'],
    true,
  )
}

/** Async combined / ml score badges */
export function isTrackerScoreBadgesEnabled(): boolean {
  return parseBoolEnv(
    ['NEXT_PUBLIC_TRACKER_SCORE_BADGES', 'TRACKER_SCORE_BADGES'],
    true,
  )
}
