/**
 * Freshness gate for the DLMM candidate list.
 *
 * Measured 2026-10-02: `dlmm_candidates` held **2 rows, newest 2026-08-28** — 35 days old — because the
 * screener had no cron entry and had not run since. The page chose its source with
 * `if (candidates.length > 0)`, which tests **presence, not freshness**, so a dead screener silently
 * degraded the surface to one stale row instead of showing the live pool list. A stale value was wearing
 * the clothes of a current one.
 *
 * The rule is fail-closed on staleness: candidates are used only while they are demonstrably recent,
 * otherwise the caller falls through to whatever is live.
 */

/** How long a screened candidate stays trustworthy before the live pool list takes over. */
export const CANDIDATE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Newest `screened_at` across the rows, in epoch ms, or `null` when none parses.
 * An unparseable or missing timestamp is treated as *not* a timestamp — never as "now".
 */
export function newestScreenedAt(
  candidates: ReadonlyArray<{ screened_at?: string | null }>,
): number | null {
  let newest: number | null = null;
  for (const candidate of candidates) {
    const raw = candidate.screened_at;
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest;
}

/**
 * True only when there are candidates **and** their newest `screened_at` is within `maxAgeMs` of `now`.
 *
 * A missing or unparseable timestamp returns false deliberately: if the age cannot be established, the
 * data has not earned trust, and the caller should show what is live instead.
 */
export function candidatesAreFresh(
  candidates: ReadonlyArray<{ screened_at?: string | null }>,
  now: number,
  maxAgeMs: number = CANDIDATE_MAX_AGE_MS,
): boolean {
  if (candidates.length === 0) return false;
  const newest = newestScreenedAt(candidates);
  if (newest === null) return false;
  const age = now - newest;
  // A timestamp in the future is clock skew, not freshness.
  return age >= 0 && age < maxAgeMs;
}
