import { query, queryOne } from '@/utils/db'
import {
  assertDbWritable,
  formatDbError,
  isDbConnectivityError,
} from '@/utils/db-health'

export type RadarAlertThreadStatus = 'open' | 'dead'
export type RadarAlertThreadKind = 'new' | 'comeback'

export type RadarAlertThread = {
  id: string
  token_address: string
  token_symbol: string | null
  chat_id: string
  message_id: number
  status: RadarAlertThreadStatus
  kind: RadarAlertThreadKind
  lifecycle: number
  initial_price_usd: number | null
  initial_mcap_usd: number | null
  last_price_usd: number | null
  last_mcap_usd: number | null
  peak_mcap_usd: number | null
  trough_mcap_usd: number | null
  peak_sm: number
  peak_kol: number
  death_reason: string | null
  opened_at: string
  updated_at: string
  closed_at: string | null
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function mapThread(row: Record<string, unknown>): RadarAlertThread {
  return {
    id: String(row.id),
    token_address: String(row.token_address),
    token_symbol: row.token_symbol ? String(row.token_symbol) : null,
    chat_id: String(row.chat_id),
    message_id: Number(row.message_id),
    status: row.status as RadarAlertThreadStatus,
    kind: (row.kind as RadarAlertThreadKind) || 'new',
    lifecycle: Number(row.lifecycle) || 1,
    initial_price_usd: num(row.initial_price_usd),
    initial_mcap_usd: num(row.initial_mcap_usd),
    last_price_usd: num(row.last_price_usd),
    last_mcap_usd: num(row.last_mcap_usd),
    peak_mcap_usd: num(row.peak_mcap_usd),
    trough_mcap_usd: num(row.trough_mcap_usd),
    peak_sm: num(row.peak_sm) ?? 0,
    peak_kol: num(row.peak_kol) ?? 0,
    death_reason: row.death_reason ? String(row.death_reason) : null,
    opened_at: String(row.opened_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at ? String(row.closed_at) : null,
  }
}

function logRead(context: string, error: unknown) {
  if (isDbConnectivityError(error)) {
    console.warn(`[radar-threads] ${context}: DB unavailable`)
    return
  }
  console.error(`[radar-threads] ${context}:`, formatDbError(error))
}

export async function getOpenRadarThread(
  tokenAddress: string,
): Promise<RadarAlertThread | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM radar_alert_threads
       WHERE token_address = $1 AND status = 'open'
       LIMIT 1`,
      [tokenAddress],
    )
    return row ? mapThread(row) : null
  } catch (error) {
    logRead('getOpenRadarThread', error)
    return null
  }
}

export async function getLatestDeadRadarThread(
  tokenAddress: string,
): Promise<RadarAlertThread | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT * FROM radar_alert_threads
       WHERE token_address = $1 AND status = 'dead'
       ORDER BY closed_at DESC NULLS LAST, opened_at DESC
       LIMIT 1`,
      [tokenAddress],
    )
    return row ? mapThread(row) : null
  } catch (error) {
    logRead('getLatestDeadRadarThread', error)
    return null
  }
}

export async function getNextRadarLifecycle(
  tokenAddress: string,
): Promise<number> {
  try {
    const row = await queryOne<{ max: string | number | null }>(
      `SELECT MAX(lifecycle) AS max FROM radar_alert_threads WHERE token_address = $1`,
      [tokenAddress],
    )
    const max = row?.max != null ? Number(row.max) : 0
    return (Number.isFinite(max) ? max : 0) + 1
  } catch (error) {
    logRead('getNextRadarLifecycle', error)
    return 1
  }
}

