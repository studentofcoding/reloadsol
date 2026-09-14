/**
 * Header climate chip presentation only. Binary mapping stays in climateDisplay
 * (`Safe` / `Not safe` / `Unknown`). This module must not import climateGate.
 */

export type ClimateChipLabel = 'Safe' | 'Not safe' | 'Unknown'

export const NOT_SAFE_CHIP_TEXT = 'Beware: The current market is very risky'
export const NOT_SAFE_CHIP_TEXT_COMPACT = 'Beware'

export const CLIMATE_CHIP_HEADLINES: Record<ClimateChipLabel, string> = {
  'Not safe': NOT_SAFE_CHIP_TEXT,
  Safe: 'Regime OK',
  Unknown: 'Regime …',
}

export function climateChipHeadline(
  label: ClimateChipLabel,
  variant: 'full' | 'compact' = 'full',
): string {
  if (label === 'Not safe') {
    return variant === 'compact' ? NOT_SAFE_CHIP_TEXT_COMPACT : NOT_SAFE_CHIP_TEXT
  }
  return CLIMATE_CHIP_HEADLINES[label]
}

function formatH(h: number | null | undefined): string | null {
  if (typeof h !== 'number' || !Number.isFinite(h)) return null
  return `H ${h.toFixed(2)}`
}

export function climateChipTip(opts: {
  label: ClimateChipLabel
  state?: string | null
  h?: number | null
  cascadeVeto?: boolean
  sizeKind?: string | null
  scale?: number | null
  reason?: string | null
}): string {
  if (opts.label === 'Not safe') {
    const details: string[] = []
    if (opts.state) details.push(opts.state)
    const hLabel = formatH(opts.h)
    if (hLabel) details.push(hLabel)
    if (opts.cascadeVeto) details.push('cascade veto')
    if (opts.sizeKind && opts.sizeKind !== 'unknown') {
      const scale =
        typeof opts.scale === 'number' && Number.isFinite(opts.scale)
          ? ` ${opts.scale}`
          : ''
      details.push(`${opts.sizeKind}${scale}`.trim())
    }
    const reason = opts.reason?.trim()
    const detailStr = details.length ? ` ${details.join(' · ')}.` : ''
    const reasonStr = reason ? ` ${reason}.` : ''
    return `${NOT_SAFE_CHIP_TEXT}.${detailStr}${reasonStr} Trading is still allowed.`
  }
  if (opts.label === 'Unknown') {
    return 'Regime unavailable (fetch failed or stale).'
  }
  const state = opts.state ? ` (${opts.state})` : ''
  return `Regime OK${state}.`
}

/**
 * Subtitle under the headline. Not safe and Unknown stay empty so De-risk/H
 * live in the tooltip only for the caution state.
 */
export function climateChipSubtitle(opts: {
  label: ClimateChipLabel
  state?: string | null
  h?: number | null
}): string | null {
  if (opts.label !== 'Safe') return null
  return opts.state ?? null
}
