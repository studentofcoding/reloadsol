import { supabase } from '@/utils/supabase'
import type {
  SocialIngestEvent,
  SocialTokenEventRow,
  SocialTokenRollupRow,
  TrackedWalletRow,
} from './types'

function isMissingTableError(message?: string): boolean {
  if (!message) return false
  return message.includes('does not exist') || message.includes('42P01')
}

type RollupEventRow = Pick<
  SocialTokenEventRow,
  'token_address' | 'event_type' | 'source' | 'channel_id' | 'channel_label' | 'occurred_at' | 'raw_metadata'
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

  const rows = events.map((e) => ({
    token_address: e.token_address,
    event_type: e.event_type,
    source: e.source,
    channel_id: e.channel_id ?? null,
    channel_label: e.channel_label ?? null,
    wallet_address: e.wallet_address ?? null,
    wallet_label: e.wallet_label ?? null,
    external_message_id: e.external_message_id ?? null,
    dedupe_key: buildDedupeKey(e),
    occurred_at: e.occurred_at ?? new Date().toISOString(),
    raw_metadata: e.raw_metadata ?? {},
  }))

  const { data, error } = await supabase
    .from('social_token_events')
    .upsert(rows, {
      onConflict: 'dedupe_key',
      ignoreDuplicates: true,
    })
    .select('id')

  if (error) {
    if (isMissingTableError(error.message)) {
      return { inserted: 0, skipped: events.length, errors: [error.message] }
    }
    throw new Error(error.message)
  }

  const inserted = data?.length ?? 0
  return { inserted, skipped: events.length - inserted, errors: [] }
}

export async function fetchSocialRollup(
  tokenAddress: string,
): Promise<SocialTokenRollupRow | null> {
  const { data, error } = await supabase
    .from('social_token_rollups')
    .select('*')
    .eq('token_address', tokenAddress)
    .maybeSingle()

  if (error) {
    if (isMissingTableError(error.message)) return null
    console.warn('[social/db] fetchSocialRollup failed:', error.message)
    return null
  }

  return (data as SocialTokenRollupRow | null) ?? null
}

export async function fetchSocialRollupsMap(
  tokenAddresses: string[],
): Promise<Map<string, SocialTokenRollupRow>> {
  const unique = Array.from(new Set(tokenAddresses.filter(Boolean)))
  if (unique.length === 0) return new Map()

  const { data, error } = await supabase
    .from('social_token_rollups')
    .select('*')
    .in('token_address', unique)

  if (error) {
    if (isMissingTableError(error.message)) return new Map()
    console.warn('[social/db] fetchSocialRollupsMap failed:', error.message)
    return new Map()
  }

  const map = new Map<string, SocialTokenRollupRow>()
  for (const row of (data ?? []) as SocialTokenRollupRow[]) {
    map.set(row.token_address, row)
  }
  return map
}

export async function fetchSocialRollups(limit = 100): Promise<SocialTokenRollupRow[]> {
  const { data, error } = await supabase
    .from('social_token_rollups')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit)

  if (error) {
    if (isMissingTableError(error.message)) return []
    console.warn('[social/db] fetchSocialRollups failed:', error.message)
    return []
  }

  return (data ?? []) as SocialTokenRollupRow[]
}

export async function fetchRecentSocialEvents(
  tokenAddress: string,
  limit = 20,
): Promise<SocialTokenEventRow[]> {
  const { data, error } = await supabase
    .from('social_token_events')
    .select('*')
    .eq('token_address', tokenAddress)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (error) {
    if (isMissingTableError(error.message)) return []
    return []
  }

  return (data ?? []) as SocialTokenEventRow[]
}

export async function fetchRecentSocialEventsFeed(options?: {
  limit?: number
  hours?: number
  telegramOnly?: boolean
}): Promise<SocialTokenEventRow[]> {
  const limit = options?.limit ?? 50
  const hours = options?.hours ?? 24
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

  let query = supabase
    .from('social_token_events')
    .select('*')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (options?.telegramOnly) {
    query = query.neq('source', 'tracked_wallet_poll')
  }

  const { data, error } = await query

  if (error) {
    if (isMissingTableError(error.message)) return []
    console.warn('[social/db] fetchRecentSocialEventsFeed failed:', error.message)
    return []
  }

  return (data ?? []) as SocialTokenEventRow[]
}

