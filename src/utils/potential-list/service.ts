import { query, queryOne } from '@/utils/db'
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
}

async function syncTradingSignalPotential(
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  const existing = await queryOne<{ token_address: string }>(
    `SELECT token_address FROM trading_signals
     WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  )

  if (existing) {
    await query(
      `UPDATE trading_signals SET label = 'potential', updated_at = $2
       WHERE token_address = $1`,
      [tokenAddress, now],
    )
    return
  }

  await query(
    `INSERT INTO trading_signals (
       token_address, token_symbol, label, market_cap, price, initial_price,
       updated_at, source
     ) VALUES ($1, $2, 'potential', 0, 0, 0, $3, 'manual')`,
    [tokenAddress, tokenSymbol || 'UNKNOWN', now],
  )
}

async function revertTradingSignalPotential(
  tokenAddress: string,
): Promise<void> {
  const existing = await queryOne<{ label: string | null }>(
    `SELECT label FROM trading_signals WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  )
  if (!existing || existing.label !== 'potential') return

  await query(
    `UPDATE trading_signals SET label = 'watching', updated_at = $2
     WHERE token_address = $1`,
    [tokenAddress, new Date().toISOString()],
  )
}

export async function isTokenPotential(tokenAddress: string): Promise<boolean> {
  const list = await getPotentialList()
  return list.some((e) => e.token_address === tokenAddress)
}

/** Upsert potential list + sync signal label + OHLC training capture. */
export async function markTokenPotential(input: MarkTokenPotentialInput) {
  const { tokenAddress, tokenSymbol, source, notes } = input

  try {
    await removeRugEntry(tokenAddress)
  } catch {
    /* rug list may be unavailable */
  }

  const entry = await addPotentialEntry({
    token_address: tokenAddress,
    token_symbol: tokenSymbol ?? null,
    source,
    notes: notes ?? null,
  })

  try {
    await syncTradingSignalPotential(tokenAddress, tokenSymbol)
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
): Promise<void> {
  await removePotentialEntry(tokenAddress)
  await revertTradingSignalPotential(tokenAddress)
}

export async function toggleTokenPotential(
  input: MarkTokenPotentialInput,
): Promise<boolean> {
  if (await isTokenPotential(input.tokenAddress)) {
    await unmarkTokenPotential(input.tokenAddress)
    return false
  }
  await markTokenPotential(input)
  return true
}
