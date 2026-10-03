import { timingSafeEqual } from 'node:crypto'

/**
 * Shared secret comparison for cron / webhook / maintenance routes.
 *
 * There is intentionally NO built-in default secret: when the env var is missing the configured secret is
 * '' and `secretsMatch` returns false for every input (including an empty `?key=`), so a missing env
 * fails closed instead of silently accepting a value committed to the repo.
 */

/** First non-blank candidate, else '' (never a literal default). */
export function firstConfiguredSecret(
  ...candidates: Array<string | null | undefined>
): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c
  }
  return ''
}

/** Constant-time compare; false whenever either side is missing or empty. */
export function secretsMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
