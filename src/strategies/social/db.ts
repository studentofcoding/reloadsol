import { query, queryOne } from '@/utils/db'
import { isDbCircuitOpen, formatDbConnectionError } from '@/utils/db-health'
import type {
  SocialIngestEvent,
  SocialTokenEventRow,
  SocialTokenRollupRow,
  TrackedWalletRow,
} from './types'

function isMissingTableError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: string; message?: string }
    if (e.code === '42P01') return true
    if (e.message?.includes('does not exist')) return true
  }
  if (error instanceof Error) {
    return error.message.includes('does not exist') || error.message.includes('42P01')
  }
  return false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

type RollupEventRow = Pick<
  SocialTokenEventRow,
  'token_address' | 'event_type' | 'source' | 'channel_id' | 'channel_label' | 'occurred_at'
>

function buildDedupeKey(e: SocialIngestEvent): string {
  return [
    e.source,
    e.channel_id ?? '',
    e.external_message_id ?? '',
    e.token_address,
    e.event_type,
  ].join('|')
}

export async function insertSocialEvents(
  events: SocialIngestEvent[],
): Promise<{ inserted: number; skipped: number; errors: string[] }> {
  if (events.length === 0) return { inserted: 0, skipped: 0, errors: [] }

  const ROWS_PER_BATCH = 200
  let inserted = 0
  const errors: string[] = []

  for (let i = 0; i < events.length; i += ROWS_PER_BATCH) {
    const batch = events.slice(i, i + ROWS_PER_BATCH)
    const values: unknown[] = []
    const placeholders: string[] = []
    let param = 1

    for (const e of batch) {
      placeholders.push(
        `($${param}, $${param + 1}, $${param + 2}, $${param + 3}, $${param + 4}, $${param + 5}, $${param + 6}, $${param + 7}, $${param + 8}, $${param + 9}, $${param + 10})`,
      )
      values.push(
        e.token_address,
        e.event_type,
        e.source,
        e.channel_id ?? null,
        e.channel_label ?? null,
        e.wallet_address ?? null,
        e.wallet_label ?? null,
        e.external_message_id ?? null,
        buildDedupeKey(e),
        e.occurred_at ?? new Date().toISOString(),
        JSON.stringify(e.raw_metadata ?? {}),
      )
      param += 11
    }

    try {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO social_token_events (
           token_address, event_type, source, channel_id, channel_label,
           wallet_address, wallet_label, external_message_id, dedupe_key,
           occurred_at, raw_metadata
         ) VALUES ${placeholders.join(', ')}
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        values,
      )
      inserted += rows.length
    } catch (error) {
      if (isMissingTableError(error)) {
        return {
          inserted: 0,
          skipped: events.length,
          errors: [errorMessage(error)],
        }
      }
      errors.push(errorMessage(error))
      throw new Error(errorMessage(error))
    }
  }

  return { inserted, skipped: events.length - inserted, errors }
}

export async function fetchSocialRollup(
  tokenAddress: string,
): Promise<SocialTokenRollupRow | null> {
  try {
    return await queryOne<SocialTokenRollupRow>(
      `SELECT * FROM social_token_rollups WHERE token_address = $1 LIMIT 1`,
      [tokenAddress],
    )
  } catch (error) {
    if (isMissingTableError(error)) return null
    console.warn('[social/db] fetchSocialRollup failed:', errorMessage(error))
    return null
  }
}

export async function fetchSocialRollupsMap(
  tokenAddresses: string[],
): Promise<Map<string, SocialTokenRollupRow>> {
  const unique = Array.from(new Set(tokenAddresses.filter(Boolean)))
  if (unique.length === 0) return new Map()

  try {
    const { rows } = await query<SocialTokenRollupRow>(
      `SELECT * FROM social_token_rollups WHERE token_address = ANY($1::text[])`,
      [unique],
    )

    const map = new Map<string, SocialTokenRollupRow>()
    for (const row of rows) {
      map.set(row.token_address, row)
    }
    return map
  } catch (error) {
    if (isMissingTableError(error)) return new Map()
    console.warn('[social/db] fetchSocialRollupsMap failed:', errorMessage(error))
    return new Map()
  }
}

