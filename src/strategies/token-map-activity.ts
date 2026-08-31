import { listStrategyOutcomes } from '@/strategies/db'
import { fetchSocialEventsForTokenSince } from '@/strategies/social/db'
import {
  socialDomainAndKind,
  type TokenMapActivityItem,
  type TokenMapActivityKind,
  type TokenMapDomain,
} from '@/strategies/token-map-types'
import { query } from '@/utils/db'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import type { TrackingRecord } from '@/utils/trading-tracker'

const SIM_WALLETS: { address: string; domain: TokenMapDomain }[] = [
  {
    address: process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim',
    domain: 'mcap_tracker',
  },
  {
    address: process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim',
    domain: 'signals',
  },
  {
    address: process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim',
    domain: 'gmgn',
  },
]

function domainFromOutcome(domain: string | null | undefined): TokenMapDomain {
  switch (domain) {
    case 'mcap_tracker':
    case 'signals':
    case 'gmgn':
    case 'trending_bot':
    case 'dlmm':
      return domain
    default:
      return 'infra'
  }
}

function toIso(ts: string | number | Date): string {
  if (typeof ts === 'number') return new Date(ts).toISOString()
  if (ts instanceof Date) return ts.toISOString()
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString()
}

async function fetchSimActivityForMint(
  tokenAddress: string,
  sinceIso: string,
  limit: number,
): Promise<TokenMapActivityItem[]> {
  const wallets = SIM_WALLETS.map((w) => w.address)
  const walletDomain = new Map(SIM_WALLETS.map((w) => [w.address, w.domain]))

  try {
    const { rows } = await query<{
      id: string
      wallet_address: string
      operation_type: string
      timestamp: string
      data: TrackingRecord | string
    }>(
      `SELECT id, wallet_address, operation_type, timestamp, data
       FROM trading_records
       WHERE wallet_address = ANY($1::text[])
         AND timestamp >= $2::timestamptz
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(data->'tokens', '[]'::jsonb)) t
           WHERE t->>'mintAddress' = $3
         )
       ORDER BY timestamp DESC
       LIMIT $4`,
      [wallets, sinceIso, tokenAddress, limit],
    )

    const items: TokenMapActivityItem[] = []
    for (const row of rows) {
      const data =
        typeof row.data === 'string'
          ? (JSON.parse(row.data) as TrackingRecord)
          : row.data
      const domain = walletDomain.get(row.wallet_address) ?? 'infra'
      const op = row.operation_type || data.operationType
      const strategy = data.bot_strategy ?? 'sim'
      const isBuy = op === 'buy'
      const kind: TokenMapActivityKind = isBuy ? 'sim_open' : 'sim_close'
      const occurredAt = toIso(row.timestamp)
      const features =
        data.trading_simulation &&
        typeof data.trading_simulation === 'object' &&
        (data.trading_simulation as { entry_features?: Record<string, unknown> })
          .entry_features

      items.push({
        id: `sim:${row.id}`,
        domain,
        kind,
        title: isBuy ? `Sim open · ${strategy}` : `Sim ${op} · ${strategy}`,
        detail: data.is_simulation === false ? 'live' : 'paper',
        occurredAt,
        source: row.wallet_address,
      })

      if (
        isBuy &&
        features &&
        (features.has_gmgn_hot_after_entry === 1 ||
          features.has_gmgn_hot_after_entry === true)
      ) {
        items.push({
          id: `boost:${row.id}`,
          domain: 'gmgn',
          kind: 'live_boost',
          title: 'GMGN live boost after entry',
          detail:
            typeof features.gmgn_live_boost_score === 'number'
              ? `boost +${features.gmgn_live_boost_score}`
              : undefined,
          occurredAt:
            typeof features.gmgn_hot_after_entry_at === 'string'
              ? features.gmgn_hot_after_entry_at
              : occurredAt,
          source: 'gmgn_live_boost',
        })
      }
    }
    return items
  } catch (error) {
    console.warn(
      '[token-map-activity] sim fetch failed:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

export async function fetchTokenMapActivity(params: {
  tokenAddress: string
  chain?: GmgnTradeChain
  hours?: number
  limit?: number
}): Promise<TokenMapActivityItem[]> {
  const hours = Math.min(Math.max(params.hours ?? 24, 1), 168)
  const limit = Math.min(Math.max(params.limit ?? 80, 1), 200)
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const perSource = Math.ceil(limit / 2)

  const [social, outcomes, sims] = await Promise.all([
    fetchSocialEventsForTokenSince(params.tokenAddress, sinceIso, perSource),
    listStrategyOutcomes({
      tokenAddress: params.tokenAddress,
      chain: params.chain,
      limit: perSource,
      offset: 0,
    }),
    fetchSimActivityForMint(params.tokenAddress, sinceIso, perSource),
  ])

  const items: TokenMapActivityItem[] = []

  for (const ev of social) {
    const { domain, kind } = socialDomainAndKind(ev.source)
    const channel = ev.channel_label || ev.wallet_label || ev.source
    items.push({
      id: `social:${ev.id}`,
      domain,
      kind,
      title:
        kind === 'gmgn_hot'
          ? 'GMGN hot activity'
          : `${ev.event_type.replace('_', ' ')} · ${channel}`,
      detail: ev.source,
      occurredAt: toIso(ev.occurred_at),
      source: ev.source,
    })
  }

  for (const row of outcomes.rows) {
    const entryAt = row.entry_at ? toIso(row.entry_at) : null
    if (entryAt && entryAt < sinceIso && row.exit_at) {
      const exitAt = toIso(row.exit_at)
      if (exitAt < sinceIso) continue
    }
    const pnl =
      typeof row.pnl_pct === 'number' ? `${row.pnl_pct.toFixed(1)}%` : undefined
    items.push({
      id: `outcome:${row.id}`,
      domain: domainFromOutcome(row.domain),
      kind: 'outcome',
      title: `Outcome · ${row.strategy_id}${row.status ? ` · ${row.status}` : ''}`,
      detail: pnl,
      occurredAt: toIso(row.exit_at ?? row.created_at ?? row.entry_at ?? sinceIso),
      source: row.domain ?? undefined,
    })
  }

  items.push(...sims)

  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  return items.slice(0, limit)
}
