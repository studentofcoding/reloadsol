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
