/**
 * Header climate chip presentation only. Binary mapping stays in climateDisplay
 * (`Safe` / `Not safe` / `Unknown`). This module must not import climateGate.
 */

export type ClimateChipLabel = 'Safe' | 'Not safe' | 'Unknown'

export const CLIMATE_CHIP_HEADLINES: Record<ClimateChipLabel, string> = {
  'Not safe': 'Caution',
  Safe: 'Regime OK',
  Unknown: 'Regime …',
}

export function climateChipHeadline(label: ClimateChipLabel): string {
  return CLIMATE_CHIP_HEADLINES[label]
}

export function climateChipTip(opts: {
  label: ClimateChipLabel
  state?: string | null
  cascadeVeto?: boolean
}): string {
  if (opts.label === 'Not safe') {
    const why = opts.cascadeVeto
      ? 'cascade risk — cut exposure'
      : opts.state
        ? `${opts.state} — cut exposure`
        : 'cut exposure / cascade risk'
    return `Caution: regime says ${why}. Trading is still allowed.`
  }
  if (opts.label === 'Unknown') {
    return 'Regime unavailable (fetch failed or stale).'
  }
  const state = opts.state ? ` (${opts.state})` : ''
  return `Regime OK${state}.`
}

/** Subtitle under the headline. Unknown stays empty so it does not look like a warning. */
export function climateChipSubtitle(opts: {
  label: ClimateChipLabel
  state?: string | null
  h?: number | null
}): string | null {
  if (opts.label === 'Unknown') return null
  const hLabel =
    typeof opts.h === 'number' && Number.isFinite(opts.h)
      ? `H ${opts.h.toFixed(2)}`
      : null
  if (opts.label === 'Safe') {
    return opts.state ?? null
  }
  const parts = [opts.state, hLabel].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
