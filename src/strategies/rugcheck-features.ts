/**
 * Pure mapper: RugCheck token report → typed on-chain risk features.
 *
 * RugCheck `GET /v1/tokens/{id}/report` is free/keyless. `score` is a raw weighted
 * sum; `score_normalised` is 0–100 (higher = riskier). An empty `risks[]` means
 * "unknown", NOT clean — callers must not treat it as a bonus.
 *
 * No network here; fixtures cover the mapping.
 */

export type RugcheckFeatures = {
  available: boolean
  score: number | null
  scoreNormalised: number | null
  /** Named risks, e.g. ['Single holder ownership', 'High holder concentration']. */
  riskNames: string[]
  /** Sum of per-risk weights (RugCheck's own points). */
  riskPoints: number
  creator: string | null
  creatorBalance: number | null
  graphInsidersDetected: number | null
  lpLockedPct: number | null
  lockerScanStatus: string | null
  mutableMetadata: boolean | null
  rugged: boolean
  deployPlatform: string | null
  launchpad: string | null
}

export const EMPTY_RUGCHECK_FEATURES: RugcheckFeatures = {
  available: false,
  score: null,
  scoreNormalised: null,
  riskNames: [],
  riskPoints: 0,
  creator: null,
  creatorBalance: null,
  graphInsidersDetected: null,
  lpLockedPct: null,
  lockerScanStatus: null,
  mutableMetadata: null,
  rugged: false,
  deployPlatform: null,
  launchpad: null,
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function readRisks(raw: unknown): { names: string[]; points: number } {
  if (!Array.isArray(raw)) return { names: [], points: 0 }
  const names: string[] = []
  let points = 0
  for (const item of raw) {
    if (!isRecord(item)) continue
    const name = str(item.name)
    if (name) names.push(name)
    points += num(item.score) ?? 0
  }
  return { names, points }
}

/** `lpLockedPct` appears on /report/summary; the full report nests it under `lp`. */
function readLpLockedPct(root: Record<string, unknown>): number | null {
  const top = num(root.lpLockedPct)
  if (top != null) return top
  const lp = root.lp
  if (isRecord(lp)) return num(lp.lpLockedPct)
  return null
}

export function mapRugcheckReport(raw: unknown): RugcheckFeatures {
  if (!isRecord(raw) || typeof raw.mint !== 'string') {
    return { ...EMPTY_RUGCHECK_FEATURES }
  }

  const { names, points } = readRisks(raw.risks)
  const tokenMeta = isRecord(raw.tokenMeta) ? raw.tokenMeta : null
  const launchpad = isRecord(raw.launchpad)
    ? str(raw.launchpad.name)
    : str(raw.launchpad)

  return {
    available: true,
    score: num(raw.score),
    scoreNormalised: num(raw.score_normalised),
    riskNames: names,
    riskPoints: points,
    creator: str(raw.creator),
    creatorBalance: num(raw.creatorBalance),
    graphInsidersDetected: num(raw.graphInsidersDetected),
    lpLockedPct: readLpLockedPct(raw),
    lockerScanStatus: str(raw.lockerScanStatus),
    mutableMetadata: tokenMeta ? bool(tokenMeta.mutable) : null,
    rugged: raw.rugged === true,
    deployPlatform: str(raw.deployPlatform),
    launchpad,
  }
}
