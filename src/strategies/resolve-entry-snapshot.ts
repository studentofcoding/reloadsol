import { queryOne } from '@/utils/db'
import { fetchDexScreenerVolumeHints } from '@/utils/dexscreener-volume'
import {
  fetchJupiterMarketHints,
  fetchTokenMetadataFromJupiter,
  type JupiterVolumeWindow,
} from '@/utils/jupiter-metadata'
import { fetchMcapTrackingRow, upsertMcapEntryMeta } from '@/utils/mcap-tracker'
import {
  buildEntryFeatureSnapshot,
  type EntryFeatureSnapshotInput,
  type MonitorSnapshot,
} from './entry-feature-snapshot'
import { extractGmgnScoreFieldsFromSocialEvents } from './gmgn-activity-score'
import { extractMlFeatureVectorV1 } from './ml-training-features'
import { fetchRecentSocialEvents } from './social/db'
import { resolveTokenMonitorSnapshot, TRACKER_TABLE } from './sim-monitor-snapshots'
import type { SocialSnapshot } from './social-snapshot'
import type { StrategyDomain } from './types'

export type EntrySnapshotOverrides = {
  entryAt?: string | null
  firstSeenAt?: string | null
  entryMcap?: number | null
  organicScore?: number | null
  topHoldersPct?: number | null
  volume5m?: number | null
  tokenSymbol?: string | null
  monitorSnapshots?: MonitorSnapshot[]
  social?: SocialSnapshot | null
  /** Caller already has fresh pool/Jupiter data — skip remote metadata fetch */
  skipJupiter?: boolean
}

type TrackerEntryHints = {
  organicScore: number | null
  volume5m: number | null
  firstSeenAt: string | null
  entryMcap: number | null
}

type JupiterEntryHints = {
  organicScore: number | null
  topHoldersPct: number | null
  volume5m: number | null
  mcap: number | null
  volumeWindow: JupiterVolumeWindow | null
}

