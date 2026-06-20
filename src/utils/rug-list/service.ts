import { supabase } from '@/utils/supabase';
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
  const { data: existing } = await supabase
    .from('trading_signals')
    .select('token_address, token_symbol, source')
    .eq('token_address', tokenAddress)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('trading_signals')
      .update({ label: 'rugged', updated_at: now })
      .eq('token_address', tokenAddress);
    return;
  }

  await supabase.from('trading_signals').insert({
    token_address: tokenAddress,
    token_symbol: tokenSymbol || 'UNKNOWN',
    label: 'rugged',
    market_cap: 0,
    price: 0,
    initial_price: 0,
    updated_at: now,
    source: 'manual',
  });
}

async function syncMcapTrackingRugged(tokenAddress: string): Promise<void> {
  const { data: existing } = await supabase
    .from('token_mcap_tracking')
    .select('token_address')
    .eq('token_address', tokenAddress)
    .maybeSingle();

  if (!existing) return;

  await supabase
    .from('token_mcap_tracking')
    .update({ label: 'rugged', last_updated_at: new Date().toISOString() })
    .eq('token_address', tokenAddress);
}

async function revertTradingSignalRugged(tokenAddress: string): Promise<void> {
  const { data: existing } = await supabase
    .from('trading_signals')
    .select('label')
    .eq('token_address', tokenAddress)
    .maybeSingle();

  if (!existing || existing.label !== 'rugged') return;

  await supabase
    .from('trading_signals')
    .update({
      label: 'watching',
      updated_at: new Date().toISOString(),
    })
    .eq('token_address', tokenAddress);
}

async function revertMcapTrackingRugged(tokenAddress: string): Promise<void> {
  const { data: existing } = await supabase
    .from('token_mcap_tracking')
    .select('label')
    .eq('token_address', tokenAddress)
    .maybeSingle();

  if (!existing || existing.label !== 'rugged') return;

  await supabase
    .from('token_mcap_tracking')
    .update({
      label: 'watching',
      last_updated_at: new Date().toISOString(),
    })
    .eq('token_address', tokenAddress);
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
