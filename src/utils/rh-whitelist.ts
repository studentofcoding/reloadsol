/**
 * Robinhood network allowlist — Sol and/or EVM addresses from env.
 * Union with DEV wallets is applied via canUseRobinhoodNetwork().
 */

let cachedRhWhitelist: Set<string> | null = null

function parseWalletList(raw: string): string[] {
  return raw
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
}

/** EVM → lowercase; Sol base58 → trim only. */
export function normalizeRhWhitelistAddress(address: string): string {
  const t = address.trim()
  if (t.startsWith('0x') || t.startsWith('0X')) return t.toLowerCase()
  return t
}

function getRhWhitelistSet(): Set<string> {
  if (cachedRhWhitelist) return cachedRhWhitelist
  const fromEnv = parseWalletList(
    process.env.NEXT_PUBLIC_RH_WHITELIST ||
      process.env.RH_WHITELIST ||
      '',
  )
  cachedRhWhitelist = new Set(fromEnv.map(normalizeRhWhitelistAddress))
  return cachedRhWhitelist
}

export function isRhWhitelisted(address: string | null | undefined): boolean {
  if (!address?.trim()) return false
  return getRhWhitelistSet().has(normalizeRhWhitelistAddress(address))
}

/** RH network if DEV wallet or either address is on RH_WHITELIST. */
export function canUseRobinhoodNetwork(params: {
  solAddress?: string | null
  evmAddress?: string | null
  isDevUser: boolean
}): boolean {
  if (params.isDevUser) return true
  return (
    isRhWhitelisted(params.solAddress ?? null) ||
    isRhWhitelisted(params.evmAddress ?? null)
  )
}

export function getConfiguredRhWhitelist(): string[] {
  return Array.from(getRhWhitelistSet())
}

export function clearRhWhitelistCache(): void {
  cachedRhWhitelist = null
}
