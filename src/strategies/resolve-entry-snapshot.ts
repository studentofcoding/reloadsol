import { queryOne } from '@/utils/db'
import {
  fetchJupiterMarketHints,
  fetchTokenMetadataFromJupiter,
} from '@/utils/jupiter-metadata'
import { fetchMcapTrackingRow } from '@/utils/mcap-tracker'
import {
  buildEntryFeatureSnapshot,
  type EntryFeatureSnapshotInput,
  type MonitorSnapshot,
} from './entry-feature-snapshot'
import { resolveTokenMonitorSnapshot, TRACKER_TABLE } from './sim-monitor-snapshots'
import type { SocialSnapshot } from './social-snapshot'

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
  opts: { needMeta: boolean; needVolume: boolean },
): Promise<JupiterEntryHints | null> {
  if (!opts.needMeta && !opts.needVolume) return null

  let organicScore: number | null = null
  let topHoldersPct: number | null = null
  let volume5m: number | null = null

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

  if (opts.needVolume) {
    tasks.push(
      fetchJupiterMarketHints(tokenAddress).then((market) => {
        volume5m = market?.volume5m ?? null
      }),
    )
  }

  await Promise.all(tasks)

  if (organicScore == null && topHoldersPct == null && volume5m == null) {
    return null
  }

  return { organicScore, topHoldersPct, volume5m }
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

  const entryMcap =
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

  const needMeta =
    !overrides.skipJupiter && (organicScore == null || topHoldersPct == null)
  // liveMonitor already ran Jupiter waterfall for volume when needed
  const needVolume = !overrides.skipJupiter && volume5m == null

  const jupiterHints =
    needMeta || needVolume
      ? await fetchJupiterEntryHints(tokenAddress, { needMeta, needVolume })
      : null

  if (organicScore == null) organicScore = jupiterHints?.organicScore ?? null
  if (topHoldersPct == null) topHoldersPct = jupiterHints?.topHoldersPct ?? null
  if (volume5m == null) volume5m = jupiterHints?.volume5m ?? null

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
  return {
    ...(extra ?? {}),
    ...buildEntryFeatureSnapshot(input),
  }
}
