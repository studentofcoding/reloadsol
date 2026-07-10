export type EntryMcapBand =
  | 'under50k'
  | '51-100k'
  | '101-200k'
  | '201-500k'
  | '501k-1M'
  | 'over1M'

export const ENTRY_MCAP_BAND_OPTIONS: { id: EntryMcapBand; label: string }[] = [
  { id: 'under50k', label: 'Under $50K' },
  { id: '51-100k', label: '$51–100K' },
  { id: '101-200k', label: '$101–200K' },
  { id: '201-500k', label: '$201–500K' },
  { id: '501k-1M', label: '$501K–1M' },
  { id: 'over1M', label: 'Over $1M' },
]

export function computeEntryMcapBand(mcap: number | null | undefined): EntryMcapBand | null {
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) return null
  if (mcap < 50_000) return 'under50k'
  if (mcap <= 100_000) return '51-100k'
  if (mcap <= 200_000) return '101-200k'
  if (mcap <= 500_000) return '201-500k'
  if (mcap <= 1_000_000) return '501k-1M'
  return 'over1M'
}

export function formatEntryMcap(mcap: number | null | undefined): string {
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) return '—'
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`
  if (mcap >= 1_000) return `$${Math.round(mcap / 1_000)}K`
  return `$${Math.round(mcap)}`
}

export function readEntryMcap(features: Record<string, unknown> | null | undefined): number | null {
  const v = features?.entry_mcap ?? features?.entry_market_cap ?? features?.first_mcap
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function readTokenSymbol(
  features: Record<string, unknown> | null | undefined,
  fallback?: string | null,
): string | null {
  const v = features?.token_symbol
  if (typeof v === 'string' && v.trim()) return v.trim()
  return fallback ?? null
}

export function buildEntryMcapFeatures(mcap: number | null | undefined): Record<string, unknown> {
  if (mcap == null || !Number.isFinite(mcap) || mcap <= 0) return {}
  const band = computeEntryMcapBand(mcap)
  return {
    entry_mcap: mcap,
    ...(band ? { entry_mcap_band: band } : {}),
  }
}

function readFeatureNumber(
  features: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const v = features?.[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function readOrganicScore(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'organic_score')
}

export function readTopHoldersPct(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'top_holders_pct')
}

export function readTokenAgeHours(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'token_age_hours')
}

export function readVolumeAtEntry(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return (
    readFeatureNumber(features, 'volume_at_entry') ??
    readFeatureNumber(features, 'volume_5m')
  )
}

export function readFirstSeenAt(
  features: Record<string, unknown> | null | undefined,
): string | null {
  const v = features?.first_seen_at
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

export function readTrainingClass(
  features: Record<string, unknown> | null | undefined,
): number | null {
  const v = features?.training_class
  if (v === 0 || v === 1 || v === 2 || v === 3 || v === 4) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (n === 0 || n === 1 || n === 2 || n === 3 || n === 4) return n
  }
  return null
}

export function isLabeledTrainingClass(
  value: number | null | undefined,
): value is 0 | 1 | 2 | 3 | 4 {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4
}

export function readMonitorSnapshotCount(
  features: Record<string, unknown> | null | undefined,
): number {
  const raw = features?.monitor_snapshots
  return Array.isArray(raw) ? raw.length : 0
}

export function readMlPatternPWinner(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_pattern_p_winner')
}

export function readMlPatternPredicted(
  features: Record<string, unknown> | null | undefined,
): 'winner' | 'loser' | null {
  const v = features?.ml_pattern_predicted
  if (v === 'winner' || v === 'loser') return v
  return null
}

export function readMlGatePBad(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_gate_p_bad')
}

export function readMlGatePredicted(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_gate_predicted')
}

export function readMlPotentialTier(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_potential_tier')
}

export function readMlPotentialMoonScore(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_potential_moon_score')
}

export function readMlExitBaseTp(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_exit_base_take_profit_pct')
}

export function readMlExitBaseSl(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_exit_base_stop_loss_pct')
}

export function readMlExitBaseHold(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_exit_base_max_hold_hours')
}

export function readMlExitEffectiveTp(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_exit_effective_take_profit_pct')
}

export function readMlExitEffectiveSl(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_exit_effective_stop_loss_pct')
}

export function readMlExitEffectiveHold(
  features: Record<string, unknown> | null | undefined,
): number | null {
  return readFeatureNumber(features, 'ml_exit_effective_max_hold_hours')
}

export function readMlExitOverlayMode(
  features: Record<string, unknown> | null | undefined,
): 'off' | 'shadow' | 'apply' | null {
  const v = features?.ml_exit_overlay_mode
  if (v === 'off' || v === 'shadow' || v === 'apply') return v
  return null
}

export function readMlExitOverlayApplied(
  features: Record<string, unknown> | null | undefined,
): boolean {
  return features?.ml_exit_overlay_applied === true
}

/** Compact TP/SL overlay summary for badges (null when no overlay stamped). */
export function formatMlExitOverlaySummary(
  features: Record<string, unknown> | null | undefined,
): string | null {
  const baseTp = readMlExitBaseTp(features)
  const effTp = readMlExitEffectiveTp(features)
  const baseSl = readMlExitBaseSl(features)
  const effSl = readMlExitEffectiveSl(features)
  if (baseTp == null || effTp == null || baseSl == null || effSl == null) return null
  const mode = readMlExitOverlayMode(features)
  const applied = readMlExitOverlayApplied(features)
  const suffix =
    applied && mode === 'apply' ? ' apply' : mode === 'shadow' ? ' shadow' : mode ? ` ${mode}` : ''
  return `TP ${baseTp}→${effTp} · SL ${baseSl}→${effSl}${suffix}`
}
