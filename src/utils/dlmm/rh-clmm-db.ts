import { query, queryOne } from '@/utils/db'
import type {
  RhClmmLiveRow,
  RhClmmPosition,
  RhClmmPositionStatus,
  RhClmmProtocol,
} from '@/types/dlmm'
import {
  DbUnavailableError,
  assertDbWritable,
  formatDbError,
  isDbConnectivityError,
} from '@/utils/db-health'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS rh_clmm_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('v3', 'v4')),
  pool_address TEXT NOT NULL,
  pair_label TEXT,
  token_address TEXT,
  deposit_symbol TEXT,
  owner_address TEXT NOT NULL,
  entry_value_usd NUMERIC NOT NULL DEFAULT 0,
  current_value_usd NUMERIC NOT NULL DEFAULT 0,
  pnl_pct NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending')),
  mint_tx TEXT,
  close_tx TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  unclaimed_fees_usd NUMERIC NOT NULL DEFAULT 0,
  in_range BOOLEAN,
  tick_lower INTEGER,
  tick_upper INTEGER,
  symbol0 TEXT,
  symbol1 TEXT,
  liquidity TEXT,
  live_synced_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_clmm_positions_token
  ON rh_clmm_positions (owner_address, protocol, token_id);
CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_status ON rh_clmm_positions(status);
CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_owner ON rh_clmm_positions(owner_address);
`

const MIGRATE_LIVE_SQL = `
ALTER TABLE rh_clmm_positions
  ADD COLUMN IF NOT EXISTS unclaimed_fees_usd NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_range BOOLEAN,
  ADD COLUMN IF NOT EXISTS tick_lower INTEGER,
  ADD COLUMN IF NOT EXISTS tick_upper INTEGER,
  ADD COLUMN IF NOT EXISTS symbol0 TEXT,
  ADD COLUMN IF NOT EXISTS symbol1 TEXT,
  ADD COLUMN IF NOT EXISTS liquidity TEXT,
  ADD COLUMN IF NOT EXISTS live_synced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_rh_clmm_positions_live_synced
  ON rh_clmm_positions (owner_address, live_synced_at DESC)
  WHERE status = 'open';
`

let ensured = false

export async function ensureRhClmmPositionsTable(): Promise<void> {
  if (ensured) return
  await query(ENSURE_SQL)
  await query(MIGRATE_LIVE_SQL)
  ensured = true
}

function mapRow(row: Record<string, unknown>): RhClmmPosition {
  const protocol = String(row.protocol) === 'v4' ? 'v4' : 'v3'
  return {
    id: String(row.id),
    token_id: String(row.token_id),
    protocol,
    pool_address: String(row.pool_address),
    pair_label: row.pair_label != null ? String(row.pair_label) : null,
    token_address: row.token_address != null ? String(row.token_address) : null,
    deposit_symbol:
      row.deposit_symbol != null ? String(row.deposit_symbol) : null,
    owner_address: String(row.owner_address),
    entry_value_usd: Number(row.entry_value_usd) || 0,
    current_value_usd: Number(row.current_value_usd) || 0,
    pnl_pct: Number(row.pnl_pct) || 0,
    status: String(row.status) as RhClmmPositionStatus,
    mint_tx: row.mint_tx != null ? String(row.mint_tx) : null,
    close_tx: row.close_tx != null ? String(row.close_tx) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at != null ? String(row.closed_at) : null,
    unclaimed_fees_usd: Number(row.unclaimed_fees_usd) || 0,
    in_range:
      row.in_range == null ? null : Boolean(row.in_range),
    tick_lower:
      row.tick_lower != null ? Number(row.tick_lower) : null,
    tick_upper:
      row.tick_upper != null ? Number(row.tick_upper) : null,
    symbol0: row.symbol0 != null ? String(row.symbol0) : null,
    symbol1: row.symbol1 != null ? String(row.symbol1) : null,
    liquidity: row.liquidity != null ? String(row.liquidity) : null,
    live_synced_at:
      row.live_synced_at != null ? String(row.live_synced_at) : null,
  }
}

export async function listRhClmmPositions(
  status?: string,
  owner?: string,
): Promise<RhClmmPosition[]> {
  try {
    await ensureRhClmmPositionsTable()
    if (status && owner) {
      const { rows } = await query<Record<string, unknown>>(
        `SELECT * FROM rh_clmm_positions
         WHERE status = $1 AND lower(owner_address) = lower($2)
         ORDER BY updated_at DESC`,
        [status, owner],
      )
      return rows.map(mapRow)
    }
    if (status) {
      const { rows } = await query<Record<string, unknown>>(
        `SELECT * FROM rh_clmm_positions WHERE status = $1 ORDER BY updated_at DESC`,
        [status],
      )
      return rows.map(mapRow)
    }
    if (owner) {
      const { rows } = await query<Record<string, unknown>>(
        `SELECT * FROM rh_clmm_positions
         WHERE lower(owner_address) = lower($1)
         ORDER BY updated_at DESC`,
        [owner],
      )
      return rows.map(mapRow)
    }
    const { rows } = await query<Record<string, unknown>>(
      `SELECT * FROM rh_clmm_positions ORDER BY updated_at DESC`,
    )
    return rows.map(mapRow)
  } catch (error) {
    if (isDbConnectivityError(error)) return []
    console.warn('[rh-clmm-db] list:', formatDbError(error))
    return []
  }
}

export async function getRhClmmPosition(
  id: string,
): Promise<RhClmmPosition | null> {
  await ensureRhClmmPositionsTable()
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM rh_clmm_positions WHERE id = $1`,
    [id],
  )
  return row ? mapRow(row) : null
}

