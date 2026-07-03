import { query, queryOne } from '@/utils/db'
import type { QueryResultRow } from 'pg'
import { isValidMintAddress } from '@/utils/jupiter'
import { fetchJupiterPriceRaw } from '@/utils/jupiter-api'
import {
  fetchJupiterDatapiSearchRaw,
  fetchJupiterV2SearchRaw,
  fetchTokenMetadataFromJupiter,
} from '@/utils/jupiter-metadata'
import { searchTokenStats } from '@/utils/jupiter-pools-test'
import { formatJupiterTokenLink } from '@/utils/telegram'
import { resolveTrackerStrategyId } from '@/utils/trading-simulation'
import { loadStrategyDefinitionRows } from './db'
import { fetchRecentSocialEvents, fetchSocialRollup } from './social/db'

export type RawSectionDataTier = 'raw' | 'jupiter_enriched' | 'internal'

/** @deprecated use dataTier */
export type RawSectionKind = 'jupiter' | 'db' | 'social'

export type RawSection = {
  id: string
  label: string
  source: string
  dataTier: RawSectionDataTier
  kind?: RawSectionKind
  recordLabel?: string | null
  data: unknown
}

export type StrategyPresence = {
  domain: string
  strategyId: string | null
  strategyName: string | null
  source: string
  status?: string
  label?: string
  recordCount?: number
  lastSeenAt?: string
  deepLink?: string
}

export type JupiterEnrichment = {
  symbol?: string | null
  mcap?: number | null
  fdv?: number | null
  organicScore?: number | null
  priceUsd?: number | null
}

export type TokenLocateResult = {
  tokenAddress: string
  symbol: string | null
  found: boolean
  liveOnly?: boolean
  jupiterEnrichment?: JupiterEnrichment
  strategyPresence: StrategyPresence[]
  locations: {
    trending: {
      present: boolean
      status?: string
      marketCap?: number
      peakGainPct?: number
    } | null
    mcap: {
      present: boolean
      label?: string
      firstMcap?: number
      currentMcap?: number
      growthPct?: number
    } | null
    signals: { present: boolean; label?: string } | null
    social: {
      present: boolean
      mentionCount30m?: number
      lastEventAt?: string
    } | null
    outcomes: { count: number }
    dlmmPotential: boolean
    rugList: boolean
    activeLockCount: number
  }
  rawSections: RawSection[]
  fetchedAt: string
  links: {
    chart: string
    jupiter: string
    signals: string
    algoTester: string
    social: string
    strategies: string
    dlmm: string
  }
}

function trackerTable(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function toStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function hasData(data: unknown): boolean {
  if (data == null) return false
  if (Array.isArray(data)) return data.length > 0
  if (typeof data === 'number') return Number.isFinite(data) && data > 0
  return true
}

function section(
  id: string,
  label: string,
  source: string,
  dataTier: RawSectionDataTier,
  data: unknown,
  recordLabel?: string | null,
): RawSection | null {
  if (!hasData(data)) return null
  const kind: RawSectionKind =
    dataTier === 'internal'
      ? id.startsWith('social')
        ? 'social'
        : 'db'
      : 'jupiter'
  return { id, label, source, dataTier, kind, data, recordLabel: recordLabel ?? null }
}

async function safeQueryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[],
): Promise<T | null> {
  try {
    return await queryOne<T>(sql, params)
  } catch {
    return null
  }
}

async function safeQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  try {
    const { rows } = await query<T>(sql, params)
    return rows
  } catch {
    return []
  }
}

function pickJupiterV2Token(raw: unknown, mint: string): Record<string, unknown> | null {
  if (!raw) return null
  const list = Array.isArray(raw) ? raw : [raw]
  for (const item of list) {
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>
      if (row.id === mint || row.address === mint) return row
    }
  }
  const first = list[0]
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null
}

