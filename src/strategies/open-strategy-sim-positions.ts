import { computeOpenSimCycle, scopeRecordsToStrategy } from '@/utils/simulation-trades'
import type { TrackingRecord } from '@/utils/trading-tracker'
import {
  readEffectiveExit,
  type McapEffectiveExit,
} from '@/utils/mcap-sim-track'
import { computeMcapSimPnlPct } from '@/utils/mcap-tracker'
import { readMonitorSnapshotsFromFeatures } from './entry-feature-snapshot'

export type StrategySimOpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryPriceUsd: number
  entryFeatures: Record<string, unknown>
  effectiveExit: McapEffectiveExit | null
}

/**
 * Open strategy sim cycles for a wallet filtered by bot_strategy.
 *
 * The cycle is computed over THIS strategy's records only. A wallet-wide cycle nets every strategy's
 * buys and sells for the mint, so a sibling's close zeroed this strategy's cycle (its position read
 * as closed and dropped out of the open count) and, symmetrically, this strategy's open count
 * included tokens another strategy bought. Same rule as `getOpenMcapPositions`.
 */
export function getOpenStrategySimPositions(
  records: TrackingRecord[],
  strategyId: string,
): StrategySimOpenPosition[] {
  const seen = new Set<string>()
  const open: StrategySimOpenPosition[] = []
  const scoped = scopeRecordsToStrategy(records, strategyId)

  for (const r of scoped) {
    if (!r.is_simulation) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenSimCycle(scoped, t.mintAddress)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      seen.add(t.mintAddress)

      const buyRecord = scoped.find(
        (rec) =>
          rec.operationType === 'buy' &&
          rec.bot_strategy === strategyId &&
          rec.is_simulation &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      const sim = (buyRecord?.trading_simulation ?? {}) as Record<string, unknown>
      const entryFeatures =
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {}
      const entryPriceUsd =
        finite(sim.entry_price_usd) ??
        finite(entryFeatures.initial_price_usd) ??
        cycle.weightedBuyPriceUsd ??
        0

      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol || t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryPriceUsd,
        entryFeatures,
        effectiveExit: readEffectiveExit(sim),
      })
    }
  }

  return open
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export type PriceSimExitConfig = {
  stopLossPct: number
  takeProfitPct: number
  maxHoldHours: number
}

export type PriceSimExitDecision = {
  close: boolean
  reason: 'missing_price' | 'stop_loss' | 'take_profit' | 'max_hold' | 'hold' | 'trailing_moonbag'
  pnlPct: number | null
}

/** Moonbag trailing knobs. Off when armPct <= 0. Env-tunable. */
export type MoonbagExitConfig = {
  armPct: number
  trailPct: number
  maxHoldHours: number
}

export function moonbagExitConfig(
  env: Record<string, string | undefined> = process.env,
): MoonbagExitConfig {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    armPct: num(env.SOCIAL_MOONBAG_ARM_PCT, 60),
    trailPct: num(env.SOCIAL_MOONBAG_TRAIL_PCT, 35),
    maxHoldHours: num(env.SOCIAL_MOONBAG_MAX_HOLD_H, 72),
  }
}

/** Price-based gain %, null when either price is unusable. */
export function priceGainPct(
  entryPriceUsd: number,
  currentPriceUsd: number | null | undefined,
): number | null {
  if (!(entryPriceUsd > 0)) return null
  if (currentPriceUsd == null || !Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) {
    return null
  }
  return ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
}

/**
 * Best gain since entry, from the position's own monitor_snapshots (already
 * sampled every manage tick). Null when there is nothing usable yet.
 */
export function peakGainPctFromFeatures(
  entryPriceUsd: number,
  entryFeatures: Record<string, unknown> | null | undefined,
): number | null {
  if (!(entryPriceUsd > 0)) return null
  let peak: number | null = null
  for (const snap of readMonitorSnapshotsFromFeatures(entryFeatures)) {
    const gain = priceGainPct(entryPriceUsd, snap.price_usd)
    if (gain == null) continue
    if (peak == null || gain > peak) peak = gain
  }
  return peak
}

/**
 * Peak trailing "moonbag" exit: once the best gain reaches `armPct`, ride the
 * peak and close on a `trailPct` retrace instead of the fixed TP; below the arm
 * the normal TP/SL applies unchanged. SL always wins first.
 */
