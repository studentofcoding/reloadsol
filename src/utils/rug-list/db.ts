import { query, queryOne } from '@/utils/db';
import type { TokenRugEntry, TokenRugSource } from '@/types/rug-list';
import type { AppNetwork } from '@/utils/app-network';
import { parseDbChain } from '@/utils/app-network-db';
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

export async function getRugList(
  chain: AppNetwork = 'sol',
): Promise<TokenRugEntry[]> {
  try {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM token_rug_list WHERE chain = $1 ORDER BY added_at DESC`,
      [chain],
    );
    return rows.map(mapRugEntry);
  } catch (error) {
    logDbReadFallback('getRugList', error);
    return [];
  }
}

export async function getRugAddressSet(
  chain: AppNetwork = 'sol',
): Promise<Set<string>> {
  const entries = await getRugList(chain);
  return new Set(entries.map((e) => e.token_address));
}

export async function isTokenRugged(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
): Promise<boolean> {
  try {
    const row = await queryOne<{ token_address: string }>(
      `SELECT token_address FROM token_rug_list
       WHERE token_address = $1 AND chain = $2 LIMIT 1`,
      [tokenAddress, chain],
    );
    return Boolean(row);
  } catch (error) {
    logDbReadFallback('isTokenRugged', error);
    return false;
  }
}

export async function addRugEntry(input: {
  token_address: string;
  token_symbol?: string | null;
  source: TokenRugSource;
  chain?: AppNetwork;
}): Promise<TokenRugEntry> {
  const chain = parseDbChain(input.chain);
  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO token_rug_list (token_address, token_symbol, source, added_at, chain)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_address, chain) DO UPDATE SET
         token_symbol = EXCLUDED.token_symbol,
         source = EXCLUDED.source,
         added_at = EXCLUDED.added_at
       RETURNING *`,
      [
        input.token_address,
        input.token_symbol ?? null,
        input.source,
        new Date().toISOString(),
        chain,
      ],
    );
    if (!row) throw new Error('Upsert failed');
    return mapRugEntry(row);
  } catch (error) {
    assertDbWritable(error);
    throw error instanceof DbUnavailableError ? error : new Error(formatDbError(error));
  }
}

export async function removeRugEntry(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
): Promise<void> {
  try {
    await query(
      `DELETE FROM token_rug_list WHERE token_address = $1 AND chain = $2`,
      [tokenAddress, chain],
    );
  } catch (error) {
    assertDbWritable(error);
  }
}
