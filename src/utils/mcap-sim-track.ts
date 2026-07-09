import type { McapTrackerStrategy } from '@/strategies/types'
import { isInTrackingRange, type McapSnapshot } from '@/utils/mcap-tracker'
import { computeOpenTradeCycle } from '@/utils/simulation-trades'
import type { TrackingRecord } from '@/utils/trading-tracker'

export type McapSimOpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  entryFeatures: Record<string, unknown>
}

function readEntryMcap(features: Record<string, unknown>): number {
  const v = features.entry_mcap
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function readEntryTemplate(
  features: Record<string, unknown>,
): 'first_seen' | 'milestone_80' {
  return features.entry_template === 'milestone_80' ? 'milestone_80' : 'first_seen'
}

export function getOpenMcapPositions(
  records: TrackingRecord[],
  strategyId: string,
  mode: 'sim' | 'live',
): McapSimOpenPosition[] {
  const isSim = mode === 'sim'
  const seen = new Set<string>()
  const open: McapSimOpenPosition[] = []

  for (const r of records) {
    if (r.is_simulation !== isSim || r.bot_strategy !== strategyId) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenTradeCycle(records, t.mintAddress, mode)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      const buyRecord = records.find(
        (rec) =>
          rec.operationType === 'buy' &&
          rec.bot_strategy === strategyId &&
          rec.is_simulation === isSim &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      if (!buyRecord) continue
      seen.add(t.mintAddress)
      const sim = (buyRecord.trading_simulation ?? {}) as Record<string, unknown>
      const entryFeatures =
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {}
      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol ?? t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryMcap: readEntryMcap(entryFeatures),
        entryTemplate: readEntryTemplate(entryFeatures),
        entryFeatures,
      })
    }
  }

  return open
}

export function getOpenMcapSimPositions(
  records: TrackingRecord[],
  strategyId: string,
): McapSimOpenPosition[] {
  return getOpenMcapPositions(records, strategyId, 'sim')
}

export function countOpenMcapSimPositions(
  records: TrackingRecord[],
  strategyId: string,
): number {
  return getOpenMcapSimPositions(records, strategyId).length
}

export type McapSimOpenSkipReason =
  | 'already_open'
  | 'already_closed'
  | 'rugged'
  | 'out_of_range'
  | 'first_seen_too_old'
  | 'milestone_too_old'
  | 'no_milestone'
  | 'no_entry_mcap'
  | 'low_organic'
  | 'high_holders'
  | 'ml_gate_reject'

function recencyWindowMs(strategy: McapTrackerStrategy): number {
  return strategy.config.query.recencyMinutes * 60 * 1000
}

function ageMsFromIso(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Date.now() - ms
}

function isWithinRecency(
  strategy: McapTrackerStrategy,
  iso: string | null | undefined,
): boolean {
  const ageMs = ageMsFromIso(iso)
  if (ageMs == null) return false
  return ageMs <= recencyWindowMs(strategy)
}

/**
 * milestone_80 entry:
 * - Timely (when_reach_80pct within recency): theoretical first_mcap * 1.8
 * - Otherwise (late / no stamp but still allowed): live current_mcap
 */
export function resolveMcapSimEntry(
  strategy: McapTrackerStrategy,
  snapshot: McapSnapshot,
): { entryMcap: number; entryAt: string } | null {
  if (strategy.config.entryTemplate === 'first_seen') {
    if (!snapshot.first_mcap || snapshot.first_mcap <= 0) return null
    return { entryMcap: snapshot.first_mcap, entryAt: snapshot.first_seen_at }
  }

  const growth = snapshot.mcap_growth_percent ?? 0
  if (!snapshot.first_mcap || snapshot.first_mcap <= 0) return null
  if (!snapshot.when_reach_80pct && growth < 80) return null

  const milestoneFresh = isWithinRecency(strategy, snapshot.when_reach_80pct)
  if (snapshot.when_reach_80pct && milestoneFresh) {
    return {
      entryMcap: Math.round(snapshot.first_mcap * 1.8),
      entryAt: snapshot.when_reach_80pct,
    }
  }

  // Late open or growth-only path: book at live mcap so alerts/PnL match a real buy.
  if (!snapshot.current_mcap || snapshot.current_mcap <= 0) return null
  const entryAt =
    snapshot.last_updated_at ||
    snapshot.when_reach_80pct ||
    snapshot.first_seen_at ||
    new Date().toISOString()
  return { entryMcap: snapshot.current_mcap, entryAt }
}

export function getMcapSimOpenSkipReason(
  strategy: McapTrackerStrategy,
  snapshot: McapSnapshot,
  openMintSet: Set<string>,
  closedOutcomeKeys: Set<string> = new Set(),
): McapSimOpenSkipReason | null {
  if (openMintSet.has(snapshot.token_address)) return 'already_open'
  if (snapshot.label === 'rugged') return 'rugged'

  const entryFilters = strategy.config.entry
  if (
    entryFilters.organicScoreMin != null &&
    snapshot.organic_score != null &&
    snapshot.organic_score < entryFilters.organicScoreMin
  ) {
    return 'low_organic'
  }
  if (
    entryFilters.topHoldersPctMax != null &&
    snapshot.top_holders_pct != null &&
    snapshot.top_holders_pct >= entryFilters.topHoldersPctMax
  ) {
    return 'high_holders'
  }

  if (strategy.config.entryTemplate === 'first_seen') {
    if (!isWithinRecency(strategy, snapshot.first_seen_at)) {
      return 'first_seen_too_old'
    }
  } else {
    const growth = snapshot.mcap_growth_percent ?? 0
    if (!snapshot.when_reach_80pct && growth < 80) return 'no_milestone'

    if (snapshot.when_reach_80pct) {
      if (!isWithinRecency(strategy, snapshot.when_reach_80pct)) {
        return 'milestone_too_old'
      }
    } else if (!isWithinRecency(strategy, snapshot.first_seen_at)) {
      // Growth ≥ 80 but no milestone stamp and first_seen is stale (e.g. 12h late).
      return 'milestone_too_old'
    }
  }

  const entry = resolveMcapSimEntry(strategy, snapshot)
  const entryMcapForRange = entry?.entryMcap ?? snapshot.first_mcap
  if (
    !entryMcapForRange ||
    entryMcapForRange <= 0 ||
    !isInTrackingRange(entryMcapForRange, strategy.config.entry)
  ) {
    return 'out_of_range'
  }

  if (
    entry &&
    closedOutcomeKeys.has(`${snapshot.token_address}|${entry.entryAt}`)
  ) {
    return 'already_closed'
  }

  return null
}

export function shouldOpenMcapSim(
  strategy: McapTrackerStrategy,
  snapshot: McapSnapshot,
  openMintSet: Set<string>,
  closedOutcomeKeys: Set<string> = new Set(),
): boolean {
  return (
    getMcapSimOpenSkipReason(
      strategy,
      snapshot,
      openMintSet,
      closedOutcomeKeys,
    ) === null
  )
}