export function decideMoonbagTrailingExit(params: {
  exit: PriceSimExitConfig
  gainPct: number
  peakGainPct: number | null
  heldHours: number
  armPct: number
  trailPct: number
}): PriceSimExitDecision {
  const { exit, gainPct, heldHours, armPct, trailPct } = params
  if (gainPct <= exit.stopLossPct) {
    return { close: true, reason: 'stop_loss', pnlPct: gainPct }
  }

  const peak = Math.max(params.peakGainPct ?? gainPct, gainPct)
  if (armPct > 0) {
    // Moonbag mode owns the exit: no fixed TP, the peak retrace decides.
    if (peak >= armPct && gainPct <= peak * (1 - trailPct / 100)) {
      return { close: true, reason: 'trailing_moonbag', pnlPct: gainPct }
    }
  } else if (gainPct >= exit.takeProfitPct) {
    return { close: true, reason: 'take_profit', pnlPct: gainPct }
  }

  if (exit.maxHoldHours > 0 && heldHours >= exit.maxHoldHours) {
    return { close: true, reason: 'max_hold', pnlPct: gainPct }
  }
  return { close: false, reason: 'hold', pnlPct: gainPct }
}

/** Shared SL / TP / max-hold exit for price-based paper domains (gmgn, social, …). */
export function shouldClosePriceSimPosition(params: {
  entryPriceUsd: number
  currentPriceUsd: number
  entryAt: string | null
  exit: PriceSimExitConfig
  nowMs?: number
}): PriceSimExitDecision {
  const { entryPriceUsd, currentPriceUsd, entryAt, exit } = params
  if (entryPriceUsd <= 0 || currentPriceUsd <= 0) {
    return { close: false, reason: 'missing_price', pnlPct: null }
  }
  const pnlPct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
  if (pnlPct <= exit.stopLossPct) return { close: true, reason: 'stop_loss', pnlPct }
  if (pnlPct >= exit.takeProfitPct) return { close: true, reason: 'take_profit', pnlPct }
  if (entryAt && exit.maxHoldHours > 0) {
    const heldMs = (params.nowMs ?? Date.now()) - new Date(entryAt).getTime()
    if (heldMs >= exit.maxHoldHours * 60 * 60 * 1000) {
      return { close: true, reason: 'max_hold', pnlPct }
    }
  }
  return { close: false, reason: 'hold', pnlPct }
}

/**
 * Target machine signals resolve: prefer mcap growth vs entry_mcap, else price PnL.
 */
export function shouldCloseSignalsClExit(params: {
  exit: PriceSimExitConfig
  entryAt: string | null
  entryMcap: number | null
  currentMcap: number | null
  entryPriceUsd: number
  currentPriceUsd: number | null
  nowMs?: number
}): PriceSimExitDecision {
  const { exit, entryAt } = params
  const entryMcap =
    params.entryMcap != null &&
    Number.isFinite(params.entryMcap) &&
    params.entryMcap > 0
      ? params.entryMcap
      : null
  const currentMcap =
    params.currentMcap != null &&
    Number.isFinite(params.currentMcap) &&
    params.currentMcap > 0
      ? params.currentMcap
      : null

  if (entryMcap != null && currentMcap != null) {
    const growth = computeMcapSimPnlPct(entryMcap, currentMcap)
    if (growth <= exit.stopLossPct) {
      return { close: true, reason: 'stop_loss', pnlPct: growth }
    }
    if (growth >= exit.takeProfitPct) {
      return { close: true, reason: 'take_profit', pnlPct: growth }
    }
    if (entryAt && exit.maxHoldHours > 0) {
      const heldMs = (params.nowMs ?? Date.now()) - new Date(entryAt).getTime()
      if (heldMs >= exit.maxHoldHours * 60 * 60 * 1000) {
        return { close: true, reason: 'max_hold', pnlPct: growth }
      }
    }
    return { close: false, reason: 'hold', pnlPct: growth }
  }

  return shouldClosePriceSimPosition({
    entryPriceUsd: params.entryPriceUsd,
    currentPriceUsd: params.currentPriceUsd ?? 0,
    entryAt,
    exit,
    nowMs: params.nowMs,
  })
}
