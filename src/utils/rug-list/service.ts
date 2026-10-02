/**
 * Rug list write path: token_rug_list is source of truth;
 * trading_signals / token_mcap_tracking get best-effort sync for legacy UI.
 */

import { query, queryOne } from '@/utils/db'
import type { AppNetwork } from '@/utils/app-network'
import { parseDbChain } from '@/utils/app-network-db'
import type { TokenRugSource } from '@/types/rug-list'
import {
  addRugEntry,
  getRugList,
  isTokenRugged,
  removeRugEntry,
} from '@/utils/rug-list/db'
import { removePotentialEntry } from '@/utils/dlmm/db'

export { getRugList, isTokenRugged }

export type MarkTokenRugInput = {
  tokenAddress: string
  tokenSymbol?: string | null
  source: TokenRugSource
  chain?: AppNetwork
}

/**
 * Sources that are our own rules rather than a user's judgement. Everything else (live, signals,
 * board, tracker, dlmm, freeview, …) is a user label and counts toward the dev's user-rug total.
 * A new automated writer must be added here, or its verdicts will read as user signals.
 */
const AUTOMATED_RUG_SOURCES: ReadonlySet<string> = new Set([
  'gmgn-radar',
  'concentration',
  'rug-signal',
])

/** The token's creator: what the risk shadow already stored, else the Jupiter last resort. */
async function resolveTokenDev(chain: string, tokenAddress: string): Promise<string | null> {
  const stored = await queryOne<{ creator_address: string | null }>(
    `SELECT creator_address FROM token_risk_features
      WHERE chain = $1 AND token_address = $2`,
    [chain, tokenAddress],
  )
  if (stored?.creator_address) return stored.creator_address

  try {
    const { resolveCreatorAddress } = await import('@/utils/dev-reputation-data')
    return await resolveCreatorAddress({ chain, info: {}, mint: tokenAddress })
  } catch {
    return null
  }
}

/**
 * Attribute a user rug label to the token's dev (display-only signal). Best-effort: the label write
 * itself must never fail because of this, and an unknown creator is skipped rather than invented.
 */
