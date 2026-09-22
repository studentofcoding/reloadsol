/** Display + list-filter helpers for token_mcap_tracking.label. No I/O. */

export const TRACKER_LIST_LABELS = [
  'all',
  'potential',
  'rugged',
  'watching',
  'traded_live',
  'valid',
  'unlabeled',
] as const

export type TrackerListLabel = (typeof TRACKER_LIST_LABELS)[number]

export const TRACKER_LABEL_CHIPS: { id: TrackerListLabel; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'potential', label: 'Potential' },
  { id: 'rugged', label: 'Rug' },
  { id: 'watching', label: 'Watching' },
  { id: 'traded_live', label: 'Traded live' },
  { id: 'valid', label: 'Valid' },
  { id: 'unlabeled', label: 'Unlabeled' },
]

const STORED_LABELS = [
  'potential',
  'rugged',
  'watching',
  'traded_live',
  'valid',
] as const

export function normalizeTrackerListLabel(
  raw: string | null | undefined,
): TrackerListLabel {
  if (raw && (TRACKER_LIST_LABELS as readonly string[]).includes(raw)) {
    return raw as TrackerListLabel
  }
  return 'all'
}

/**
 * SQL fragment for GET /api/mcap-tracking?action=list.
 * `rug` is not a tracker value — callers map `{ error }` to HTTP 400.
 */
export function mcapLabelFilterSql(
  raw: string | null | undefined,
  nextIndex: number,
): { error: string } | { sql: string; values: unknown[] } {
  if (raw == null || raw.trim() === '' || raw === 'all') {
    return { sql: '', values: [] }
  }
  if (raw === 'unlabeled') {
    return { sql: 'label IS NULL', values: [] }
  }
  if ((STORED_LABELS as readonly string[]).includes(raw)) {
    return { sql: `label = $${nextIndex}`, values: [raw] }
  }
  return {
    error:
      'Invalid label filter. Must be one of: potential, rugged, watching, traded_live, valid, unlabeled',
  }
}

/** Card / chip copy. Null when the row has no tracker label. */
export function trackerLabelDisplay(
  label: string | null | undefined,
): string | null {
  if (label === 'rugged') return 'Rug'
  if (label === 'potential') return 'Potential'
  if (label === 'watching') return 'Watching'
  if (label === 'traded_live') return 'Traded live'
  if (label === 'valid') return 'Valid'
  return null
}

export function isTrackedMcapPresence(row: {
  source: string
  strategyId?: string | null
}): boolean {
  return row.source === 'token_mcap_tracking' && !row.strategyId
}

export function strategyPresenceTitle(row: {
  source: string
  strategyId?: string | null
  strategyName?: string | null
}): string {
  if (isTrackedMcapPresence(row)) return 'Tracked'
  return row.strategyName ?? row.strategyId ?? row.source
}

/** Algo Tester open desk for a tracking-only mint. Not a strategy open. */
export function mcapTrackedAlgoTesterHref(
  mint: string,
  chain?: string | null,
): string {
  const q = new URLSearchParams({
    tab: 'open',
    domain: 'mcap_tracker',
    tokenAddress: mint,
  })
  if (chain) q.set('chain', chain)
  return `/dev/algo-tester?${q.toString()}`
}
