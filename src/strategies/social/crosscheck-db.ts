import { query, queryOne } from '@/utils/db'

function isMissingTableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: string; message?: string }
    if (e.code === '42P01') return true
    if (e.message?.includes('does not exist')) return true
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type TelegramSignalChannelRow = {
  id: string
  channel_name: string
  channel_id: string | null
  cluster_name: string
  dex_default: string | null
  tolerance_pct: number
  sim_buy_sol: number
  is_active: boolean
  created_at: string
}

export type SignalPriceCrosscheckRow = {
  id: string
  token_address: string
  channel_id: string | null
  channel_name: string
  token_name: string | null
  token_symbol: string | null
  dex: string | null
  strategy_id: string | null
  signal_price_usd: number
  jupiter_price_usd: number | null
  pct_diff: number | null
  tolerance_pct: number
  status: 'passed' | 'failed' | 'error'
  market_cap_usd: number | null
  raw_message: string | null
  external_message_id: string | null
  sim_opened: boolean
  occurred_at: string
  created_at: string
}

export type InsertCrosscheckParams = {
  token_address: string
  channel_id?: string | null
  channel_name: string
  token_name?: string | null
  token_symbol?: string | null
  dex?: string | null
  strategy_id?: string | null
  signal_price_usd: number
  jupiter_price_usd?: number | null
  pct_diff?: number | null
  tolerance_pct: number
  status: 'passed' | 'failed' | 'error'
  market_cap_usd?: number | null
  raw_message?: string | null
  external_message_id?: string | null
  sim_opened?: boolean
  occurred_at?: string
}

export async function listTelegramSignalChannels(
  activeOnly = false,
): Promise<TelegramSignalChannelRow[]> {
  try {
    const sql = activeOnly
      ? `SELECT * FROM telegram_signal_channels WHERE is_active = true ORDER BY channel_name`
      : `SELECT * FROM telegram_signal_channels ORDER BY channel_name`
    const { rows } = await query<TelegramSignalChannelRow>(sql)
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
}

export async function findTelegramSignalChannelByChatId(
  channelId: string,
): Promise<TelegramSignalChannelRow | null> {
  try {
    return await queryOne<TelegramSignalChannelRow>(
      `SELECT * FROM telegram_signal_channels
       WHERE is_active = true AND channel_id = $1
       LIMIT 1`,
      [channelId],
    )
  } catch (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
}

export async function upsertTelegramSignalChannel(params: {
  id: string
  channel_name: string
  channel_id?: string | null
  cluster_name?: string
  dex_default?: string | null
  tolerance_pct?: number
  sim_buy_sol?: number
  is_active?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await query(
      `INSERT INTO telegram_signal_channels (
         id, channel_name, channel_id, cluster_name, dex_default,
         tolerance_pct, sim_buy_sol, is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         channel_name = EXCLUDED.channel_name,
         channel_id = EXCLUDED.channel_id,
         cluster_name = EXCLUDED.cluster_name,
         dex_default = EXCLUDED.dex_default,
         tolerance_pct = EXCLUDED.tolerance_pct,
         sim_buy_sol = EXCLUDED.sim_buy_sol,
         is_active = EXCLUDED.is_active`,
      [
        params.id,
        params.channel_name,
        params.channel_id ?? null,
        params.cluster_name ?? 'cluster',
        params.dex_default ?? null,
        params.tolerance_pct ?? 3,
        params.sim_buy_sol ?? 0.01,
        params.is_active ?? true,
      ],
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export async function deleteTelegramSignalChannel(id: string): Promise<boolean> {
  try {
    await query(`DELETE FROM telegram_signal_channels WHERE id = $1`, [id])
    return true
  } catch {
    return false
  }
}

export async function insertSignalPriceCrosscheck(
  params: InsertCrosscheckParams,
): Promise<SignalPriceCrosscheckRow | null> {
  try {
    return await queryOne<SignalPriceCrosscheckRow>(
      `INSERT INTO signal_price_crosschecks (
         token_address, channel_id, channel_name, token_name, token_symbol,
         dex, strategy_id, signal_price_usd, jupiter_price_usd, pct_diff,
         tolerance_pct, status, market_cap_usd, raw_message,
         external_message_id, sim_opened, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        params.token_address,
        params.channel_id ?? null,
        params.channel_name,
        params.token_name ?? null,
        params.token_symbol ?? null,
        params.dex ?? null,
        params.strategy_id ?? null,
        params.signal_price_usd,
        params.jupiter_price_usd ?? null,
        params.pct_diff ?? null,
        params.tolerance_pct,
        params.status,
        params.market_cap_usd ?? null,
        params.raw_message ?? null,
        params.external_message_id ?? null,
        params.sim_opened ?? false,
        params.occurred_at ?? new Date().toISOString(),
      ],
    )
  } catch (error) {
    if (isMissingTableError(error)) return null
    throw error
  }
}

export async function updateCrosscheckSimOpened(id: string): Promise<void> {
  try {
    await query(`UPDATE signal_price_crosschecks SET sim_opened = true WHERE id = $1`, [id])
  } catch {
    // ponytail: non-critical marker
  }
}

export async function listSignalPriceCrosschecks(options?: {
  limit?: number
  hours?: number
  status?: string
  channelName?: string
}): Promise<SignalPriceCrosscheckRow[]> {
  const limit = options?.limit ?? 50
  const hours = options?.hours ?? 48
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

  const clauses = ['occurred_at >= $1']
  const values: unknown[] = [since]
  let param = 2

  if (options?.status) {
    clauses.push(`status = $${param}`)
    values.push(options.status)
    param++
  }
  if (options?.channelName) {
    clauses.push(`channel_name = $${param}`)
    values.push(options.channelName)
    param++
  }

  values.push(limit)

  try {
    const { rows } = await query<SignalPriceCrosscheckRow>(
      `SELECT * FROM signal_price_crosschecks
       WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at DESC
       LIMIT $${param}`,
      values,
    )
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    throw error
  }
}
