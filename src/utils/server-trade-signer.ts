import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'

/** Same env the bots, SL/TP, and sol-arb already load. Never sent to the browser. */
export const TRADING_KEYPAIR_ENV = 'TRADING_KEYPAIR_JSON'

export const MAX_SERVER_SIGN_TXS = 16
const MAX_TX_BASE64_CHARS = 2_500

export type ServerSignGate =
  | { ok: true; publicKey: string }
  | { ok: false; code: 'NO_SESSION' | 'NO_KEYPAIR' | 'MISMATCH' }

/**
 * Load the server trading keypair from env.
 * Missing or unreadable key material returns null so callers can fall back
 * to a wallet confirm instead of failing the trade.
 */
export function readTradingKeypair(): Keypair | null {
  const raw = process.env[TRADING_KEYPAIR_ENV]?.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (parsed.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
      return null
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed))
  } catch {
    return null
  }
}

export function tradingKeypairPublicKey(): string | null {
  return readTradingKeypair()?.publicKey.toBase58() ?? null
}

export function assertSessionCanServerSign(
  sessionAddress: string | null | undefined,
  tradingPublicKey: string | null | undefined,
): ServerSignGate {
  if (!sessionAddress?.trim()) {
    return { ok: false, code: 'NO_SESSION' }
  }
  if (!tradingPublicKey?.trim()) {
    return { ok: false, code: 'NO_KEYPAIR' }
  }
  try {
    const sessionKey = new PublicKey(sessionAddress.trim())
    const tradingKey = new PublicKey(tradingPublicKey.trim())
    if (!sessionKey.equals(tradingKey)) {
      return { ok: false, code: 'MISMATCH' }
    }
    return { ok: true, publicKey: tradingKey.toBase58() }
  } catch {
    return { ok: false, code: 'MISMATCH' }
  }
}

/** Swaps use the taker as fee payer, which is required signer 0. */
export function transactionFeePayerIs(
  tx: VersionedTransaction,
  publicKey: string,
): boolean {
  try {
    const owner = new PublicKey(publicKey)
    const keys = tx.message.staticAccountKeys
    const required = tx.message.header.numRequiredSignatures
    if (required < 1 || keys.length < 1) return false
    return keys[0].equals(owner)
  } catch {
    return false
  }
}

export function signVersionedWithTradingKeypair(
  txs: VersionedTransaction[],
  keypair: Keypair,
): VersionedTransaction[] {
  const owner = keypair.publicKey.toBase58()
  for (const tx of txs) {
    if (!transactionFeePayerIs(tx, owner)) {
      throw new Error('Transaction fee payer is not the trading keypair')
    }
    tx.sign([keypair])
  }
  return txs
}

export function decodeUnsignedTransactions(encoded: unknown): VersionedTransaction[] {
  if (!Array.isArray(encoded) || encoded.length === 0) {
    throw new Error('transactions must be a non-empty array of base64 versioned transactions')
  }
  if (encoded.length > MAX_SERVER_SIGN_TXS) {
    throw new Error(`At most ${MAX_SERVER_SIGN_TXS} transactions can be signed at once`)
  }
  return encoded.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_TX_BASE64_CHARS) {
      throw new Error(`Transaction ${index} is not a valid base64 payload`)
    }
    try {
      return VersionedTransaction.deserialize(Buffer.from(entry, 'base64'))
    } catch {
      throw new Error(`Transaction ${index} could not be decoded`)
    }
  })
}

export function encodeSignedTransactions(txs: VersionedTransaction[]): string[] {
  // VersionedTransaction.serialize writes the signature slots as they are,
  // including the zero slots on an unsigned transaction.
  return txs.map((tx) => Buffer.from(tx.serialize()).toString('base64'))
}