export async function fetchSocialRollups(limit = 100): Promise<SocialTokenRollupRow[]> {
  try {
    const { rows } = await query<SocialTokenRollupRow>(
      `SELECT * FROM social_token_rollups ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    )
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    console.warn('[social/db] fetchSocialRollups failed:', errorMessage(error))
    return []
  }
}

export async function fetchRecentSocialEvents(
  tokenAddress: string,
  limit = 20,
): Promise<SocialTokenEventRow[]> {
  try {
    const { rows } = await query<SocialTokenEventRow>(
      `SELECT * FROM social_token_events
       WHERE token_address = $1
       ORDER BY occurred_at DESC
       LIMIT $2`,
      [tokenAddress, limit],
    )
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    return []
  }
}

export async function fetchSocialEventsForTokenSince(
  tokenAddress: string,
  sinceIso: string,
  limit = 100,
): Promise<SocialTokenEventRow[]> {
  try {
    const { rows } = await query<SocialTokenEventRow>(
      `SELECT * FROM social_token_events
       WHERE token_address = $1 AND occurred_at >= $2
       ORDER BY occurred_at DESC
       LIMIT $3`,
      [tokenAddress, sinceIso, limit],
    )
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    return []
  }
}

export async function fetchRecentSocialEventsFeed(options?: {
  limit?: number
  hours?: number
  telegramOnly?: boolean
}): Promise<SocialTokenEventRow[]> {
  const limit = options?.limit ?? 50
  const hours = options?.hours ?? 24
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

  const sql = options?.telegramOnly
    ? `SELECT * FROM social_token_events
       WHERE occurred_at >= $1 AND source != 'tracked_wallet_poll'
       ORDER BY occurred_at DESC
       LIMIT $2`
    : `SELECT * FROM social_token_events
       WHERE occurred_at >= $1
       ORDER BY occurred_at DESC
       LIMIT $2`

  try {
    const { rows } = await query<SocialTokenEventRow>(sql, [since, limit])
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    console.warn('[social/db] fetchRecentSocialEventsFeed failed:', errorMessage(error))
    return []
  }
}

export async function refreshSocialRollups(now = new Date()): Promise<{
  tokensUpdated: number
  error?: string
}> {
  if (isDbCircuitOpen()) {
    return { tokensUpdated: 0, error: 'Database circuit open — rollup skipped' }
  }

  const nowIso = now.toISOString()
  const t5 = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const t30 = new Date(now.getTime() - 30 * 60 * 1000).toISOString()
  const t60 = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const t24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  let recentEvents: RollupEventRow[]
  try {
    const { rows } = await query<RollupEventRow>(
      `SELECT token_address, event_type, source, channel_id, channel_label, occurred_at
       FROM social_token_events
       WHERE occurred_at >= $1
       ORDER BY occurred_at ASC`,
      [t24],
    )
    recentEvents = rows
  } catch (fetchError) {
    if (isMissingTableError(fetchError)) {
      return { tokensUpdated: 0, error: errorMessage(fetchError) }
    }
    return { tokensUpdated: 0, error: formatDbConnectionError(fetchError) }
  }

  const byToken = new Map<string, RollupEventRow[]>()
  for (const row of recentEvents) {
    const list = byToken.get(row.token_address) ?? []
    list.push(row)
    byToken.set(row.token_address, list)
  }

  const rollups = Array.from(byToken.entries()).map(([tokenAddress, events]) => {
    const mentions30 = events.filter(
      (e: RollupEventRow) => e.event_type === 'mention' && e.occurred_at >= t30,
    )
    const mentions5 = mentions30.filter((e: RollupEventRow) => e.occurred_at >= t5)
    const mentions24 = events.filter((e: RollupEventRow) => e.event_type === 'mention')
    const walletBuys1h = events.filter(
      (e: RollupEventRow) =>
        e.event_type === 'wallet_buy' &&
        e.occurred_at >= t60 &&
        (e.source.includes('wallet') || e.source.includes('GMGN_copy')),
    )

    const channels30 = new Set(
      mentions30.map((e: RollupEventRow) => e.channel_id || e.channel_label || e.source).filter(Boolean),
    )

    const sourceCounts = new Map<string, number>()
    for (const e of mentions30) {
      sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1)
    }
    let topSource: string | null = null
    let topCount = 0
    for (const [src, count] of Array.from(sourceCounts.entries())) {
      if (count > topCount) {
        topCount = count
        topSource = src
      }
    }

    const first = events[0]
    const solSum = 0

    const lastEvent = events[events.length - 1]

    return {
      token_address: tokenAddress,
      first_seen_at: first?.occurred_at ?? null,
      first_source: first?.source ?? null,
      first_channel: first?.channel_label ?? first?.channel_id ?? null,
      mention_count_5m: mentions5.length,
      mention_count_30m: mentions30.length,
      mention_count_24h: mentions24.length,
      unique_channel_count_30m: channels30.size,
      smart_wallet_buy_count_1h: walletBuys1h.length,
      smart_wallet_buy_sol_1h: solSum,
      top_source: topSource,
      last_event_at: lastEvent?.occurred_at ?? null,
      updated_at: nowIso,
    }
  })

  if (rollups.length === 0) {
    return { tokensUpdated: 0 }
  }

  const ROWS_PER_BATCH = 200

  try {
    for (let i = 0; i < rollups.length; i += ROWS_PER_BATCH) {
      const batch = rollups.slice(i, i + ROWS_PER_BATCH)
      const values: unknown[] = []
      const placeholders: string[] = []
      let param = 1

      for (const r of batch) {
        placeholders.push(
          `($${param}, $${param + 1}, $${param + 2}, $${param + 3}, $${param + 4}, $${param + 5}, $${param + 6}, $${param + 7}, $${param + 8}, $${param + 9}, $${param + 10}, $${param + 11}, $${param + 12})`,
        )
        values.push(
          r.token_address,
          r.first_seen_at,
          r.first_source,
          r.first_channel,
          r.mention_count_5m,
          r.mention_count_30m,
          r.mention_count_24h,
          r.unique_channel_count_30m,
          r.smart_wallet_buy_count_1h,
          r.smart_wallet_buy_sol_1h,
          r.top_source,
          r.last_event_at,
          r.updated_at,
        )
        param += 13
      }

      await query(
        `INSERT INTO social_token_rollups (
           token_address, first_seen_at, first_source, first_channel,
           mention_count_5m, mention_count_30m, mention_count_24h,
           unique_channel_count_30m, smart_wallet_buy_count_1h, smart_wallet_buy_sol_1h,
           top_source, last_event_at, updated_at
         ) VALUES ${placeholders.join(', ')}
         ON CONFLICT (token_address) DO UPDATE SET
           first_seen_at = EXCLUDED.first_seen_at,
           first_source = EXCLUDED.first_source,
           first_channel = EXCLUDED.first_channel,
           mention_count_5m = EXCLUDED.mention_count_5m,
           mention_count_30m = EXCLUDED.mention_count_30m,
           mention_count_24h = EXCLUDED.mention_count_24h,
           unique_channel_count_30m = EXCLUDED.unique_channel_count_30m,
           smart_wallet_buy_count_1h = EXCLUDED.smart_wallet_buy_count_1h,
           smart_wallet_buy_sol_1h = EXCLUDED.smart_wallet_buy_sol_1h,
           top_source = EXCLUDED.top_source,
           last_event_at = EXCLUDED.last_event_at,
           updated_at = EXCLUDED.updated_at`,
        values,
      )
    }
  } catch (upsertError) {
    return { tokensUpdated: 0, error: errorMessage(upsertError) }
  }

  return { tokensUpdated: rollups.length }
}

export async function listTrackedWallets(activeOnly = true): Promise<TrackedWalletRow[]> {
  try {
    const sql = activeOnly
      ? `SELECT * FROM tracked_wallets WHERE is_active = true ORDER BY label`
      : `SELECT * FROM tracked_wallets ORDER BY label`
    const { rows } = await query<TrackedWalletRow>(sql)
    return rows
  } catch (error) {
    if (isMissingTableError(error)) return []
    console.warn('[social/db] listTrackedWallets failed:', errorMessage(error))
    return []
  }
}

export async function upsertTrackedWallet(
  wallet: Pick<TrackedWalletRow, 'address' | 'label' | 'tier' | 'tags' | 'is_active'>,
): Promise<boolean> {
  try {
    await query(
      `INSERT INTO tracked_wallets (address, label, tier, tags, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address) DO UPDATE SET
         label = EXCLUDED.label,
         tier = EXCLUDED.tier,
         tags = EXCLUDED.tags,
         is_active = EXCLUDED.is_active,
         updated_at = EXCLUDED.updated_at`,
      [
        wallet.address,
        wallet.label,
        wallet.tier,
        wallet.tags,
        wallet.is_active,
        new Date().toISOString(),
      ],
    )
    return true
  } catch (error) {
    console.warn('[social/db] upsertTrackedWallet failed:', errorMessage(error))
    return false
  }
}

export async function deleteTrackedWallet(address: string): Promise<boolean> {
  try {
    await query(`DELETE FROM tracked_wallets WHERE address = $1`, [address])
    return true
  } catch (error) {
    console.warn('[social/db] deleteTrackedWallet failed:', errorMessage(error))
    return false
  }
}

export async function upsertWalletHolding(
  walletAddress: string,
  tokenAddress: string,
  seenAt: string,
): Promise<'inserted' | 'existing' | 'error'> {
  try {
    const existing = await queryOne<{ wallet_address: string }>(
      `SELECT wallet_address FROM tracked_wallet_holdings
       WHERE wallet_address = $1 AND token_address = $2
       LIMIT 1`,
      [walletAddress, tokenAddress],
    )

    if (existing) {
      await query(
        `UPDATE tracked_wallet_holdings SET last_seen_at = $3
         WHERE wallet_address = $1 AND token_address = $2`,
        [walletAddress, tokenAddress, seenAt],
      )
      return 'existing'
    }

    await query(
      `INSERT INTO tracked_wallet_holdings (wallet_address, token_address, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $3)`,
      [walletAddress, tokenAddress, seenAt],
    )
    return 'inserted'
  } catch (error) {
    if (isMissingTableError(error)) return 'error'
    if (isUniqueViolation(error)) return 'existing'
    return 'error'
  }
}

export async function markWalletPolled(
  address: string,
  errorMsg?: string | null,
): Promise<void> {
  try {
    await query(
      `UPDATE tracked_wallets SET
         last_polled_at = $2,
         last_poll_error = $3,
         updated_at = $4
       WHERE address = $1`,
      [address, new Date().toISOString(), errorMsg ?? null, new Date().toISOString()],
    )
  } catch {
    // ponytail: fire-and-forget poll marker, same as prior supabase call
  }
}

const SOCIAL_RETENTION_HOURS = 24

/** Delete events older than retention window and rollups with no recent activity. */
export async function cleanupStaleSocialData(
  retentionHours = SOCIAL_RETENTION_HOURS,
): Promise<{ eventsDeleted: number; rollupsDeleted: number; error?: string }> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString()

  let eventsDeleted = 0
  try {
    const { rowCount } = await query(
      `DELETE FROM social_token_events WHERE occurred_at < $1`,
      [cutoff],
    )
    eventsDeleted = rowCount
  } catch (eventsError) {
    if (isMissingTableError(eventsError)) {
      return { eventsDeleted: 0, rollupsDeleted: 0, error: errorMessage(eventsError) }
    }
    return { eventsDeleted: 0, rollupsDeleted: 0, error: errorMessage(eventsError) }
  }

  try {
    const { rowCount } = await query(
      `DELETE FROM social_token_rollups WHERE last_event_at < $1`,
      [cutoff],
    )
    return { eventsDeleted, rollupsDeleted: rowCount }
  } catch (rollupsError) {
    if (isMissingTableError(rollupsError)) {
      return { eventsDeleted, rollupsDeleted: 0, error: errorMessage(rollupsError) }
    }
    return { eventsDeleted, rollupsDeleted: 0, error: errorMessage(rollupsError) }
  }
}

export async function fetchSocialIngestStats(): Promise<{
  eventCount24h: number
  rollupCount: number
  walletCount: number
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  try {
    const [events, rollups, wallets] = await Promise.all([
      queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM social_token_events WHERE occurred_at >= $1`,
        [since],
      ),
      queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM social_token_rollups`,
      ),
      queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM tracked_wallets WHERE is_active = true`,
      ),
    ])

    return {
      eventCount24h: events?.count ?? 0,
      rollupCount: rollups?.count ?? 0,
      walletCount: wallets?.count ?? 0,
    }
  } catch {
    return { eventCount24h: 0, rollupCount: 0, walletCount: 0 }
  }
}
