import { queryOne } from '@/utils/db'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { updateTradingRecordData } from '@/utils/trading-records-db'
import type { McapToast } from '@/types/mcap-toasts'
import { fetchFirstGmgnHotAfter } from './social/db'
import { findStrategyBuyRecord } from './sim-monitor-snapshots'
import { fetchTradingRecordsForWallet } from './db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { log } from '@/utils/unified-logger'

export type GmgnHotAfterEntryFields = {
  has_gmgn_hot_after_entry: 0 | 1
  gmgn_hot_after_entry_at: string | null
  minutes_entry_to_gmgn_hot: number | null
  gmgn_activity_score_after_entry: number
  gmgn_live_boost_score: number
  gmgn_live_boost_applied_at: string
  gmgn_live_boost_source: string
}

export type GmgnHotEventLike = {
  occurred_at: string
  raw_metadata?: Record<string, unknown>
}

const SIM_WALLETS = () => [
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim',
  process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim',
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim',
]

const pendingGmgnToasts: McapToast[] = []
const recentToastKeys = new Map<string, number>()
const TOAST_DEDUP_MS = 30 * 60 * 1000

function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function readEnvNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function isGmgnLiveBoostEnabled(): boolean {
  return readEnvBool('GMGN_LIVE_BOOST_ENABLED', true)
}

export function getGmgnLiveBoostScoreDefault(): number {
  return readEnvNum('GMGN_LIVE_BOOST_SCORE', 25)
}

export function getGmgnLiveBoostMinScore(): number {
  return readEnvNum('GMGN_LIVE_BOOST_MIN_SCORE', 50)
}

export type GmgnLiveBoostExitMode = 'off' | 'shadow' | 'apply'