export type InsertRhClmmPositionInput = {
  token_id: string
  protocol: RhClmmProtocol
  pool_address: string
  pair_label?: string | null
  token_address?: string | null
  deposit_symbol?: string | null
  owner_address: string
  entry_value_usd: number
  current_value_usd?: number
  mint_tx?: string | null
  status?: RhClmmPositionStatus
}

export async function insertRhClmmPosition(
  row: InsertRhClmmPositionInput,
): Promise<RhClmmPosition> {
  try {
    await ensureRhClmmPositionsTable()
    const inserted = await queryOne<Record<string, unknown>>(
      `INSERT INTO rh_clmm_positions (
         token_id, protocol, pool_address, pair_label, token_address, deposit_symbol,
         owner_address, entry_value_usd, current_value_usd, pnl_pct, status, mint_tx, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,NOW())
       ON CONFLICT (owner_address, protocol, token_id) DO UPDATE SET
         pool_address = EXCLUDED.pool_address,
         pair_label = EXCLUDED.pair_label,
         entry_value_usd = EXCLUDED.entry_value_usd,
         current_value_usd = EXCLUDED.current_value_usd,
         mint_tx = COALESCE(EXCLUDED.mint_tx, rh_clmm_positions.mint_tx),
         status = 'open',
         closed_at = NULL,
         updated_at = NOW()
       RETURNING *`,
      [
        row.token_id,
        row.protocol,
        row.pool_address,
        row.pair_label ?? null,
        row.token_address ?? null,
        row.deposit_symbol ?? null,
        row.owner_address,
        row.entry_value_usd,
        row.current_value_usd ?? row.entry_value_usd,
        row.status ?? 'open',
        row.mint_tx ?? null,
      ],
    )
    if (!inserted) throw new Error('Insert failed')
    return mapRow(inserted)
  } catch (error) {
    assertDbWritable(error)
    throw error
  }
}

/** Upsert live on-chain snapshot fields for open positions (cold Redis fallback). */
export async function upsertRhClmmLiveSnapshots(
  owner: string,
  rows: RhClmmLiveRow[],
): Promise<void> {
  try {
    await ensureRhClmmPositionsTable()
    for (const r of rows) {
      const entry = r.entryValueUsd ?? r.valueUsd
      const pnl =
        entry > 0
          ? ((r.valueUsd - entry) / entry) * 100
          : (r.pnlPct ?? 0)
      await query(
        `INSERT INTO rh_clmm_positions (
           token_id, protocol, pool_address, pair_label, owner_address,
           entry_value_usd, current_value_usd, pnl_pct, status,
           unclaimed_fees_usd, in_range, tick_lower, tick_upper,
           symbol0, symbol1, liquidity, live_synced_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14,$15,NOW(),NOW()
         )
         ON CONFLICT (owner_address, protocol, token_id) DO UPDATE SET
           pool_address = EXCLUDED.pool_address,
           pair_label = EXCLUDED.pair_label,
           current_value_usd = EXCLUDED.current_value_usd,
           pnl_pct = EXCLUDED.pnl_pct,
           status = 'open',
           closed_at = NULL,
           unclaimed_fees_usd = EXCLUDED.unclaimed_fees_usd,
           in_range = EXCLUDED.in_range,
           tick_lower = EXCLUDED.tick_lower,
           tick_upper = EXCLUDED.tick_upper,
           symbol0 = EXCLUDED.symbol0,
           symbol1 = EXCLUDED.symbol1,
           liquidity = EXCLUDED.liquidity,
           live_synced_at = NOW(),
           updated_at = NOW()`,
        [
          r.tokenId,
          r.protocol,
          r.poolAddress || '0x0',
          r.pairLabel,
          owner,
          entry,
          r.valueUsd,
          pnl,
          r.unclaimedFeesUsd,
          r.inRange,
          r.tickLower,
          r.tickUpper,
          r.symbol0,
          r.symbol1,
          r.liquidity,
        ],
      )
    }
  } catch (error) {
    if (isDbConnectivityError(error)) {
      console.warn('[rh-clmm-db] upsert live skipped (db down)')
      return
    }
    console.warn('[rh-clmm-db] upsert live:', formatDbError(error))
  }
}

export async function updateRhClmmPosition(
  id: string,
  patch: Partial<{
    entry_value_usd: number
    current_value_usd: number
    pnl_pct: number
    status: RhClmmPositionStatus
    close_tx: string | null
    closed_at: string | null
  }>,
): Promise<RhClmmPosition> {
  try {
    await ensureRhClmmPositionsTable()
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
      `UPDATE rh_clmm_positions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
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
