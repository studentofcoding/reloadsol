import { query, queryOne } from '@/utils/db'
import type { RhUniv2Position, RhUniv2PositionStatus } from '@/types/dlmm'
import {
  DbUnavailableError,
  assertDbWritable,
  formatDbError,
  isDbConnectivityError,
} from '@/utils/db-health'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS rh_univ2_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_address TEXT NOT NULL,
  pair_label TEXT,
  token_address TEXT NOT NULL,
  quote_symbol TEXT NOT NULL CHECK (quote_symbol IN ('USDG', 'WETH')),
  owner_address TEXT NOT NULL,
  lp_token_address TEXT NOT NULL,
  entry_quote_amount NUMERIC NOT NULL DEFAULT 0,
  entry_value_usd NUMERIC NOT NULL DEFAULT 0,
  current_value_usd NUMERIC NOT NULL DEFAULT 0,
  pnl_pct NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending')),
  add_tx TEXT,
  remove_tx TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rh_univ2_positions_status ON rh_univ2_positions(status);
CREATE INDEX IF NOT EXISTS idx_rh_univ2_positions_owner ON rh_univ2_positions(owner_address);
CREATE INDEX IF NOT EXISTS idx_rh_univ2_positions_pool ON rh_univ2_positions(pool_address);
`

let ensured = false

export async function ensureRhUniv2PositionsTable(): Promise<void> {
  if (ensured) return
  await query(ENSURE_SQL)
  ensured = true
}

function mapRow(row: Record<string, unknown>): RhUniv2Position {
  const quote = String(row.quote_symbol)
  return {
    id: String(row.id),
    pool_address: String(row.pool_address),
    pair_label: row.pair_label != null ? String(row.pair_label) : null,
    token_address: String(row.token_address),
    quote_symbol: quote === 'WETH' ? 'WETH' : 'USDG',
    owner_address: String(row.owner_address),
    lp_token_address: String(row.lp_token_address),
    entry_quote_amount: Number(row.entry_quote_amount) || 0,
    entry_value_usd: Number(row.entry_value_usd) || 0,
    current_value_usd: Number(row.current_value_usd) || 0,
    pnl_pct: Number(row.pnl_pct) || 0,
    status: String(row.status) as RhUniv2PositionStatus,
    add_tx: row.add_tx != null ? String(row.add_tx) : null,
    remove_tx: row.remove_tx != null ? String(row.remove_tx) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at != null ? String(row.closed_at) : null,
  }
}

export async function listRhUniv2Positions(
  status?: string,
): Promise<RhUniv2Position[]> {
  try {
    await ensureRhUniv2PositionsTable()
    const { rows } = status
      ? await query<Record<string, unknown>>(
          `SELECT * FROM rh_univ2_positions WHERE status = $1 ORDER BY updated_at DESC`,
          [status],
        )
      : await query<Record<string, unknown>>(
          `SELECT * FROM rh_univ2_positions ORDER BY updated_at DESC`,
        )
    return rows.map(mapRow)
  } catch (error) {
    if (isDbConnectivityError(error)) return []
    console.warn('[rh-univ2-db] list:', formatDbError(error))
    return []
  }
}

export async function getRhUniv2Position(
  id: string,
): Promise<RhUniv2Position | null> {
  await ensureRhUniv2PositionsTable()
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM rh_univ2_positions WHERE id = $1`,
    [id],
  )
  return row ? mapRow(row) : null
}

export type InsertRhUniv2PositionInput = {
  pool_address: string
  pair_label?: string | null
  token_address: string
  quote_symbol: 'USDG' | 'WETH'
  owner_address: string
  lp_token_address: string
  entry_quote_amount: number
  entry_value_usd: number
  current_value_usd?: number
  add_tx?: string | null
  status?: RhUniv2PositionStatus
}

export async function insertRhUniv2Position(
  row: InsertRhUniv2PositionInput,
): Promise<RhUniv2Position> {
  try {
    await ensureRhUniv2PositionsTable()
    const inserted = await queryOne<Record<string, unknown>>(
      `INSERT INTO rh_univ2_positions (
         pool_address, pair_label, token_address, quote_symbol, owner_address,
         lp_token_address, entry_quote_amount, entry_value_usd, current_value_usd,
         pnl_pct, status, add_tx, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,NOW())
       RETURNING *`,
      [
        row.pool_address,
        row.pair_label ?? null,
        row.token_address,
        row.quote_symbol,
        row.owner_address,
        row.lp_token_address,
        row.entry_quote_amount,
        row.entry_value_usd,
        row.current_value_usd ?? row.entry_value_usd,
        row.status ?? 'open',
        row.add_tx ?? null,
      ],
    )
    if (!inserted) throw new Error('Insert failed')
    return mapRow(inserted)
  } catch (error) {
    assertDbWritable(error)
    throw error
  }
}

export async function updateRhUniv2Position(
  id: string,
  patch: Partial<{
    current_value_usd: number
    pnl_pct: number
    status: RhUniv2PositionStatus
    remove_tx: string | null
    closed_at: string | null
  }>,
): Promise<RhUniv2Position> {
  try {
    await ensureRhUniv2PositionsTable()
    const sets: string[] = ['updated_at = NOW()']
    const values: unknown[] = []
    let i = 1
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      sets.push(`${key} = $${i++}`)
      values.push(value)
    }
    values.push(id)
    const updated = await queryOne<Record<string, unknown>>(
      `UPDATE rh_univ2_positions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    )
    if (!updated) throw new Error('Position not found')
    return mapRow(updated)
  } catch (error) {
    if (error instanceof DbUnavailableError) throw error
    assertDbWritable(error)
    throw error
  }
}