function buildJupiterEnrichment(
  jupiterV2Raw: unknown,
  jupiterV2Normalized: unknown,
  jupiterPriceRaw: unknown,
  mint: string,
): JupiterEnrichment {
  const rawToken = pickJupiterV2Token(jupiterV2Raw, mint)
  const norm =
    jupiterV2Normalized && typeof jupiterV2Normalized === 'object'
      ? (jupiterV2Normalized as Record<string, unknown>)
      : null

  let priceUsd: number | null = null
  if (jupiterPriceRaw && typeof jupiterPriceRaw === 'object') {
    const priceObj = jupiterPriceRaw as Record<string, unknown>
    const entry = priceObj[mint] as Record<string, unknown> | undefined
    priceUsd = toNum(entry?.usdPrice ?? entry?.price) ?? null
  }

  return {
    symbol: toStr(rawToken?.symbol) ?? toStr(norm?.symbol) ?? null,
    mcap: toNum(rawToken?.mcap ?? rawToken?.marketCap) ?? null,
    fdv: toNum(rawToken?.fdv) ?? null,
    organicScore: toNum(rawToken?.organicScore ?? rawToken?.organic_score) ?? null,
    priceUsd,
  }
}

function strategyNameMap(
  defs: Awaited<ReturnType<typeof loadStrategyDefinitionRows>>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of defs) {
    map.set(d.id, d.name)
  }
  return map
}

function nameFor(
  map: Map<string, string>,
  strategyId: string | null | undefined,
): string | null {
  if (!strategyId) return null
  return map.get(strategyId) ?? strategyId
}

function buildStrategyPresence(params: {
  address: string
  links: TokenLocateResult['links']
  nameMap: Map<string, string>
  outcomeGroups: Record<string, unknown>[]
  trendingRow: Record<string, unknown> | null
  mcapRow: Record<string, unknown> | null
  signalsRow: Record<string, unknown> | null
  socialRollup: Awaited<ReturnType<typeof fetchSocialRollup>>
  socialEvents: Awaited<ReturnType<typeof fetchRecentSocialEvents>>
  dlmmPotential: Record<string, unknown> | null
  rugList: Record<string, unknown> | null
  botLocks: Record<string, unknown>[]
}): StrategyPresence[] {
  const presence: StrategyPresence[] = []
  const {
    address,
    links,
    nameMap,
    outcomeGroups,
    trendingRow,
    mcapRow,
    signalsRow,
    socialRollup,
    socialEvents,
    dlmmPotential,
    rugList,
    botLocks,
  } = params

  for (const row of outcomeGroups) {
    const domain = toStr(row.domain) ?? 'unknown'
    const strategyId = toStr(row.strategy_id) ?? null
    presence.push({
      domain,
      strategyId,
      strategyName: nameFor(nameMap, strategyId),
      source: 'strategy_outcomes',
      recordCount: toNum(row.record_count),
      lastSeenAt: toStr(row.last_seen_at),
      deepLink: `${links.strategies}&domain=${encodeURIComponent(domain)}`,
    })
  }

  if (trendingRow) {
    const sim = trendingRow.trading_simulation as Record<string, unknown> | null | undefined
    const strategyId = resolveTrackerStrategyId(sim)
    presence.push({
      domain: 'trending_bot',
      strategyId,
      strategyName: nameFor(nameMap, strategyId),
      source: trackerTable(),
      status: toStr(trendingRow.status),
      deepLink: links.algoTester,
    })
  }

  if (mcapRow) {
    presence.push({
      domain: 'mcap_tracker',
      strategyId: null,
      strategyName: null,
      source: 'token_mcap_tracking',
      label: toStr(mcapRow.label),
      deepLink: links.algoTester,
    })
  }

  if (signalsRow) {
    presence.push({
      domain: 'signals',
      strategyId: null,
      strategyName: null,
      source: 'trading_signals',
      label: toStr(signalsRow.label),
      deepLink: links.signals,
    })
  }

  if (socialRollup || socialEvents.length > 0) {
    presence.push({
      domain: 'social',
      strategyId: null,
      strategyName: null,
      source: socialRollup ? 'social_token_rollups' : 'social_token_events',
      recordCount: socialRollup
        ? toNum(socialRollup.mention_count_30m)
        : socialEvents.length,
      lastSeenAt: toStr(socialRollup?.last_event_at),
      deepLink: links.social,
    })
  }

  if (dlmmPotential) {
    presence.push({
      domain: 'dlmm',
      strategyId: null,
      strategyName: null,
      source: 'dlmm_potential_list',
      label: 'potential',
      deepLink: links.dlmm,
    })
  }

  if (rugList) {
    presence.push({
      domain: 'signals',
      strategyId: null,
      strategyName: null,
      source: 'token_rug_list',
      label: 'rugged',
      deepLink: links.signals,
    })
  }

  for (const lock of botLocks) {
    const strategyId = toStr(lock.strategy_id) ?? null
    presence.push({
      domain: toStr(lock.domain) ?? 'unknown',
      strategyId,
      strategyName: nameFor(nameMap, strategyId),
      source: 'bot_trade_locks',
      status: 'locked',
      lastSeenAt: toStr(lock.expires_at),
    })
  }

  return presence
}