export function getGmgnLiveBoostExitMode(): GmgnLiveBoostExitMode {
  const mode = process.env.GMGN_LIVE_BOOST_EXIT?.trim().toLowerCase()
  if (mode === 'apply') return 'apply'
  if (mode === 'off') return 'off'
  return 'shadow'
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

export function computeGmgnLiveBoostScore(metadata: Record<string, unknown>): number {
  let score = getGmgnLiveBoostScoreDefault()
  const sm = readMetadataNumber(metadata, 'sm_wallet_count_60m')
  const kol = readMetadataNumber(metadata, 'kol_wallet_count_60m')
  if (sm >= 1 && kol >= 1) score += 10
  if (sm >= 2) score += 5
  return score
}

export function buildGmgnHotAfterEntryFields(params: {
  anchorAt: string
  hotEvent: GmgnHotEventLike
  liveBoostScore: number
  source: string
}): GmgnHotAfterEntryFields {
  const anchorMs = new Date(params.anchorAt).getTime()
  const hotMs = new Date(params.hotEvent.occurred_at).getTime()
  const minutes =
    Number.isFinite(anchorMs) && Number.isFinite(hotMs) && hotMs >= anchorMs
      ? Math.round((hotMs - anchorMs) / (60 * 1000))
      : null
  const meta = params.hotEvent.raw_metadata ?? {}

  return {
    has_gmgn_hot_after_entry: 1,
    gmgn_hot_after_entry_at: params.hotEvent.occurred_at,
    minutes_entry_to_gmgn_hot: minutes,
    gmgn_activity_score_after_entry: readMetadataNumber(meta, 'gmgn_activity_score'),
    gmgn_live_boost_score: params.liveBoostScore,
    gmgn_live_boost_applied_at: new Date().toISOString(),
    gmgn_live_boost_source: params.source,
  }
}

export async function detectGmgnHotAfterEntry(params: {
  tokenAddress: string
  anchorAt: string
  untilAt?: string | null
}): Promise<(GmgnHotAfterEntryFields & { hotEvent: GmgnHotEventLike }) | null> {
  const hot = await fetchFirstGmgnHotAfter({
    tokenAddress: params.tokenAddress,
    anchorAt: params.anchorAt,
    untilAt: params.untilAt,
  })
  if (!hot) return null

  const meta = hot.raw_metadata ?? {}
  const activityScore = readMetadataNumber(meta, 'gmgn_activity_score')
  if (activityScore < getGmgnLiveBoostMinScore()) return null

  const liveBoostScore = computeGmgnLiveBoostScore(meta)
  return {
    hotEvent: hot,
    ...buildGmgnHotAfterEntryFields({
      anchorAt: params.anchorAt,
      hotEvent: hot,
      liveBoostScore,
      source: 'detect',
    }),
  }
}

function alreadyBoosted(features: Record<string, unknown>): boolean {
  return features.has_gmgn_hot_after_entry === 1 || features.has_gmgn_hot_after_entry === true
}

function applyExitBoostToSim(
  sim: Record<string, unknown>,
  activityScore: number,
): Record<string, unknown> {
  const mode = getGmgnLiveBoostExitMode()
  if (mode === 'off') return sim

  const rawExit = sim.effective_exit
  if (!rawExit || typeof rawExit !== 'object') return sim

  const exit = rawExit as Record<string, unknown>
  const baseTp = typeof exit.takeProfitPct === 'number' ? exit.takeProfitPct : null
  if (baseTp == null) return sim

  const widenPct = activityScore >= 80 ? 20 : activityScore >= 60 ? 15 : 10
  const boostedTp = Math.min(baseTp + widenPct, 500)
  const effective = { ...exit, takeProfitPct: boostedTp }
  const audit = {
    gmgn_exit_boost_mode: mode,
    gmgn_exit_boost_at: new Date().toISOString(),
    gmgn_exit_boost_base_tp: baseTp,
    gmgn_exit_boost_effective_tp: boostedTp,
    gmgn_exit_boost_activity_score: activityScore,
  }

  if (mode === 'shadow') {
    console.info('[gmgn-live-boost:exit-shadow]', {
      base_tp: baseTp,
      effective_tp: boostedTp,
      activity_score: activityScore,
    })
    return {
      ...sim,
      entry_features: {
        ...(sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {}),
        ...audit,
      },
    }
  }

  return {
    ...sim,
    effective_exit: effective,
    entry_features: {
      ...(sim.entry_features && typeof sim.entry_features === 'object'
        ? (sim.entry_features as Record<string, unknown>)
        : {}),
      ...audit,
      gmgn_exit_boost_applied: true,
    },
  }
}

async function persistBuyRecordLiveBoost(params: {
  buyRecord: TrackingRecord
  boostFields: GmgnHotAfterEntryFields
  activityScore: number
}): Promise<boolean> {
  const sim = (params.buyRecord.trading_simulation ?? {}) as Record<string, unknown>
  const entryFeatures =
    sim.entry_features && typeof sim.entry_features === 'object'
      ? (sim.entry_features as Record<string, unknown>)
      : {}

  if (alreadyBoosted(entryFeatures)) return false

  const prevSocialBoost =
    typeof entryFeatures.social_boost_score === 'number'
      ? entryFeatures.social_boost_score
      : 0

  const nextFeatures = {
    ...entryFeatures,
    ...params.boostFields,
    social_boost_score: prevSocialBoost + params.boostFields.gmgn_live_boost_score,
  }

  let nextSim: Record<string, unknown> = {
    ...sim,
    entry_features: nextFeatures,
  }
  nextSim = applyExitBoostToSim(nextSim, params.activityScore)

  const nextRecord: TrackingRecord = {
    ...params.buyRecord,
    trading_simulation: nextSim,
  }

  return updateTradingRecordData(params.buyRecord.id, nextRecord)
}

function recordGmgnConfirmToast(params: {
  tokenAddress: string
  symbol: string
  strategyId: string
  activityScore: number
}): void {
  if (!readEnvBool('GMGN_LIVE_BOOST_TOAST', true)) return

  const now = Date.now()
  const key = `gmgn_confirm:${params.strategyId}:${params.tokenAddress}`
  const last = recentToastKeys.get(key)
  if (last && now - last <= TOAST_DEDUP_MS) return
  recentToastKeys.set(key, now)

  pendingGmgnToasts.push({
    type: 'success',
    category: 'predictive',
    title: 'GMGN confirmed open position',
    message: `${params.symbol} — GMGN hot score ${Math.round(params.activityScore)} after entry`,
    key,
    items: [
      {
        symbol: params.symbol,
        address: params.tokenAddress,
        growthPercent: 0,
        strategyId: params.strategyId,
      },
    ],
  })
  while (pendingGmgnToasts.length > 50) pendingGmgnToasts.shift()
}

export function drainGmgnLiveBoostToasts(): McapToast[] {
  return pendingGmgnToasts.splice(0, pendingGmgnToasts.length)
}

async function boostOpenSimForWallet(params: {
  walletAddress: string
  tokenAddress: string
  hotEvent: GmgnHotEventLike
  source: string
}): Promise<number> {
  const records = await fetchTradingRecordsForWallet(params.walletAddress)
  const cycle = computeOpenSimCycle(records, params.tokenAddress)
  if (!cycle) return 0

  const buyRecords = records.filter(
    (rec) =>
      rec.operationType === 'buy' &&
      rec.is_simulation &&
      rec.tokens?.some((t) => t.mintAddress === params.tokenAddress),
  )

  let boosted = 0
  for (const buyRecord of buyRecords) {
    const sim = (buyRecord.trading_simulation ?? {}) as Record<string, unknown>
    const entryFeatures =
      sim.entry_features && typeof sim.entry_features === 'object'
        ? (sim.entry_features as Record<string, unknown>)
        : {}
    if (alreadyBoosted(entryFeatures)) continue

    const anchorAt =
      typeof sim.entry_at === 'string'
        ? sim.entry_at
        : new Date(buyRecord.timestamp).toISOString()

    const hotMs = new Date(params.hotEvent.occurred_at).getTime()
    const anchorMs = new Date(anchorAt).getTime()
    if (!Number.isFinite(hotMs) || !Number.isFinite(anchorMs) || hotMs <= anchorMs) {
      continue
    }

    const meta = params.hotEvent.raw_metadata ?? {}
    const activityScore = readMetadataNumber(meta, 'gmgn_activity_score')
    if (activityScore < getGmgnLiveBoostMinScore()) continue

    const liveBoostScore = computeGmgnLiveBoostScore(meta)
    const boostFields = buildGmgnHotAfterEntryFields({
      anchorAt,
      hotEvent: params.hotEvent,
      liveBoostScore,
      source: params.source,
    })

    const strategyBuy = findStrategyBuyRecord(
      records,
      buyRecord.bot_strategy ?? '',
      params.tokenAddress,
    )
    const target = strategyBuy ?? buyRecord
    const ok = await persistBuyRecordLiveBoost({
      buyRecord: target,
      boostFields,
      activityScore,
    })
    if (ok) {
      boosted++
      const symbol =
        target.tokens?.find((t) => t.mintAddress === params.tokenAddress)?.symbol ??
        params.tokenAddress.slice(0, 8)
      recordGmgnConfirmToast({
        tokenAddress: params.tokenAddress,
        symbol,
        strategyId: target.bot_strategy ?? 'unknown',
        activityScore,
      })
    }
  }

  return boosted
}

async function isTrackedMcapToken(tokenAddress: string): Promise<string | null> {
  try {
    const row = await queryOne<{ first_seen_at: string }>(
      `SELECT first_seen_at FROM token_mcap_tracking WHERE token_address = $1 LIMIT 1`,
      [tokenAddress],
    )
    return row?.first_seen_at ?? null
  } catch {
    return null
  }
}

export async function applyGmgnLiveBoost(params: {
  tokenAddress: string
  hotEvent: GmgnHotEventLike
  source: 'activity_poll' | 'sim_tick'
}): Promise<{ simPositionsBoosted: number; trackedBoosted: boolean }> {
  if (!isGmgnLiveBoostEnabled()) {
    return { simPositionsBoosted: 0, trackedBoosted: false }
  }

  const meta = params.hotEvent.raw_metadata ?? {}
  const activityScore = readMetadataNumber(meta, 'gmgn_activity_score')
  if (activityScore < getGmgnLiveBoostMinScore()) {
    return { simPositionsBoosted: 0, trackedBoosted: false }
  }

  let simPositionsBoosted = 0
  for (const wallet of SIM_WALLETS()) {
    simPositionsBoosted += await boostOpenSimForWallet({
      walletAddress: wallet,
      tokenAddress: params.tokenAddress,
      hotEvent: params.hotEvent,
      source: params.source,
    })
  }

  let trackedBoosted = false
  const firstSeenAt = await isTrackedMcapToken(params.tokenAddress)
  if (firstSeenAt) {
    const hotMs = new Date(params.hotEvent.occurred_at).getTime()
    const anchorMs = new Date(firstSeenAt).getTime()
    if (Number.isFinite(hotMs) && Number.isFinite(anchorMs) && hotMs > anchorMs) {
      trackedBoosted = true
      log.info('api_request', 'GMGN live boost tracked token', {
        token: params.tokenAddress,
        first_seen_at: firstSeenAt,
        hot_at: params.hotEvent.occurred_at,
        activity_score: activityScore,
      })
    }
  }

  if (simPositionsBoosted > 0 || trackedBoosted) {
    log.info('api_request', 'GMGN live boost applied', {
      token: params.tokenAddress,
      simPositionsBoosted,
      trackedBoosted,
      source: params.source,
    })
  }

  return { simPositionsBoosted, trackedBoosted }
}

/** Backup path: sim monitor tick checks DB for gmgn_hot after entry_at. */
export async function checkGmgnLiveBoostForOpenPosition(params: {
  walletAddress: string
  strategyId: string
  mintAddress: string
  entryAt: string | null
  symbol?: string
}): Promise<boolean> {
  if (!isGmgnLiveBoostEnabled() || !params.entryAt) return false

  const detected = await detectGmgnHotAfterEntry({
    tokenAddress: params.mintAddress,
    anchorAt: params.entryAt,
  })
  if (!detected) return false

  const result = await applyGmgnLiveBoost({
    tokenAddress: params.mintAddress,
    hotEvent: detected.hotEvent,
    source: 'sim_tick',
  })

  return result.simPositionsBoosted > 0
}

/** Test helper */
export function resetGmgnLiveBoostStateForTests(): void {
  pendingGmgnToasts.length = 0
  recentToastKeys.clear()
}
