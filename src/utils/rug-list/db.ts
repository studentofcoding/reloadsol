import { supabase } from '@/utils/supabase';
import type { TokenRugEntry, TokenRugSource } from '@/types/rug-list';
import {
  DbUnavailableError,
  assertDbWritable,
  formatDbError,
  isDbConnectivityError,
} from '@/utils/db-health';

function logDbReadFallback(context: string, error: unknown) {
  if (isDbConnectivityError(error)) {
    console.warn(`[rug-list] ${context}: DB unavailable, returning empty`);
    return;
  }
  console.error(`[rug-list] ${context}:`, formatDbError(error));
}

function mapRugEntry(row: Record<string, unknown>): TokenRugEntry {
  return {
    id: String(row.id),
    token_address: String(row.token_address),
    token_symbol: row.token_symbol ? String(row.token_symbol) : null,
    source: row.source as TokenRugSource,
    added_at: String(row.added_at),
  };
}

export async function getRugList(): Promise<TokenRugEntry[]> {
  try {
    const { data, error } = await supabase
      .from('token_rug_list')
      .select('*')
      .order('added_at', { ascending: false });

    if (error) throw error;
    return (data ?? []).map(mapRugEntry);
  } catch (error) {
    logDbReadFallback('getRugList', error);
    return [];
  }
}

export async function getRugAddressSet(): Promise<Set<string>> {
  const entries = await getRugList();
  return new Set(entries.map((e) => e.token_address));
}

export async function isTokenRugged(tokenAddress: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('token_rug_list')
      .select('token_address')
      .eq('token_address', tokenAddress)
      .maybeSingle();

    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    logDbReadFallback('isTokenRugged', error);
    return false;
  }
}

export async function addRugEntry(input: {
  token_address: string;
  token_symbol?: string | null;
  source: TokenRugSource;
}): Promise<TokenRugEntry> {
  try {
    const { data, error } = await supabase
      .from('token_rug_list')
      .upsert(
        {
          token_address: input.token_address,
          token_symbol: input.token_symbol ?? null,
          source: input.source,
          added_at: new Date().toISOString(),
        },
        { onConflict: 'token_address' },
      )
      .select('*')
      .single();

    if (error) throw error;
    return mapRugEntry(data);
  } catch (error) {
    assertDbWritable(error);
    throw error instanceof DbUnavailableError ? error : new Error(formatDbError(error));
  }
}

export async function removeRugEntry(tokenAddress: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('token_rug_list')
      .delete()
      .eq('token_address', tokenAddress);
    if (error) throw error;
  } catch (error) {
    assertDbWritable(error);
  }
}
