import { query, queryOne } from '@/utils/db';
import type { TokenRugSource } from '@/types/rug-list';
import { removePotentialEntry } from '@/utils/dlmm/db';
import {
  addRugEntry,
  getRugList,
  isTokenRugged,
  removeRugEntry,
  getRugAddressSet,
} from '@/utils/rug-list/db';

export { getRugList, getRugAddressSet, isTokenRugged };

type MarkTokenRugInput = {
  tokenAddress: string;
  tokenSymbol?: string | null;
  source: TokenRugSource;
};

async function syncTradingSignalRugged(
  tokenAddress: string,
  tokenSymbol?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await queryOne<{
    token_address: string;
    token_symbol: string | null;
    source: string;
  }>(
    `SELECT token_address, token_symbol, source FROM trading_signals
     WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  );

  if (existing) {
    await query(
      `UPDATE trading_signals SET label = 'rugged', updated_at = $2
       WHERE token_address = $1`,
      [tokenAddress, now],
    );
    return;
  }

  await query(
    `INSERT INTO trading_signals (
       token_address, token_symbol, label, market_cap, price, initial_price,
       updated_at, source
     ) VALUES ($1, $2, 'rugged', 0, 0, 0, $3, 'manual')`,
    [tokenAddress, tokenSymbol || 'UNKNOWN', now],
  );
}

async function syncMcapTrackingRugged(tokenAddress: string): Promise<void> {
  const existing = await queryOne<{ token_address: string }>(
    `SELECT token_address FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  );

  if (!existing) return;

  await query(
    `UPDATE token_mcap_tracking SET label = 'rugged', last_updated_at = $2
     WHERE token_address = $1`,
    [tokenAddress, new Date().toISOString()],
  );
}

async function revertTradingSignalRugged(tokenAddress: string): Promise<void> {
  const existing = await queryOne<{ label: string | null }>(
    `SELECT label FROM trading_signals WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  );

  if (!existing || existing.label !== 'rugged') return;

  await query(
    `UPDATE trading_signals SET label = 'watching', updated_at = $2
     WHERE token_address = $1`,
    [tokenAddress, new Date().toISOString()],
  );
}

async function revertMcapTrackingRugged(tokenAddress: string): Promise<void> {
  const existing = await queryOne<{ label: string | null }>(
    `SELECT label FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
    [tokenAddress],
  );

  if (!existing || existing.label !== 'rugged') return;

  await query(
    `UPDATE token_mcap_tracking SET label = 'watching', last_updated_at = $2
     WHERE token_address = $1`,
    [tokenAddress, new Date().toISOString()],
  );
}

/** Single write path: upsert rug list + sync legacy labels + drop from DLMM potential. */
export async function markTokenRug(input: MarkTokenRugInput) {
  const { tokenAddress, tokenSymbol, source } = input;

  try {
    await removePotentialEntry(tokenAddress);
  } catch {
    // potential list may be unavailable in dev without schema
  }

  const entry = await addRugEntry({
    token_address: tokenAddress,
    token_symbol: tokenSymbol ?? null,
    source,
  });

  await syncTradingSignalRugged(tokenAddress, tokenSymbol);
  await syncMcapTrackingRugged(tokenAddress);

  // Best-effort OHLC snapshot for rug gallery (await so route doesn't drop it)
  try {
    const { captureSignalOhlcLabel } = await import(
      '@/strategies/signal-ohlc-labels'
    );
    await captureSignalOhlcLabel({
      tokenAddress,
      label: 'rug',
      tokenSymbol,
      source: `rug_${source}`,
    });
  } catch (err) {
    console.warn('[rug-list] OHLC capture failed', {
      mint: tokenAddress,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return entry;
}

/** Remove from rug list and revert legacy labels where they were rugged. */
export async function unmarkTokenRug(tokenAddress: string): Promise<void> {
  await removeRugEntry(tokenAddress);
  await revertTradingSignalRugged(tokenAddress);
  await revertMcapTrackingRugged(tokenAddress);
}

/** Toggle rug state; returns new rugged status. */
export async function toggleTokenRug(input: MarkTokenRugInput): Promise<boolean> {
  const rugged = await isTokenRugged(input.tokenAddress);
  if (rugged) {
    await unmarkTokenRug(input.tokenAddress);
    return false;
  }
  await markTokenRug(input);
  return true;
}
