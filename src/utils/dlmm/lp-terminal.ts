/**
 * Default public LP indexer (Robinhood Pools, chainId 4663). lp-terminal.xyz
 * retired (HTTP 410 on every path); robinhoodpools.lol serves /api/lp/*.
 */
export const DEFAULT_LP_TERMINAL_BASE_URL = 'https://robinhoodpools.lol'

type Env = Record<string, string | undefined>

/**
 * Base URL for LP Terminal deep links.
 * Prefer NEXT_PUBLIC_* (client cards); LP_TERMINAL_BASE_URL works server-side.
 */
export function getLpTerminalBaseUrl(env: Env = process.env): string {
  const raw =
    env.NEXT_PUBLIC_LP_TERMINAL_BASE_URL?.trim() ||
    env.LP_TERMINAL_BASE_URL?.trim() ||
    DEFAULT_LP_TERMINAL_BASE_URL
  return raw.replace(/\/+$/, '')
}

/**
 * Indexer HTTP origin for /api/pools (no trailing slash).
 * Defaults to the public LP Terminal site when unset.
 */
export function getLpTerminalIndexerBase(env: Env = process.env): string {
  const raw =
    env.LP_TERMINAL_INDEXER_URL?.trim() ||
    env.NEXT_PUBLIC_LP_TERMINAL_INDEXER_URL?.trim() ||
    DEFAULT_LP_TERMINAL_BASE_URL
  return raw.replace(/\/+$/, '')
}

/** @deprecated Prefer getLpTerminalIndexerBase — always returns a usable origin. */
export function getLpTerminalIndexerUrl(env: Env = process.env): string | null {
  const raw =
    env.LP_TERMINAL_INDEXER_URL?.trim() ||
    env.NEXT_PUBLIC_LP_TERMINAL_INDEXER_URL?.trim() ||
    ''
  if (!raw) return null
  return raw.replace(/\/+$/, '')
}

/** Deep-link a specific pool address into LP Terminal POOLS search. */
export function getLpTerminalPoolDeepLink(
  poolOrTokenAddress?: string | null,
  env: Env = process.env,
): string {
  return getLpTerminalPoolsUrl(poolOrTokenAddress, env)
}

/**
 * Open the POOLS tab. Token CA is appended as `q=` after the hash so users can
 * paste/search if the SPA ignores it; we also expose copy helpers on the card.
 */
export function getLpTerminalPoolsUrl(
  tokenAddress?: string | null,
  env: Env = process.env,
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
