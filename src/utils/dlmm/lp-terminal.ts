/** Default public LP Terminal (Robinhood Chain chainId 4663). */
export const DEFAULT_LP_TERMINAL_BASE_URL = 'https://lp-terminal.xyz'

/**
 * Base URL for LP Terminal deep links.
 * Prefer NEXT_PUBLIC_* (client cards); LP_TERMINAL_BASE_URL works server-side.
 */
export function getLpTerminalBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw =
    env.NEXT_PUBLIC_LP_TERMINAL_BASE_URL?.trim() ||
    env.LP_TERMINAL_BASE_URL?.trim() ||
    DEFAULT_LP_TERMINAL_BASE_URL
  return raw.replace(/\/+$/, '')
}

/**
 * Optional self-hosted indexer base (no trailing slash).
 * Documented for a later phase — not required for v1 deep links.
 */
export function getLpTerminalIndexerUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw =
    env.LP_TERMINAL_INDEXER_URL?.trim() ||
    env.NEXT_PUBLIC_LP_TERMINAL_INDEXER_URL?.trim() ||
    ''
  if (!raw) return null
  return raw.replace(/\/+$/, '')
}

/**
 * Open the POOLS tab. Token CA is appended as `q=` after the hash so users can
 * paste/search if the SPA ignores it; we also expose copy helpers on the card.
 */
export function getLpTerminalPoolsUrl(
  tokenAddress?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = getLpTerminalBaseUrl(env)
  const ca = tokenAddress?.trim()
  if (ca) {
    return `${base}/#pools?q=${encodeURIComponent(ca)}`
  }
  return `${base}/#pools`
}

export async function copyTokenAddress(tokenAddress: string): Promise<boolean> {
  const ca = tokenAddress.trim()
  if (!ca || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false
  }
  try {
    await navigator.clipboard.writeText(ca)
    return true
  } catch {
    return false
  }
}
