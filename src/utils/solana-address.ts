import { PublicKey } from '@solana/web3.js'

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Strip whitespace and validate as a Solana public key. */
export function normalizeSolanaAddress(raw: string): string | null {
  const compact = raw.replace(/\s+/g, '').trim()
  if (!BASE58.test(compact)) return null
  try {
    return new PublicKey(compact).toBase58()
  } catch {
    return null
  }
}

export function isValidSolanaAddress(raw: string): boolean {
  return normalizeSolanaAddress(raw) !== null
}

/**
 * True only for a real base58 Solana wallet. Paper-trading "wallets" are labels (`gmgn-sim`,
 * `mcap-tracker-sim`, `trending-bot-sim-rh`, `social-sim`, ...) with no on-chain account: asking
 * Shyft/Jupiter/RPC for their holdings can only 400 ("Non-base58", "Missing address") and, at ~120
 * SL/TP lookups an hour, was most of the error log.
 */
export function isOnChainWalletAddress(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && isValidSolanaAddress(raw)
}
