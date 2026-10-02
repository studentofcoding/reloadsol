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
  /** Sum of `lockers[].usdcLocked` — locked liquidity in USD. */
  lpLockedUsd: number | null
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
  lpLockedUsd: null,
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

/**
 * LP-locked percent. The full `/report` carries no top-level `lpLockedPct` (and
 * no top-level `lp`) — the value is **per market** at `markets[].lp.lpLockedPct`,
 * so take the max across markets (verified live: 0 for a DLMM, 97.06 for the
 * raydium_cpmm of the same token). `/report/summary` has an aggregate but is a
 * second call, kept as the last fallback.
 */
function readLpLockedPct(root: Record<string, unknown>): number | null {
  const top = num(root.lpLockedPct)
  if (top != null) return top
  const lp = root.lp
  if (isRecord(lp)) {
    const nested = num(lp.lpLockedPct)
    if (nested != null) return nested
  }
  const markets = root.markets
  if (Array.isArray(markets)) {
    let best: number | null = null
    for (const market of markets) {
      if (!isRecord(market) || !isRecord(market.lp)) continue
      const pct = num((market.lp as Record<string, unknown>).lpLockedPct)
      if (pct == null) continue
      if (best == null || pct > best) best = pct
    }
    if (best != null) return best
  }
  return null
}

/** Locked liquidity in USD, summed over `lockers[].usdcLocked`. */
function readLpLockedUsd(root: Record<string, unknown>): number | null {
  const lockers = root.lockers
  if (!isRecord(lockers)) return null
  let sum = 0
  let seen = false
  for (const locker of Object.values(lockers)) {
    if (!isRecord(locker)) continue
    const usd = num(locker.usdcLocked)
    if (usd == null) continue
    sum += usd
    seen = true
  }
  return seen ? sum : null
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
    lpLockedUsd: readLpLockedUsd(raw),
    lockerScanStatus: str(raw.lockerScanStatus),
    mutableMetadata: tokenMeta ? bool(tokenMeta.mutable) : null,
    rugged: raw.rugged === true,
    deployPlatform: str(raw.deployPlatform),
    launchpad,
  }
}
