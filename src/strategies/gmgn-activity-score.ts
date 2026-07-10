import type { SocialTokenEventRow } from './social/types'

export type NormalizedGmgnTradeRow = {
  tokenAddress: string
  symbol: string
  walletAddress: string
  tradeUsd: number
  tradeAt: Date
  source: 'smartmoney' | 'kol'
  walletTags: string[]
}

export type GmgnActivityMetrics = {
  sm_wallet_count_60m: number
  kol_wallet_count_60m: number
  sm_buy_usd_60m: number
  kol_buy_usd_60m: number
  total_trades_60m: number
  latest_trade_at: string
  has_sm_kol_overlap: boolean
}

export type GmgnActivityScoreResult = {
  tokenAddress: string
  symbol: string
  score: number
  metrics: GmgnActivityMetrics
  latestTrade: NormalizedGmgnTradeRow
  discoverySources: Array<'smartmoney' | 'kol'>
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function getGmgnActivityWindowMinutes(): number {
  return readEnvInt('GMGN_ACTIVITY_WINDOW_MINUTES', 60)
}

export function getGmgnActivityScoreThreshold(): number {
  const raw = process.env.GMGN_ACTIVITY_SCORE_THRESHOLD?.trim()
  if (!raw) return 50
  const n = Number(raw)
  return Number.isFinite(n) ? n : 50
}

export function getGmgnActivityPollLimit(): number {
  return readEnvInt('GMGN_ACTIVITY_POLL_LIMIT', 50)
}

export function getGmgnActivityIngestCooldownMin(): number {
  return readEnvInt('GMGN_ACTIVITY_INGEST_COOLDOWN_MIN', 15)
}

function log1p(value: number): number {
  return Math.log1p(Math.max(0, value))
}

export function computeGmgnActivityScore(metrics: {
  smWalletCount: number
  kolWalletCount: number
  smBuyUsd: number
  kolBuyUsd: number
  latestTradeAgeMin: number
}): number {
  const smWallets = metrics.smWalletCount
  const kolWallets = metrics.kolWalletCount
  const buyUsd = metrics.smBuyUsd + metrics.kolBuyUsd
  const latestAge = metrics.latestTradeAgeMin

  let score = 0
  score += Math.min(smWallets, 10) * 15
  score += Math.min(kolWallets, 5) * 10
  score += log1p(buyUsd) * 10
  if (smWallets >= 2) score += 20
  if (smWallets >= 1 && kolWallets >= 1) score += 30
  if (latestAge <= 15) score += 20
  else if (latestAge <= 60) score += 10

  return Math.round(score * 100) / 100
}

export function scoreGmgnActivity(
  rows: NormalizedGmgnTradeRow[],
  options?: { windowMinutes?: number; now?: Date },
): GmgnActivityScoreResult[] {
  const windowMinutes = options?.windowMinutes ?? getGmgnActivityWindowMinutes()
  const now = options?.now ?? new Date()
  const windowMs = windowMinutes * 60 * 1000
  const cutoff = now.getTime() - windowMs

  const inWindow = rows.filter((row) => row.tradeAt.getTime() >= cutoff)
  const byToken = new Map<string, NormalizedGmgnTradeRow[]>()

  for (const row of inWindow) {
    const list = byToken.get(row.tokenAddress) ?? []
    list.push(row)
    byToken.set(row.tokenAddress, list)
  }

  const results: GmgnActivityScoreResult[] = []

  for (const [tokenAddress, tokenRows] of Array.from(byToken.entries())) {
    const smWallets = new Set<string>()
    const kolWallets = new Set<string>()
    let smBuyUsd = 0
    let kolBuyUsd = 0
    let latestTrade = tokenRows[0]

    for (const row of tokenRows) {
      if (row.source === 'smartmoney') {
        if (row.walletAddress) smWallets.add(row.walletAddress)
        smBuyUsd += row.tradeUsd
      } else {
        if (row.walletAddress) kolWallets.add(row.walletAddress)
        kolBuyUsd += row.tradeUsd
      }
      if (row.tradeAt.getTime() > latestTrade.tradeAt.getTime()) {
        latestTrade = row
      }
    }

    const latestAgeMin = Math.max(0, (now.getTime() - latestTrade.tradeAt.getTime()) / (60 * 1000))
    const smCount = smWallets.size
    const kolCount = kolWallets.size
    const discoverySources: Array<'smartmoney' | 'kol'> = []
    if (smCount > 0) discoverySources.push('smartmoney')
    if (kolCount > 0) discoverySources.push('kol')

    const metrics: GmgnActivityMetrics = {
      sm_wallet_count_60m: smCount,
      kol_wallet_count_60m: kolCount,
      sm_buy_usd_60m: Math.round(smBuyUsd * 100) / 100,
      kol_buy_usd_60m: Math.round(kolBuyUsd * 100) / 100,
      total_trades_60m: tokenRows.length,
      latest_trade_at: latestTrade.tradeAt.toISOString(),
      has_sm_kol_overlap: smCount > 0 && kolCount > 0,
    }

    const score = computeGmgnActivityScore({
      smWalletCount: smCount,
      kolWalletCount: kolCount,
      smBuyUsd,
      kolBuyUsd,
      latestTradeAgeMin: latestAgeMin,
    })

    results.push({
      tokenAddress,
      symbol: latestTrade.symbol,
      score,
      metrics,
      latestTrade,
      discoverySources,
    })
  }

  return results.sort((a, b) => b.score - a.score)
}

export function gmgnScoreToFeatureFields(input: {
  score: number
  metrics: GmgnActivityMetrics
  discoverySources: string[]
  hasHotSignal?: boolean
}): Record<string, unknown> {
  return {
    gmgn_activity_score: input.score,
    sm_wallet_count_60m: input.metrics.sm_wallet_count_60m,
    kol_wallet_count_60m: input.metrics.kol_wallet_count_60m,
    sm_buy_usd_60m: input.metrics.sm_buy_usd_60m,
    kol_buy_usd_60m: input.metrics.kol_buy_usd_60m,
    has_gmgn_hot_signal: input.hasHotSignal ? 1 : 0,
    discovery_sources: input.discoverySources,
  }
}

function readMetadataNumber(meta: Record<string, unknown>, key: string): number {
  const v = meta[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Build GMGN score fields from recent social events (mcap/signals sim open). */
export function extractGmgnScoreFieldsFromSocialEvents(
  events: Pick<SocialTokenEventRow, 'source' | 'event_type' | 'occurred_at' | 'raw_metadata'>[],
  atTime: Date = new Date(),
): Record<string, unknown> {
  const windowMs = getGmgnActivityWindowMinutes() * 60 * 1000
  const cutoff = atTime.getTime() - windowMs

  let maxScore = 0
  let smWallets = 0
  let kolWallets = 0
  let smBuyUsd = 0
  let kolBuyUsd = 0
  let hasHot = false
  const sources = new Set<string>()

  for (const event of events) {
    const source = String(event.source ?? '')
    if (!source.startsWith('gmgn_')) continue
    if (String(event.event_type ?? '') !== 'wallet_buy') continue

    const ms = new Date(String(event.occurred_at)).getTime()
    if (!Number.isFinite(ms) || ms < cutoff) continue

    if (source === 'gmgn_hot') hasHot = true

    const meta =
      event.raw_metadata && typeof event.raw_metadata === 'object'
        ? (event.raw_metadata as Record<string, unknown>)
        : {}

    maxScore = Math.max(maxScore, readMetadataNumber(meta, 'gmgn_activity_score'))
    smWallets = Math.max(smWallets, readMetadataNumber(meta, 'sm_wallet_count_60m'))
    kolWallets = Math.max(kolWallets, readMetadataNumber(meta, 'kol_wallet_count_60m'))
    smBuyUsd = Math.max(smBuyUsd, readMetadataNumber(meta, 'sm_buy_usd_60m'))
    kolBuyUsd = Math.max(kolBuyUsd, readMetadataNumber(meta, 'kol_buy_usd_60m'))

    const discovery = meta.discovery_sources
    if (Array.isArray(discovery)) {
      for (const s of discovery) {
        if (typeof s === 'string' && s) sources.add(s)
      }
    }
  }

  if (maxScore === 0 && !hasHot && smWallets === 0 && kolWallets === 0) {
    return {
      gmgn_activity_score: 0,
      sm_wallet_count_60m: 0,
      kol_wallet_count_60m: 0,
      sm_buy_usd_60m: 0,
      kol_buy_usd_60m: 0,
      has_gmgn_hot_signal: 0,
      discovery_sources: [],
    }
  }

  return gmgnScoreToFeatureFields({
    score: maxScore,
    metrics: {
      sm_wallet_count_60m: smWallets,
      kol_wallet_count_60m: kolWallets,
      sm_buy_usd_60m: smBuyUsd,
      kol_buy_usd_60m: kolBuyUsd,
      total_trades_60m: 0,
      latest_trade_at: atTime.toISOString(),
      has_sm_kol_overlap: smWallets > 0 && kolWallets > 0,
    },
    discoverySources: Array.from(sources),
    hasHotSignal: hasHot,
  })
}