export async function refreshSocialRollups(now = new Date()): Promise<{
  tokensUpdated: number
  error?: string
}> {
  const nowIso = now.toISOString()
  const t5 = new Date(now.getTime() - 5 * 60 * 1000).toISOString()
  const t30 = new Date(now.getTime() - 30 * 60 * 1000).toISOString()
  const t60 = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const t24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const { data: recentEvents, error: fetchError } = await supabase
    .from('social_token_events')
    .select('token_address, event_type, source, channel_id, channel_label, occurred_at, raw_metadata')
    .gte('occurred_at', t24)
    .order('occurred_at', { ascending: true })

  if (fetchError) {
    if (isMissingTableError(fetchError.message)) {
      return { tokensUpdated: 0, error: fetchError.message }
    }
    return { tokensUpdated: 0, error: fetchError.message }
  }

  const byToken = new Map<string, RollupEventRow[]>()
  for (const row of (recentEvents ?? []) as RollupEventRow[]) {
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
        (e.source.includes('wallet') ||
          e.source.includes('GMGN_copy') ||
          e.raw_metadata?.from_tracked_wallet === true),
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
    const solSum = walletBuys1h.reduce((sum: number, e: RollupEventRow) => {
      const v = e.raw_metadata?.sol_amount
      return sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    }, 0)

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

  const { error: upsertError } = await supabase
    .from('social_token_rollups')
    .upsert(rollups, { onConflict: 'token_address' })

  if (upsertError) {
    return { tokensUpdated: 0, error: upsertError.message }
  }

  return { tokensUpdated: rollups.length }
}

export async function listTrackedWallets(activeOnly = true): Promise<TrackedWalletRow[]> {
  let query = supabase.from('tracked_wallets').select('*').order('label')
  if (activeOnly) query = query.eq('is_active', true)

  const { data, error } = await query
  if (error) {
    if (isMissingTableError(error.message)) return []
    console.warn('[social/db] listTrackedWallets failed:', error.message)
    return []
  }

  return (data ?? []) as TrackedWalletRow[]
}

export async function upsertTrackedWallet(
  wallet: Pick<TrackedWalletRow, 'address' | 'label' | 'tier' | 'tags' | 'is_active'>,
): Promise<boolean> {
  const { error } = await supabase.from('tracked_wallets').upsert(
    {
      ...wallet,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'address' },
  )

  if (error) {
    console.warn('[social/db] upsertTrackedWallet failed:', error.message)
    return false
  }
  return true
}

export async function deleteTrackedWallet(address: string): Promise<boolean> {
  const { error } = await supabase.from('tracked_wallets').delete().eq('address', address)
  if (error) {
    console.warn('[social/db] deleteTrackedWallet failed:', error.message)
    return false
  }
  return true
}

export async function upsertWalletHolding(
  walletAddress: string,
  tokenAddress: string,
  seenAt: string,
): Promise<'inserted' | 'existing' | 'error'> {
  const { data: existing, error: readError } = await supabase
    .from('tracked_wallet_holdings')
    .select('wallet_address')
    .eq('wallet_address', walletAddress)
    .eq('token_address', tokenAddress)
    .maybeSingle()

  if (readError && !isMissingTableError(readError.message)) {
    return 'error'
  }

  if (existing) {
    await supabase
      .from('tracked_wallet_holdings')
      .update({ last_seen_at: seenAt })
      .eq('wallet_address', walletAddress)
      .eq('token_address', tokenAddress)
    return 'existing'
  }

  const { error } = await supabase.from('tracked_wallet_holdings').insert({
    wallet_address: walletAddress,
    token_address: tokenAddress,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  })

  if (error) {
    if (error.code === '23505') return 'existing'
    return 'error'
  }

  return 'inserted'
}

export async function markWalletPolled(
  address: string,
  errorMsg?: string | null,
): Promise<void> {
  await supabase
    .from('tracked_wallets')
    .update({
      last_polled_at: new Date().toISOString(),
      last_poll_error: errorMsg ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('address', address)
}

export async function fetchSocialIngestStats(): Promise<{
  eventCount24h: number
  rollupCount: number
  walletCount: number
}> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [events, rollups, wallets] = await Promise.all([
    supabase
      .from('social_token_events')
      .select('id', { count: 'exact', head: true })
      .gte('occurred_at', since),
    supabase.from('social_token_rollups').select('token_address', { count: 'exact', head: true }),
    supabase
      .from('tracked_wallets')
      .select('address', { count: 'exact', head: true })
      .eq('is_active', true),
  ])

  return {
    eventCount24h: events.count ?? 0,
    rollupCount: rollups.count ?? 0,
    walletCount: wallets.count ?? 0,
  }
}