async function attributeUserRug(input: {
  chain: string
  tokenAddress: string
  symbol?: string | null
  source: string
}): Promise<void> {
  if (AUTOMATED_RUG_SOURCES.has(input.source)) return
  try {
    const creatorAddress = await resolveTokenDev(input.chain, input.tokenAddress)
    if (!creatorAddress) return
    const { recordUserRug } = await import('@/strategies/risk-store')
    await recordUserRug({
      chain: input.chain,
      creatorAddress,
      tokenAddress: input.tokenAddress,
      symbol: input.symbol,
      source: input.source,
    })
  } catch (error) {
    console.warn('[rug-list] user rug attribution failed', {
      mint: input.tokenAddress,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Undo the attribution on unmark. A no-op when the token was never counted. */
async function detachUserRug(chain: string, tokenAddress: string): Promise<void> {
  try {
    const creatorAddress = await resolveTokenDev(chain, tokenAddress)
    if (!creatorAddress) return
    const { clearUserRug } = await import('@/strategies/risk-store')
    await clearUserRug({ chain, creatorAddress, tokenAddress })
  } catch (error) {
    console.warn('[rug-list] user rug detach failed', {
      mint: tokenAddress,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function syncTradingSignalRugged(
  tokenAddress: string,
  tokenSymbol: string | null | undefined,
  chain: AppNetwork,
): Promise<void> {
  const now = new Date().toISOString()
  const existing = await queryOne<{ token_address: string }>(
    `SELECT token_address FROM trading_signals
     WHERE token_address = $1 AND chain = $2 LIMIT 1`,
    [tokenAddress, chain],
  )

  if (existing) {
    await query(
      `UPDATE trading_signals SET label = 'rugged', updated_at = $3
       WHERE token_address = $1 AND chain = $2`,
      [tokenAddress, chain, now],
    )
    return
  }

  await query(
    `INSERT INTO trading_signals (
       token_address, token_symbol, label, market_cap, price, initial_price,
       updated_at, source, chain
     ) VALUES ($1, $2, 'rugged', 0, 0, 0, $3, 'manual', $4)`,
    [tokenAddress, tokenSymbol || 'UNKNOWN', now, chain],
  )
}

async function syncMcapTrackingRugged(tokenAddress: string): Promise<void> {
  const existing = await queryOne<{ token_address: string }>(
    `SELECT token_address FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  )

  if (!existing) return

  await query(
    `UPDATE token_mcap_tracking SET label = 'rugged', last_updated_at = $2
     WHERE token_address = $1`,
    [tokenAddress, new Date().toISOString()],
  )
}

async function revertTradingSignalRugged(
  tokenAddress: string,
  chain: AppNetwork,
): Promise<void> {
  const existing = await queryOne<{ label: string | null }>(
    `SELECT label FROM trading_signals WHERE token_address = $1 AND chain = $2 LIMIT 1`,
    [tokenAddress, chain],
  )

  if (!existing || existing.label !== 'rugged') return

  await query(
    `UPDATE trading_signals SET label = 'watching', updated_at = $3
     WHERE token_address = $1 AND chain = $2`,
    [tokenAddress, chain, new Date().toISOString()],
  )
}

async function revertMcapTrackingRugged(tokenAddress: string): Promise<void> {
  const existing = await queryOne<{ label: string | null }>(
    `SELECT label FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  )

  if (!existing || existing.label !== 'rugged') return

  await query(
    `UPDATE token_mcap_tracking SET label = 'watching', last_updated_at = $2
     WHERE token_address = $1`,
    [tokenAddress, new Date().toISOString()],
  )
}

/** Single write path: upsert rug list + sync legacy labels + drop from DLMM potential. */
export async function markTokenRug(input: MarkTokenRugInput) {
  const { tokenAddress, tokenSymbol, source } = input
  const chain = parseDbChain(input.chain)

  try {
    await removePotentialEntry(tokenAddress, chain)
  } catch {
    // potential list may be unavailable in dev without schema
  }

  const entry = await addRugEntry({
    token_address: tokenAddress,
    token_symbol: tokenSymbol ?? null,
    source,
    chain,
  })

  await syncTradingSignalRugged(tokenAddress, tokenSymbol, chain)
  await syncMcapTrackingRugged(tokenAddress)

  // Best-effort OHLC snapshot for rug gallery (await so route doesn't drop it)
  try {
    const { captureSignalOhlcLabel } = await import(
      '@/strategies/signal-ohlc-labels'
    )
    await captureSignalOhlcLabel({
      tokenAddress,
      label: 'rug',
      tokenSymbol,
      source: `rug_${source}`,
    })
  } catch (err) {
    console.warn('[rug-list] OHLC capture failed', {
      mint: tokenAddress,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Count it against the dev when a user is the one saying "rug".
  await attributeUserRug({ chain, tokenAddress, symbol: tokenSymbol, source })

  return entry
}

/** Remove from rug list and revert legacy labels where they were rugged. */
export async function unmarkTokenRug(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
): Promise<void> {
  const c = parseDbChain(chain)
  await removeRugEntry(tokenAddress, c)
  await revertTradingSignalRugged(tokenAddress, c)
  await revertMcapTrackingRugged(tokenAddress)
  await detachUserRug(c, tokenAddress)
}

/** Toggle rug state; returns new rugged status. */
export async function toggleTokenRug(input: MarkTokenRugInput): Promise<boolean> {
  const chain = parseDbChain(input.chain)
  const rugged = await isTokenRugged(input.tokenAddress, chain)
  if (rugged) {
    await unmarkTokenRug(input.tokenAddress, chain)
    return false
  }
  await markTokenRug(input)
  return true
}
