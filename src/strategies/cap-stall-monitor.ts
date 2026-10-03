import type { TrackingRecord } from '@/utils/trading-tracker'
import { log } from '@/utils/unified-logger'

/**
 * "Active strategy at its position cap and not opening" detector.
 *
 * The open loop `break`s when `currentOpen + opened >= maxOpenPositions`, and the only trace was a
 * `skipped[]` string in one HTTP response. Five mcap strategies sat at the cap for ~2 days (ledger
 * orphans counted as open) and nothing said so. This turns that into a structured warning.
 *
 * No table, no migration. The "no opens for N hours" half is derived from the ledger the caller
 * already holds (the strategy's latest sim buy), so it survives restarts; the "repeatedly" half is a
 * per-process consecutive-pass counter, and the counters are exposed for whoever scrapes them.
 */

export type CapStallState = {
  /** Consecutive open passes on which this strategy hit its cap. */
  consecutiveCapPasses: number
  lastWarnAtMs: number
}

const state = new Map<string, CapStallState>()

const counters = {
  capPasses: 0,
  stallWarnings: 0,
}

export function capStallCounters(): Readonly<typeof counters> {
  return { ...counters }
}

export function resetCapStallForTests(): void {
  state.clear()
  counters.capPasses = 0
  counters.stallWarnings = 0
}

function envNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Hours with no new open before an at-cap strategy is reported. Env `CAP_STALL_WARN_HOURS`, default 6. */
export function capStallWarnHours(env: Record<string, string | undefined> = process.env): number {
  return envNumber(env.CAP_STALL_WARN_HOURS, 6)
}

/** Capped passes in a row before it is reported. Env `CAP_STALL_MIN_PASSES`, default 3. */
export function capStallMinPasses(env: Record<string, string | undefined> = process.env): number {
  return envNumber(env.CAP_STALL_MIN_PASSES, 3)
}

/** Min gap between repeated warnings for one strategy. Env `CAP_STALL_WARN_EVERY_MIN`, default 30. */
function warnEveryMs(env: Record<string, string | undefined> = process.env): number {
  return envNumber(env.CAP_STALL_WARN_EVERY_MIN, 30) * 60_000
}

/** Timestamp (ms) of the strategy's most recent simulated buy in `records`, or null. */
export function lastSimBuyAtMs(records: TrackingRecord[], strategyId: string): number | null {
  let last: number | null = null
  for (const r of records) {
    if (r.operationType !== 'buy' || !r.is_simulation || r.bot_strategy !== strategyId) continue
    if (typeof r.timestamp === 'number' && (last == null || r.timestamp > last)) last = r.timestamp
  }
  return last
}

/**
 * Call once per strategy per open pass.
 * @returns true when a stall warning was emitted.
 */
export function noteCapPass(params: {
  strategyId: string
  chain: string
  /** True when the pass `break`-ed on the max-positions check. */
  hitCap: boolean
  /** Positions opened by this pass. */
  opened: number
  openCount: number
  maxOpen: number
  /** Latest sim buy in the ledger (see `lastSimBuyAtMs`); null when none. */
  lastBuyAtMs: number | null
  nowMs?: number
  env?: Record<string, string | undefined>
}): boolean {
  const now = params.nowMs ?? Date.now()
  const key = `${params.chain}:${params.strategyId}`
  const st = state.get(key) ?? { consecutiveCapPasses: 0, lastWarnAtMs: 0 }

  if (!params.hitCap || params.opened > 0) {
    st.consecutiveCapPasses = 0
    state.set(key, st)
    return false
  }

  st.consecutiveCapPasses += 1
  counters.capPasses += 1
  state.set(key, st)

  const env = params.env ?? process.env
  const hoursSinceLastOpen =
    params.lastBuyAtMs == null ? null : (now - params.lastBuyAtMs) / 3_600_000
  const stalled = hoursSinceLastOpen == null || hoursSinceLastOpen >= capStallWarnHours(env)
  if (!stalled || st.consecutiveCapPasses < capStallMinPasses(env)) return false
  if (now - st.lastWarnAtMs < warnEveryMs(env)) return false

  st.lastWarnAtMs = now
  counters.stallWarnings += 1
  log.warn('mcap_tracker', 'Active strategy at position cap with no opens — possible ledger orphans', {
    event: 'strategy_at_cap_no_opens',
    strategyId: params.strategyId,
    chain: params.chain,
    openCount: params.openCount,
    maxOpen: params.maxOpen,
    consecutiveCapPasses: st.consecutiveCapPasses,
    hoursSinceLastOpen: hoursSinceLastOpen == null ? null : Math.round(hoursSinceLastOpen * 10) / 10,
    thresholdHours: capStallWarnHours(env),
    counters: { ...counters },
  })
  return true
}
