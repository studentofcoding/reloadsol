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