export async function insertRadarThread(input: {
  token_address: string
  token_symbol?: string | null
  chat_id: string
  message_id: number
  kind: RadarAlertThreadKind
  lifecycle: number
  initial_price_usd: number | null
  initial_mcap_usd: number | null
  peak_sm: number
  peak_kol: number
}): Promise<RadarAlertThread | null> {
  try {
    const mcap = input.initial_mcap_usd
    const price = input.initial_price_usd
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO radar_alert_threads (
         token_address, token_symbol, chat_id, message_id, status, kind, lifecycle,
         initial_price_usd, initial_mcap_usd, last_price_usd, last_mcap_usd,
         peak_mcap_usd, trough_mcap_usd, peak_sm, peak_kol
       ) VALUES (
         $1,$2,$3,$4,'open',$5,$6,
         $7,$8,$7,$8,
         $8,$8,$9,$10
       ) RETURNING *`,
      [
        input.token_address,
        input.token_symbol ?? null,
        input.chat_id,
        input.message_id,
        input.kind,
        input.lifecycle,
        price,
        mcap,
        input.peak_sm,
        input.peak_kol,
      ],
    )
    if (!row) return null
    return mapThread(row)
  } catch (error) {
    if (isDbConnectivityError(error)) {
      assertDbWritable(error)
    }
    console.error('[radar-threads] insertRadarThread:', formatDbError(error))
    return null
  }
}

export async function updateOpenRadarThread(input: {
  id: string
  token_symbol?: string | null
  last_price_usd: number | null
  last_mcap_usd: number | null
  peak_mcap_usd: number | null
  trough_mcap_usd: number | null
  peak_sm: number
  peak_kol: number
}): Promise<RadarAlertThread | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `UPDATE radar_alert_threads SET
         token_symbol = COALESCE($2, token_symbol),
         last_price_usd = $3,
         last_mcap_usd = $4,
         peak_mcap_usd = $5,
         trough_mcap_usd = $6,
         peak_sm = $7,
         peak_kol = $8,
         updated_at = NOW()
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
      [
        input.id,
        input.token_symbol ?? null,
        input.last_price_usd,
        input.last_mcap_usd,
        input.peak_mcap_usd,
        input.trough_mcap_usd,
        input.peak_sm,
        input.peak_kol,
      ],
    )
    if (!row) return null
    return mapThread(row)
  } catch (error) {
    if (isDbConnectivityError(error)) {
      assertDbWritable(error)
    }
    console.error('[radar-threads] updateOpenRadarThread:', formatDbError(error))
    return null
  }
}

/** Final-edit then freeze — leave Telegram message in chat. */
export async function markRadarThreadDead(input: {
  id: string
  death_reason: string
  last_price_usd?: number | null
  last_mcap_usd?: number | null
  trough_mcap_usd?: number | null
}): Promise<RadarAlertThread | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `UPDATE radar_alert_threads SET
         status = 'dead',
         death_reason = $2,
         last_price_usd = COALESCE($3, last_price_usd),
         last_mcap_usd = COALESCE($4, last_mcap_usd),
         trough_mcap_usd = COALESCE($5, trough_mcap_usd),
         closed_at = NOW(),
         updated_at = NOW()
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
      [
        input.id,
        input.death_reason,
        input.last_price_usd ?? null,
        input.last_mcap_usd ?? null,
        input.trough_mcap_usd ?? null,
      ],
    )
    if (!row) return null
    return mapThread(row)
  } catch (error) {
    if (isDbConnectivityError(error)) {
      assertDbWritable(error)
    }
    console.error('[radar-threads] markRadarThreadDead:', formatDbError(error))
    return null
  }
}

/** Ensure table exists for older deploys without migration 13. */
export async function ensureRadarAlertThreadsTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS radar_alert_threads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        chat_id TEXT NOT NULL,
        message_id BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'dead')),
        kind TEXT NOT NULL DEFAULT 'new'
          CHECK (kind IN ('new', 'comeback')),
        lifecycle INTEGER NOT NULL DEFAULT 1,
        initial_price_usd NUMERIC,
        initial_mcap_usd NUMERIC,
        last_price_usd NUMERIC,
        last_mcap_usd NUMERIC,
        peak_mcap_usd NUMERIC,
        trough_mcap_usd NUMERIC,
        peak_sm NUMERIC NOT NULL DEFAULT 0,
        peak_kol NUMERIC NOT NULL DEFAULT 0,
        death_reason TEXT,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      )
    `)
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_alert_threads_one_open
        ON radar_alert_threads (token_address)
        WHERE status = 'open'
    `)
  } catch (error) {
    logRead('ensureRadarAlertThreadsTable', error)
  }
}