async function fetchTrackerEntryHints(
  tokenAddress: string,
): Promise<TrackerEntryHints | null> {
  try {
    const data = await queryOne<{
      organic_score: unknown
      volume_5m: unknown
      market_cap: unknown
      created_at: unknown
      tracking_started_at: unknown
    }>(
      `SELECT organic_score, volume_5m, market_cap, created_at, tracking_started_at
       FROM ${TRACKER_TABLE}
       WHERE token_address = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [tokenAddress],
    )

    if (!data) return null

    return {
      organicScore:
        typeof data.organic_score === 'number' && Number.isFinite(data.organic_score)
          ? data.organic_score
          : null,
      volume5m:
        typeof data.volume_5m === 'number' && Number.isFinite(data.volume_5m)
          ? data.volume_5m
          : null,
      firstSeenAt:
        typeof data.tracking_started_at === 'string'
          ? data.tracking_started_at
          : typeof data.created_at === 'string'
            ? data.created_at
            : null,
      entryMcap:
        typeof data.market_cap === 'number' && Number.isFinite(data.market_cap)
          ? data.market_cap
          : null,
    }
  } catch {
    return null
  }
}

async function fetchJupiterEntryHints(
  tokenAddress: string,
  opts: { needMeta: boolean; needVolume: boolean; needMcap: boolean },
): Promise<JupiterEntryHints | null> {
  if (!opts.needMeta && !opts.needVolume && !opts.needMcap) return null

  let organicScore: number | null = null
  let topHoldersPct: number | null = null
  let volume5m: number | null = null
  let mcap: number | null = null
  let volumeWindow: JupiterVolumeWindow | null = null

  const tasks: Promise<void>[] = []

  if (opts.needMeta) {
    tasks.push(
      fetchTokenMetadataFromJupiter(tokenAddress)
        .then((meta) => {
          organicScore =
            typeof meta.organicScore === 'number' && Number.isFinite(meta.organicScore)
              ? meta.organicScore
              : null
          topHoldersPct =
            typeof meta.audit?.topHoldersPercentage === 'number' &&
            Number.isFinite(meta.audit.topHoldersPercentage)
              ? meta.audit.topHoldersPercentage
              : null
        })
        .catch(() => {
          /* leave nulls */
        }),
    )
  }

  if (opts.needVolume || opts.needMcap) {
    tasks.push(
      fetchJupiterMarketHints(tokenAddress).then((market) => {
        volume5m = market?.volume5m ?? null
        mcap = market?.mcap ?? null
        volumeWindow = market?.volumeWindow ?? null
      }),
    )
  }

  await Promise.all(tasks)

  if (
    organicScore == null &&
    topHoldersPct == null &&
    volume5m == null &&
    mcap == null
  ) {
    return null
  }

  return { organicScore, topHoldersPct, volume5m, mcap, volumeWindow }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function resolveEntrySnapshotInput(
  tokenAddress: string,
  overrides: EntrySnapshotOverrides = {},
): Promise<EntryFeatureSnapshotInput> {
  const [trackerHints, mcapRow, liveMonitor] = await Promise.all([
    fetchTrackerEntryHints(tokenAddress),
    fetchMcapTrackingRow(tokenAddress),
    overrides.monitorSnapshots != null
      ? Promise.resolve(null)
      : resolveTokenMonitorSnapshot(tokenAddress, overrides.entryMcap ?? null),
  ])

  const entryAt = overrides.entryAt ?? new Date().toISOString()
  const firstSeenAt =
    overrides.firstSeenAt ??
    mcapRow?.first_seen_at ??
    trackerHints?.firstSeenAt ??
    null

  let entryMcap =
    overrides.entryMcap ??
    numOrNull(mcapRow?.current_mcap) ??
    trackerHints?.entryMcap ??
    null

  let organicScore =
    overrides.organicScore ??
    numOrNull(mcapRow?.organic_score) ??
    trackerHints?.organicScore ??
    null

  let topHoldersPct =
    overrides.topHoldersPct ??
    numOrNull(mcapRow?.top_holders_pct) ??
    null

  let volume5m =
    overrides.volume5m ??
    numOrNull(mcapRow?.volume_5m) ??
    trackerHints?.volume5m ??
    liveMonitor?.volume_5m ??
    null

  let volumeSource: string | null =
    overrides.volume5m != null
      ? 'override'
      : numOrNull(mcapRow?.volume_5m) != null
        ? 'mcap_tracking'
        : trackerHints?.volume5m != null
          ? 'tracker'
          : liveMonitor?.volume_5m != null
            ? 'monitor'
            : null
  let volumeWindow: string | null = null

  const needMeta =
    !overrides.skipJupiter && (organicScore == null || topHoldersPct == null)
  const needVolume = !overrides.skipJupiter && volume5m == null
  const needMcap = !overrides.skipJupiter && entryMcap == null

  const jupiterHints =
    needMeta || needVolume || needMcap
      ? await fetchJupiterEntryHints(tokenAddress, {
          needMeta,
          needVolume,
          needMcap,
        })
      : null

  if (organicScore == null) organicScore = jupiterHints?.organicScore ?? null
  if (topHoldersPct == null) topHoldersPct = jupiterHints?.topHoldersPct ?? null
  if (volume5m == null && jupiterHints?.volume5m != null) {
    volume5m = jupiterHints.volume5m
    volumeSource = 'jupiter'
    volumeWindow = jupiterHints.volumeWindow
  }
  if (entryMcap == null) entryMcap = jupiterHints?.mcap ?? null

  if (volume5m == null && !overrides.skipJupiter) {
    const dex = await fetchDexScreenerVolumeHints(tokenAddress)
    if (dex) {
      volume5m = dex.volume
      volumeSource = 'dexscreener'
      volumeWindow = dex.window
    }
  }

  // Best-effort persist meta onto mcap tracking for future opens
  if (organicScore != null || topHoldersPct != null || volume5m != null) {
    void upsertMcapEntryMeta(tokenAddress, {
      organicScore,
      topHoldersPct,
      volume5m,
    }).catch(() => {
      /* non-fatal */
    })
  }

  const monitorSnapshots =
    overrides.monitorSnapshots ??
    (liveMonitor &&
    (liveMonitor.volume_5m != null || liveMonitor.price_usd != null)
      ? [liveMonitor]
      : [])

  return {
    entryAt,
    firstSeenAt,
    entryMcap,
    organicScore,
    topHoldersPct,
    volume5m,
    volumeSource,
    volumeWindow,
    tokenSymbol: overrides.tokenSymbol ?? null,
    monitorSnapshots,
    social: overrides.social ?? null,
  }
}

export async function buildFullEntryFeatureSnapshot(
  tokenAddress: string,
  overrides: EntrySnapshotOverrides = {},
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = await resolveEntrySnapshotInput(tokenAddress, overrides)
  const base = buildEntryFeatureSnapshot(input)

  let gmgnFields: Record<string, unknown> = {}
  try {
    const events = await fetchRecentSocialEvents(tokenAddress, 50)
    gmgnFields = extractGmgnScoreFieldsFromSocialEvents(events)
  } catch {
    gmgnFields = {}
  }

  return {
    ...(extra ?? {}),
    ...base,
    ...gmgnFields,
  }
}

/**
 * If buy entry_features lack the five ML numerics, rebuild from live sources
 * so outcomes remain exportable. Shared by mcap / signals / trending closes.
 */
export async function ensureCompleteBuyFeaturesForOutcome(params: {
  mintAddress: string
  buyFeatures: Record<string, unknown> | null | undefined
  overrides?: EntrySnapshotOverrides
  extra?: Record<string, unknown>
  domain?: StrategyDomain
}): Promise<Record<string, unknown> | null> {
  const buy = params.buyFeatures ?? null
  const domain = params.domain ?? 'mcap_tracker'
  const entryAt = params.overrides?.entryAt ?? null
  if (buy && extractMlFeatureVectorV1(buy, domain, { entryAt }) != null) {
    return buy
  }

  try {
    const rebuilt = await buildFullEntryFeatureSnapshot(
      params.mintAddress,
      params.overrides ?? {},
      params.extra,
    )
    return { ...(buy ?? {}), ...rebuilt }
  } catch {
    return buy
  }
}

/** Merge rebuilt snapshot into features, filling only null/missing core fields. */
export function mergeNullCoreFeatures(
  existing: Record<string, unknown>,
  rebuilt: Record<string, unknown>,
): Record<string, unknown> {
  const coreKeys = [
    'entry_mcap',
    'first_mcap',
    'entry_mcap_band',
    'organic_score',
    'top_holders_pct',
    'token_age_hours',
    'volume_at_entry',
    'volume_5m',
    'first_seen_at',
  ] as const
  const out = { ...existing }
  for (const key of coreKeys) {
    const cur = out[key]
    const next = rebuilt[key]
    const curMissing =
      cur == null ||
      (typeof cur === 'number' && !Number.isFinite(cur))
    if (curMissing && next != null) {
      out[key] = next
    }
  }
  if (out.ml_skipped === 'incomplete_token_features' || out.ml_skipped === 'no_model_or_incomplete_features') {
    if (extractMlFeatureVectorV1(out) != null) {
      delete out.ml_skipped
    }
  }
  return out
}