export async function locateTokenByAddress(address: string): Promise<TokenLocateResult> {
  if (!isValidMintAddress(address)) {
    throw new Error('Invalid token address')
  }

  const tracker = trackerTable()
  const fetchedAt = new Date().toISOString()
  const links: TokenLocateResult['links'] = {
    chart: `/chart/${address}`,
    jupiter: formatJupiterTokenLink(address),
    signals: `/dev/signals?tab=board&addresses=${encodeURIComponent(address)}`,
    algoTester: '/dev/algo-tester',
    social: '/dev/social',
    strategies: `/dev/strategies?tab=outcomes&tokenAddress=${encodeURIComponent(address)}`,
    dlmm: '/dev/dlmm',
  }

  const [
    strategyDefs,
    jupiterV2Raw,
    jupiterV2Normalized,
    jupiterDatapiRaw,
    jupiterPriceRaw,
    jupiterSearchStats,
    trendingRow,
    mcapRow,
    mcapNotifications,
    signalsRow,
    socialRollup,
    socialEvents,
    outcomes,
    outcomeGroups,
    dlmmPotential,
    rugList,
    botLocks,
  ] = await Promise.all([
    loadStrategyDefinitionRows(),
    fetchJupiterV2SearchRaw(address).catch(() => null),
    fetchTokenMetadataFromJupiter(address).catch(() => null),
    fetchJupiterDatapiSearchRaw(address).catch(() => null),
    fetchJupiterPriceRaw(address).catch(() => null),
    searchTokenStats(address).catch(() => null),
    safeQueryOne<Record<string, unknown>>(
      `SELECT * FROM ${tracker} WHERE token_address = $1 LIMIT 1`,
      [address],
    ),
    safeQueryOne<Record<string, unknown>>(
      `SELECT * FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
      [address],
    ),
    safeQuery<Record<string, unknown>>(
      `SELECT * FROM mcap_threshold_notifications WHERE token_address = $1 ORDER BY notified_at DESC`,
      [address],
    ),
    safeQueryOne<Record<string, unknown>>(
      `SELECT * FROM trading_signals WHERE token_address = $1 LIMIT 1`,
      [address],
    ),
    fetchSocialRollup(address),
    fetchRecentSocialEvents(address, 20),
    safeQuery<Record<string, unknown>>(
      `SELECT * FROM strategy_outcomes WHERE token_address = $1 ORDER BY exit_at DESC NULLS LAST LIMIT 25`,
      [address],
    ),
    safeQuery<Record<string, unknown>>(
      `SELECT domain, strategy_id,
              COUNT(*)::int AS record_count,
              MAX(exit_at) AS last_seen_at
       FROM strategy_outcomes
       WHERE token_address = $1
       GROUP BY domain, strategy_id
       ORDER BY last_seen_at DESC NULLS LAST`,
      [address],
    ),
    safeQueryOne<Record<string, unknown>>(
      `SELECT * FROM dlmm_potential_list WHERE token_address = $1 LIMIT 1`,
      [address],
    ),
    safeQueryOne<Record<string, unknown>>(
      `SELECT * FROM token_rug_list WHERE token_address = $1 LIMIT 1`,
      [address],
    ),
    safeQuery<Record<string, unknown>>(
      `SELECT * FROM bot_trade_locks WHERE token_address = $1 AND expires_at > NOW()`,
      [address],
    ),
  ])

  const nameMap = strategyNameMap(strategyDefs)
  const jupiterEnrichment = buildJupiterEnrichment(
    jupiterV2Raw,
    jupiterV2Normalized,
    jupiterPriceRaw,
    address,
  )

  const rawSections: RawSection[] = []
  for (const s of [
    section(
      'jupiter-v2-raw',
      'Jupiter Token API (raw)',
      'lite-api.jup.ag/tokens/v2/search',
      'raw',
      jupiterV2Raw,
    ),
    section(
      'jupiter-v2-normalized',
      'Jupiter Token (normalized)',
      'lite-api.jup.ag/tokens/v2/search',
      'jupiter_enriched',
      jupiterV2Normalized,
    ),
    section(
      'jupiter-datapi-raw',
      'Jupiter datapi assets (raw)',
      'datapi.jup.ag/v1/assets/search',
      'raw',
      jupiterDatapiRaw,
    ),
    section(
      'jupiter-price-raw',
      'Jupiter price API (raw)',
      'lite-api.jup.ag/price/v3',
      'raw',
      jupiterPriceRaw,
    ),
    section(
      'jupiter-search-stats',
      'Jupiter token stats',
      'tokens.jup.ag/token + price API',
      'jupiter_enriched',
      jupiterSearchStats,
    ),
    section(
      'trending-tracker',
      'Trending Bot Tracker',
      tracker,
      'internal',
      trendingRow,
    ),
    section(
      'mcap-tracking',
      'Mcap Tracker',
      'token_mcap_tracking',
      'internal',
      mcapRow,
      toStr(mcapRow?.label),
    ),
    section(
      'mcap-notifications',
      'Mcap Threshold Notifications',
      'mcap_threshold_notifications',
      'internal',
      mcapNotifications,
    ),
    section(
      'signals-board',
      'Signals Board',
      'trading_signals',
      'internal',
      signalsRow,
      toStr(signalsRow?.label),
    ),
    section(
      'social-rollup',
      'Social Rollup',
      'social_token_rollups',
      'internal',
      socialRollup,
    ),
    section(
      'social-events',
      'Social Events (recent)',
      'social_token_events',
      'internal',
      socialEvents,
    ),
    section(
      'strategy-outcomes',
      'Strategy Outcomes',
      'strategy_outcomes',
      'internal',
      outcomes,
    ),
    section(
      'dlmm-potential',
      'DLMM Potential List',
      'dlmm_potential_list',
      'internal',
      dlmmPotential,
    ),
    section('rug-list', 'Rug List', 'token_rug_list', 'internal', rugList),
    section(
      'bot-trade-locks',
      'Bot Trade Locks',
      'bot_trade_locks',
      'internal',
      botLocks,
    ),
  ]) {
    if (s) rawSections.push(s)
  }

  const hasInternal = rawSections.some((s) => s.dataTier === 'internal')
  const hasJupiter = rawSections.some(
    (s) => s.dataTier === 'raw' || s.dataTier === 'jupiter_enriched',
  )

  const symbol =
    toStr(trendingRow?.token_symbol) ??
    toStr(mcapRow?.token_symbol) ??
    toStr(signalsRow?.token_symbol) ??
    jupiterEnrichment.symbol ??
    toStr(jupiterV2Normalized?.symbol) ??
    jupiterSearchStats?.basic?.symbol ??
    null

  const strategyPresence = buildStrategyPresence({
    address,
    links,
    nameMap,
    outcomeGroups,
    trendingRow,
    mcapRow,
    signalsRow,
    socialRollup,
    socialEvents,
    dlmmPotential,
    rugList,
    botLocks,
  })

  const locations: TokenLocateResult['locations'] = {
    trending: trendingRow
      ? {
          present: true,
          status: toStr(trendingRow.status),
          marketCap: toNum(trendingRow.market_cap),
          peakGainPct: toNum(trendingRow.peak_gain_percentage),
        }
      : null,
    mcap: mcapRow
      ? {
          present: true,
          label: toStr(mcapRow.label),
          firstMcap: toNum(mcapRow.first_mcap),
          currentMcap: toNum(mcapRow.current_mcap),
          growthPct: toNum(mcapRow.mcap_growth_percent),
        }
      : null,
    signals: signalsRow
      ? { present: true, label: toStr(signalsRow.label) }
      : null,
    social: socialRollup
      ? {
          present: true,
          mentionCount30m: toNum(socialRollup.mention_count_30m),
          lastEventAt: toStr(socialRollup.last_event_at),
        }
      : socialEvents.length > 0
        ? { present: true }
        : null,
    outcomes: { count: outcomes.length },
    dlmmPotential: dlmmPotential != null,
    rugList: rugList != null,
    activeLockCount: botLocks.length,
  }

  return {
    tokenAddress: address,
    symbol,
    found: hasInternal,
    liveOnly: !hasInternal && hasJupiter,
    jupiterEnrichment,
    strategyPresence,
    locations,
    rawSections,
    fetchedAt,
    links,
  }
}
