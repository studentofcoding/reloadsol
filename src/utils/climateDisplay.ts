/**
 * Header climate chip mapping (display-only).
 *
 * Binary label is authoritative. Does not apply CLIMATE_GATE policy and must not
 * be used to hard-disable trade controls. Fail-open gate scale (1) is Unknown,
 * never Safe/Hype. `e4_depth` missing does not force Not safe.
 */

import type { ClimateGateResult, ClimateSizeKind, ClimateState } from '@/utils/climateGate'

export const CLIMATE_DISPLAY_STALE_MS = 90_000

export const CLIMATE_CHIP_LABELS = ['Safe', 'Not safe', 'Unknown'] as const
export type ClimateChipLabel = (typeof CLIMATE_CHIP_LABELS)[number]

const SAFE_STATES: ReadonlySet<string> = new Set(['Mixed', 'Range', 'Hype'])
const NOT_SAFE_STATES: ReadonlySet<string> = new Set(['Cash', 'De-risk'])

export type ClimateChipPayload = {
  ok: boolean
  label: ClimateChipLabel
  state?: ClimateState | null
  h?: number | null
  cascadeVeto?: boolean
  sizeKind?: ClimateSizeKind | 'unknown'
  scale?: number
  fetchedAt: number
  stale: boolean
}

export type ClimateChipSource = Pick<
  ClimateGateResult,
  'ok' | 'error' | 'fetchedAt' | 'state' | 'h' | 'cascadeVeto' | 'sizeKind' | 'scale'
> & { computedAt?: number | null }

export function isClimateDisplayStale(opts: {
  now: number
  fetchedAt: number
  computedAt?: number | null
  staleMs?: number
}): boolean {
  const staleMs = opts.staleMs ?? CLIMATE_DISPLAY_STALE_MS
  if (!(staleMs > 0)) return false
  if (opts.now - opts.fetchedAt > staleMs) return true
  if (opts.computedAt != null && opts.now - opts.computedAt > staleMs) return true
  return false
}

/**
 * Map interpretClimate / fetchClimate fields → binary chip label.
 *
 * Not safe = cascade.veto OR state in {Cash, De-risk}
 * Safe = state in {Mixed, Range, Hype} AND no cascade veto
 * Unknown = !ok, error, stale, or unmapped state
 */
export function climateChipLabel(input: {
  ok: boolean
  error?: string
  stale: boolean
  cascadeVeto: boolean
  state: ClimateState | string | null
}): ClimateChipLabel {
  if (!input.ok || input.error || input.stale) return 'Unknown'
  if (input.cascadeVeto) return 'Not safe'
  if (input.state && NOT_SAFE_STATES.has(input.state)) return 'Not safe'
  if (input.state && SAFE_STATES.has(input.state)) return 'Safe'
  return 'Unknown'
}

/** Regime Hurst-like H for chips: `H 0.5` (one decimal). */
export function formatClimateH(
  h: number | null | undefined,
  digits = 1,
): string | null {
  if (typeof h !== 'number' || !Number.isFinite(h)) return null
  return `H ${h.toFixed(digits)}`
}

/** Detail under the binary label, e.g. `De-risk · H 0.5`. Same for Safe/Unknown. */
export function formatClimateRegimeDetail(opts: {
  state?: string | null
  h?: number | null
  digits?: number
}): string | null {
  const hLabel = formatClimateH(opts.h, opts.digits ?? 1)
  const state = typeof opts.state === 'string' && opts.state.trim() ? opts.state.trim() : null
  const parts = [state, hLabel].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : null
}

export function toClimateChipPayload(
  gate: ClimateChipSource,
  opts: { now?: number; staleMs?: number } = {},
): ClimateChipPayload {
  const now = opts.now ?? Date.now()
  const stale = isClimateDisplayStale({
    now,
    fetchedAt: gate.fetchedAt,
    computedAt: gate.computedAt,
    staleMs: opts.staleMs,
  })
  const label = climateChipLabel({
    ok: gate.ok,
    error: gate.error,
    stale,
    cascadeVeto: gate.cascadeVeto,
    state: gate.state,
  })
  return {
    ok: gate.ok,
    label,
    state: gate.state ?? undefined,
    h: gate.h ?? undefined,
    cascadeVeto: gate.cascadeVeto,
    sizeKind: gate.sizeKind,
    scale: gate.scale,
    fetchedAt: gate.fetchedAt,
    stale,
  }
}
