import { query, queryOne } from '@/utils/db';
import type { WalletWatchlistEntry } from '@/types/watchlist';
import { assertDbWritable, formatDbError } from '@/utils/db-health';
import { getTokenPrice } from '@/utils/jupiter-api';

export const MAX_WATCHLIST_SIZE = 30;

function mapEntry(row: Record<string, unknown>): WalletWatchlistEntry {
  return {
    id: String(row.id),
    wallet_address: String(row.wallet_address),
    token_address: String(row.token_address),
    token_symbol: row.token_symbol ? String(row.token_symbol) : null,
    logo_url: row.logo_url ? String(row.logo_url) : null,
    initial_price_usd:
      row.initial_price_usd != null ? Number(row.initial_price_usd) : null,
    added_at: String(row.added_at),
  };
}

async function resolveInitialPrice(
  tokenAddress: string,
  provided?: number | null,
): Promise<number | null> {
  if (provided != null && provided > 0) {
    return provided;
  }

  try {
    const price = await getTokenPrice(tokenAddress);
    return price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function getWatchlist(
  walletAddress: string,
): Promise<WalletWatchlistEntry[]> {
  try {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM wallet_watchlist
       WHERE wallet_address = $1
       ORDER BY added_at DESC`,
      [walletAddress],
    );
    return rows.map(mapEntry);
  } catch (error) {
    console.warn('[watchlist/db] getWatchlist:', formatDbError(error));
    return [];
  }
}

export async function addWatchlistEntry(input: {
  wallet_address: string;
  token_address: string;
  token_symbol?: string | null;
  logo_url?: string | null;
  initial_price_usd?: number | null;
}): Promise<WalletWatchlistEntry> {
  const existing = await getWatchlist(input.wallet_address);
  const current = existing.find(
    (e) => e.token_address === input.token_address,
  );

  if (!current && existing.length >= MAX_WATCHLIST_SIZE) {
    throw new Error(`Watchlist limit reached (${MAX_WATCHLIST_SIZE} tokens)`);
  }

  if (current) {
    try {
      const row = await queryOne<Record<string, unknown>>(
        `UPDATE wallet_watchlist SET
           token_symbol = COALESCE($3, token_symbol),
           logo_url = COALESCE($4, logo_url)
         WHERE wallet_address = $1 AND token_address = $2
         RETURNING *`,
        [
          input.wallet_address,
          input.token_address,
          input.token_symbol ?? current.token_symbol,
          input.logo_url ?? current.logo_url,
        ],
      );
      if (!row) throw new Error('Watchlist entry not found');
      return mapEntry(row);
    } catch (error) {
      assertDbWritable(error);
      throw new Error(formatDbError(error));
    }
  }

  const initial_price_usd = await resolveInitialPrice(
    input.token_address,
    input.initial_price_usd,
  );

  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO wallet_watchlist (
         wallet_address, token_address, token_symbol, logo_url, initial_price_usd
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.wallet_address,
        input.token_address,
        input.token_symbol ?? null,
        input.logo_url ?? null,
        initial_price_usd,
      ],
    );
    if (!row) throw new Error('Insert failed');
    return mapEntry(row);
  } catch (error) {
    assertDbWritable(error);
    throw new Error(formatDbError(error));
  }
}

export async function removeWatchlistEntry(
  walletAddress: string,
  tokenAddress: string,
): Promise<void> {
  try {
    await query(
      `DELETE FROM wallet_watchlist WHERE wallet_address = $1 AND token_address = $2`,
      [walletAddress, tokenAddress],
    );
  } catch (error) {
    assertDbWritable(error);
    throw new Error(formatDbError(error));
  }
}
