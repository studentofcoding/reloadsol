/** Persist Telegram Radar digest pin message ids. */

import { query, queryOne } from '@/utils/db'
import {
  assertDbWritable,
  formatDbError,
  isDbConnectivityError,
} from '@/utils/db-health'

export type RadarDigestPin = {
  chat_id: string
  message_id: number
  updated_at: string
}

export async function ensureRadarDigestPinsTable(): Promise<void> {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS radar_digest_pins (
        chat_id TEXT PRIMARY KEY,
        message_id BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  } catch (error) {
    if (isDbConnectivityError(error)) {
      console.warn('[radar-digest] ensureRadarDigestPinsTable: DB unavailable')
      return
    }
    console.error('[radar-digest] ensureRadarDigestPinsTable:', formatDbError(error))
  }
}

export async function getRadarDigestPin(
  chatId: string,
): Promise<RadarDigestPin | null> {
  try {
    const row = await queryOne<Record<string, unknown>>(
      `SELECT chat_id, message_id, updated_at FROM radar_digest_pins WHERE chat_id = $1`,
      [chatId],
    )
    if (!row) return null
    return {
      chat_id: String(row.chat_id),
      message_id: Number(row.message_id),
      updated_at: String(row.updated_at),
    }
  } catch (error) {
    if (isDbConnectivityError(error)) return null
    console.error('[radar-digest] getRadarDigestPin:', formatDbError(error))
    return null
  }
}

export async function upsertRadarDigestPin(params: {
  chat_id: string
  message_id: number
}): Promise<void> {
  try {
    await query(
      `INSERT INTO radar_digest_pins (chat_id, message_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET
         message_id = EXCLUDED.message_id,
         updated_at = NOW()`,
      [params.chat_id, params.message_id],
    )
  } catch (error) {
    assertDbWritable(error)
    console.error('[radar-digest] upsertRadarDigestPin:', formatDbError(error))
    throw error
  }
}
