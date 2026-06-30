import { query, queryOne } from '@/utils/db';
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
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM token_rug_list ORDER BY added_at DESC`,
    );
    return rows.map(mapRugEntry);
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
    const row = await queryOne<{ token_address: string }>(
      `SELECT token_address FROM token_rug_list WHERE token_address = $1 LIMIT 1`,
      [tokenAddress],
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
}): Promise<TokenRugEntry> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO token_rug_list (token_address, token_symbol, source, added_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_address) DO UPDATE SET
         token_symbol = EXCLUDED.token_symbol,
         source = EXCLUDED.source,
         added_at = EXCLUDED.added_at
       RETURNING *`,
      [
        input.token_address,
        input.token_symbol ?? null,
        input.source,
        new Date().toISOString(),
      ],
    );
    if (!row) throw new Error('Upsert failed');
    return mapRugEntry(row);
  } catch (error) {
    assertDbWritable(error);
    throw error instanceof DbUnavailableError ? error : new Error(formatDbError(error));
  }
}

export async function removeRugEntry(tokenAddress: string): Promise<void> {
  try {
    await query(`DELETE FROM token_rug_list WHERE token_address = $1`, [
      tokenAddress,
    ]);
  } catch (error) {
    assertDbWritable(error);
  }
}
