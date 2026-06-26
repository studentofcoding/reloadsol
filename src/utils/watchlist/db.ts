import { supabase } from '@/utils/supabase';
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
  const { data, error } = await supabase
    .from('wallet_watchlist')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('added_at', { ascending: false });

  if (error) {
    console.warn('[watchlist/db] getWatchlist:', formatDbError(error));
    return [];
  }

  return (data ?? []).map(mapEntry);
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
    const { data, error } = await supabase
      .from('wallet_watchlist')
      .update({
        token_symbol: input.token_symbol ?? current.token_symbol,
        logo_url: input.logo_url ?? current.logo_url,
      })
      .eq('wallet_address', input.wallet_address)
      .eq('token_address', input.token_address)
      .select('*')
      .single();

    if (error) {
      assertDbWritable(error);
      throw new Error(formatDbError(error));
    }

    return mapEntry(data);
  }

  const initial_price_usd = await resolveInitialPrice(
    input.token_address,
    input.initial_price_usd,
  );

  const { data, error } = await supabase
    .from('wallet_watchlist')
    .insert({
      wallet_address: input.wallet_address,
      token_address: input.token_address,
      token_symbol: input.token_symbol ?? null,
      logo_url: input.logo_url ?? null,
      initial_price_usd,
    })
    .select('*')
    .single();

  if (error) {
    assertDbWritable(error);
    throw new Error(formatDbError(error));
  }

  return mapEntry(data);
}

export async function removeWatchlistEntry(
  walletAddress: string,
  tokenAddress: string,
): Promise<void> {
  const { error } = await supabase
    .from('wallet_watchlist')
    .delete()
    .eq('wallet_address', walletAddress)
    .eq('token_address', tokenAddress);

  if (error) {
    assertDbWritable(error);
    throw new Error(formatDbError(error));
  }
}
