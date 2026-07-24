import { query, queryOne } from '@/utils/db'
import type { AppNetwork } from '@/utils/app-network'
import { parseDbChain } from '@/utils/app-network-db'
import type { DlmmPotentialSource } from '@/types/dlmm'
import {
  addPotentialEntry,
  getPotentialList,
  removePotentialEntry,
} from '@/utils/dlmm/db'
import { removeRugEntry } from '@/utils/rug-list/db'

export { getPotentialList }

export type MarkTokenPotentialInput = {
  tokenAddress: string
  tokenSymbol?: string | null
  source: DlmmPotentialSource
  notes?: string | null
  chain?: AppNetwork
}

async function syncTradingSignalPotential(
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
      `UPDATE trading_signals SET label = 'potential', updated_at = $3
       WHERE token_address = $1 AND chain = $2`,
      [tokenAddress, chain, now],
    )
    return
  }

  await query(
    `INSERT INTO trading_signals (
       token_address, token_symbol, label, market_cap, price, initial_price,
       updated_at, source, chain
     ) VALUES ($1, $2, 'potential', 0, 0, 0, $3, 'manual', $4)`,
    [tokenAddress, tokenSymbol || 'UNKNOWN', now, chain],
  )
}

async function revertTradingSignalPotential(
  tokenAddress: string,
  chain: AppNetwork,
): Promise<void> {
  const existing = await queryOne<{ label: string | null }>(
    `SELECT label FROM trading_signals WHERE token_address = $1 AND chain = $2 LIMIT 1`,
    [tokenAddress, chain],
  )
  if (!existing || existing.label !== 'potential') return

  await query(
    `UPDATE trading_signals SET label = 'watching', updated_at = $3
     WHERE token_address = $1 AND chain = $2`,
    [tokenAddress, chain, new Date().toISOString()],
  )
}

export async function isTokenPotential(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
): Promise<boolean> {
  const list = await getPotentialList(parseDbChain(chain))
  return list.some((e) => e.token_address === tokenAddress)
}

/** Upsert potential list + sync signal label + OHLC training capture. */
export async function markTokenPotential(input: MarkTokenPotentialInput) {
  const { tokenAddress, tokenSymbol, source, notes } = input
  const chain = parseDbChain(input.chain)

  try {
    await removeRugEntry(tokenAddress, chain)
  } catch {
    /* rug list may be unavailable */
  }

  const entry = await addPotentialEntry({
    token_address: tokenAddress,
    token_symbol: tokenSymbol ?? null,
    source,
    notes: notes ?? null,
    chain,
  })

  try {
    await syncTradingSignalPotential(tokenAddress, tokenSymbol, chain)
  } catch (err) {
    console.warn('[potential-list] signal sync failed', {
      mint: tokenAddress,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  try {
    const { captureSignalOhlcLabel } = await import(
      '@/strategies/signal-ohlc-labels'
    )
    await captureSignalOhlcLabel({
      tokenAddress,
      label: 'potential',
      tokenSymbol,
      source: `potential_${source}`,
    })
  } catch (err) {
    console.warn('[potential-list] OHLC capture failed', {
      mint: tokenAddress,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return entry
}

export async function unmarkTokenPotential(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
): Promise<void> {
  const c = parseDbChain(chain)
  await removePotentialEntry(tokenAddress, c)
  await revertTradingSignalPotential(tokenAddress, c)
}

export async function toggleTokenPotential(
  input: MarkTokenPotentialInput,
): Promise<boolean> {
  const chain = parseDbChain(input.chain)
  const on = await isTokenPotential(input.tokenAddress, chain)
  if (on) {
    await unmarkTokenPotential(input.tokenAddress, chain)
    return false
  }
  await markTokenPotential(input)
  return true
}
