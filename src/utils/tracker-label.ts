/**
 * Display + list-filter helpers for token_mcap_tracking.label. No I/O.
 *
 * The kanban tag for peak growth is `rising`. `potential` is the previous
 * stored string (one release): reads treat it as rising; writes store rising.
 * Not the ML `v2-potential` model, detect-snapshot `rug_label`, or
 * `dlmm_potential_list` membership.
 */

export const TRACKER_WRITE_LABELS = [
  'valid',
  'traded_live',
  'rising',
  'rugged',
  'watching',
] as const

export type TrackerWriteLabel = (typeof TRACKER_WRITE_LABELS)[number]

/** Previous kanban string. Read alias only — do not write it. */
export const LEGACY_RISING_LABEL = 'potential'

export const TRACKER_LIST_LABELS = [
  'all',
  'rising',
  'rugged',
  'watching',
  'traded_live',
  'valid',
  'unlabeled',
] as const

export type TrackerListLabel = (typeof TRACKER_LIST_LABELS)[number]

export const TRACKER_LABEL_CHIPS: { id: TrackerListLabel; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'rising', label: 'Rising' },
  { id: 'rugged', label: 'Rug' },
  { id: 'watching', label: 'Watching' },
  { id: 'traded_live', label: 'Traded live' },
  { id: 'valid', label: 'Valid' },
  { id: 'unlabeled', label: 'Unlabeled' },
]

const STORED_LABELS = [
  'rising',
  'rugged',
  'watching',
  'traded_live',
  'valid',
] as const

/** Map the legacy kanban string onto `rising`. Other values pass through. */
export function canonicalTrackerLabel(
  label: string | null | undefined,
): string | null | undefined {
  if (label === LEGACY_RISING_LABEL) return 'rising'
  return label
}

export function isRisingTrackerLabel(
  label: string | null | undefined,
): boolean {
  return label === 'rising' || label === LEGACY_RISING_LABEL
}

/**
 * Accept a write. Legacy `potential` is stored as `rising`.
 * `null` clears the label.
 */
export function coerceTrackerLabelWrite(
  label: string | null | undefined,
): { ok: true; label: TrackerWriteLabel | null } | { ok: false } {
  if (label == null) return { ok: true, label: null }
  if (label === LEGACY_RISING_LABEL) return { ok: true, label: 'rising' }
  if ((TRACKER_WRITE_LABELS as readonly string[]).includes(label)) {
    return { ok: true, label: label as TrackerWriteLabel }
  }
  return { ok: false }
}

export function normalizeTrackerListLabel(
  raw: string | null | undefined,
): TrackerListLabel {
  const canon = canonicalTrackerLabel(raw)
  if (canon && (TRACKER_LIST_LABELS as readonly string[]).includes(canon)) {
    return canon as TrackerListLabel
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
  if (raw === 'rising' || raw === LEGACY_RISING_LABEL) {
    return {
      sql: `(label = 'rising' OR label = 'potential')`,
      values: [],
    }
  }
  if ((STORED_LABELS as readonly string[]).includes(raw)) {
    return { sql: `label = $${nextIndex}`, values: [raw] }
  }
  return {
    error:
      'Invalid label filter. Must be one of: rising, rugged, watching, traded_live, valid, unlabeled',
  }
}

/** Card / chip copy. Null when the row has no tracker label. */
export function trackerLabelDisplay(
  label: string | null | undefined,
): string | null {
  if (label === 'rugged') return 'Rug'
  if (isRisingTrackerLabel(label)) return 'Rising'
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
