import { PublicKey, VersionedTransaction } from '@solana/web3.js'

export type SolSignerMode = 'server' | 'wallet'

/**
 * Server-sign only when both pubkeys parse and are the same account.
 * Missing, mismatched, or unreadable keys stay on the wallet confirm path.
 */
export function chooseSolSignerMode(
  connectedPublicKey: string | null | undefined,
  serverPublicKey: string | null | undefined,
): SolSignerMode {
  const connected = connectedPublicKey?.trim()
  const server = serverPublicKey?.trim()
  if (!connected || !server) return 'wallet'
  try {
    return new PublicKey(connected).equals(new PublicKey(server)) ? 'server' : 'wallet'
  } catch {
    return 'wallet'
  }
}

const SERVER_PUBKEY_CACHE_MS = 5_000
let cachedServerPublicKey: { value: string; at: number } | null = null

async function fetchServerTradingPublicKey(): Promise<string | null> {
  // Server jobs (arb, bots) keep the signer they were given. No browser session.
  if (typeof window === 'undefined') return null
  if (
    cachedServerPublicKey &&
    Date.now() - cachedServerPublicKey.at < SERVER_PUBKEY_CACHE_MS
  ) {
    return cachedServerPublicKey.value
  }
  const res = await fetch('/api/trade/server-sign', { credentials: 'include' })
  if (!res.ok) return null
  const data = (await res.json()) as { publicKey?: unknown }
  const publicKey =
    typeof data.publicKey === 'string' && data.publicKey.trim()
      ? data.publicKey.trim()
      : null
  if (publicKey) {
    cachedServerPublicKey = { value: publicKey, at: Date.now() }
  }
  return publicKey
}

export async function resolveSolSignerMode(
  connectedPublicKey: string,
  lookupPublicKey: () => Promise<string | null> = fetchServerTradingPublicKey,
): Promise<SolSignerMode> {
  try {
    const serverPublicKey = await lookupPublicKey()
    return chooseSolSignerMode(connectedPublicKey, serverPublicKey)
  } catch {
    return 'wallet'
  }
}

export async function serverSignVersionedTransactions(
  txs: VersionedTransaction[],
): Promise<VersionedTransaction[]> {
  const res = await fetch('/api/trade/server-sign', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transactions: txs.map((tx) => Buffer.from(tx.serialize()).toString('base64')),
    }),
  })
  let data: { success?: boolean; error?: string; signedTransactions?: unknown } = {}
  try {
    data = (await res.json()) as typeof data
  } catch {
    data = {}
  }
  if (!res.ok || !data.success || !Array.isArray(data.signedTransactions)) {
    throw new Error(
      typeof data.error === 'string' && data.error
        ? data.error
        : 'Server signing failed',
    )
  }
  if (data.signedTransactions.length !== txs.length) {
    throw new Error('Server signing returned an unexpected transaction count')
  }
  return data.signedTransactions.map((encoded) => {
    if (typeof encoded !== 'string') {
      throw new Error('Server signing returned an invalid transaction')
    }
    return VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'))
  })
}

export type SignPreparedSwapDeps = {
  lookupPublicKey?: () => Promise<string | null>
  serverSign?: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>
}

/**
 * Pick the signer for a prepared Solana swap batch.
 * On a pubkey match, the wallet callback is not called.
 */
export async function signPreparedSwapTransactions(input: {
  userPublicKey: string
  transactions: VersionedTransaction[]
  walletSign: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>
  mode?: SolSignerMode
}, deps: SignPreparedSwapDeps = {}): Promise<{
  mode: SolSignerMode
  signed: VersionedTransaction[]
}> {
  const mode =
    input.mode ??
    (await resolveSolSignerMode(
      input.userPublicKey,
      deps.lookupPublicKey,
    ))
  if (input.transactions.length === 0) {
    return { mode, signed: [] }
  }
  if (mode === 'server') {
    const serverSign = deps.serverSign ?? serverSignVersionedTransactions
    return { mode, signed: await serverSign(input.transactions) }
  }
  return { mode: 'wallet', signed: await input.walletSign(input.transactions) }
}
