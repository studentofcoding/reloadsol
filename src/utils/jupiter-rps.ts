/**
 * Jupiter rate control: a token bucket with priority lanes.
 *
 * The measured constraint on prod (account key, while the app's own traffic shared it):
 *
 *   paced 0.5 rps — 10/10 ok, p50 260ms      paced 0.4 / 0.3 rps — clean
 *   burst ~6 rps sequential — 8 ok, then 429
 *   concurrency 4 / 8 / 12 — 0 ok, 100% 429
 *
 * The quota is therefore **burst-shaped**: the sustained rate must stay near 0.5 rps, but a short
 * burst is tolerated. Fixed 2s spacing (1000 / 0.5) ignored that and cost every caller 2s per queued
 * request. Measured before this change: one idle quote 0.210s, but three concurrent callers took
 * 2.01s / 4.00s / 5.98s, and a single `/order?taker=` prepare took 1.76s because it queued behind
 * background price lookups. A trade needs a prepare plus `/execute`, so it was paying ~5-6s.
 *
 * So: one bucket, refilled at `JUPITER_MAX_RPS`, capacity `JUPITER_BURST`.
 * - **trade** lane (a taker-scoped prepare, and `/execute`) may draw the whole bucket.
 * - **background** lane (price lookups, sim sampling, UI quotes) yields whenever trade work is
 *   waiting, and never dips into the `JUPITER_TRADE_RESERVE` tokens — that reserve is what keeps a
 *   trade off the queue entirely.
 */

export type JupiterLane = 'trade' | 'background'

export type JupiterGateConfig = {
  /** Sustained rate. Refill rate of the bucket. */
  rps: number
  /** Bucket size — how many requests may go out back-to-back after an idle period. */
  capacity: number
  /** Tokens background callers may never spend, held for the trade lane. */
  tradeReserve: number
}

export type JupiterGateState = {
  tokens: number
  updatedAt: number
  /** Trade callers currently blocked on the gate; background yields while this is non-zero. */
  tradeWaiting: number
}

/**
 * Sustained ceiling. The measured-clean rate, not a hopeful one: a missing env var must not
 * reintroduce bursts, and any concurrent fan-out to Jupiter is a bug rather than a tuning problem.
 */
export function resolveJupiterMaxRps(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.JUPITER_MAX_RPS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.5
}

/** Bucket size. Bounded well inside the ~8 sequential burst that was measured to succeed. */
export function resolveJupiterBurstCapacity(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.JUPITER_BURST)
  // 5. History: 4 made a 5-token bulk batch dribble out the rest at 2s each (measured 0.23 / 0.39 / 2.17 /
  // 4.23 / 6.00s); 8 followed the measured "~6 rps sequential — 8 ok, then 429" tolerance. But the Free plan
  // window is ~10 requests / 10 s (docs/JUPITER_API_MAP.md), and an 8-deep burst plus the 0.5 rps refill can
  // exceed it, which produced the price-V3 429 storms. 5 still fits a typical 5-token bulk batch in one
  // burst while leaving headroom under the window. Override with JUPITER_BURST.
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 5
}

/** Tokens held back for the trade lane; never the whole bucket. */
export function resolveJupiterTradeReserve(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.JUPITER_TRADE_RESERVE)
  const requested = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 2
  return Math.min(requested, resolveJupiterBurstCapacity(env) - 1)
}

export function createJupiterGate(
  env: Record<string, string | undefined> = process.env,
): JupiterGateConfig {
  return {
    rps: resolveJupiterMaxRps(env),
    capacity: resolveJupiterBurstCapacity(env),
    tradeReserve: resolveJupiterTradeReserve(env),
  }
}

/** Refill the bucket for the time that has passed. Mutates `state`. */
export function refillJupiterTokens(
  state: JupiterGateState,
  nowMs: number,
  cfg: JupiterGateConfig,
): void {
  const elapsed = nowMs - state.updatedAt
  if (elapsed <= 0) return
  const gained = (elapsed / 1000) * cfg.rps
  state.tokens = Math.min(cfg.capacity, state.tokens + gained)
  state.updatedAt = nowMs
}

/**
 * May this caller proceed, and if not, how long until it may? Pure — decides without mutating, so
 * the lane policy is testable without timers.
 */
export function canTakeJupiterToken(
  state: JupiterGateState,
  lane: JupiterLane,
  cfg: JupiterGateConfig,
): { ok: boolean; waitMs: number } {
  const waitForRefill = () =>
    state.tokens >= 1 ? 0 : Math.ceil(((1 - state.tokens) / cfg.rps) * 1000)

  if (lane === 'trade') {
    return { ok: state.tokens >= 1, waitMs: waitForRefill() }
  }

  // Background yields to a waiting trade, and must leave the reserve intact: taking a token is only
  // allowed if doing so does not dip into it. (`capacity - reserve` would let background spend the
  // reserve down to its edge — the difference between "a reserve" and "a head start".)
  if (state.tradeWaiting > 0) {
    return { ok: false, waitMs: Math.max(25, waitForRefill()) }
  }
  if (state.tokens - 1 >= cfg.tradeReserve) return { ok: true, waitMs: 0 }
  return { ok: false, waitMs: Math.max(25, waitForRefill()) }
}

/** Spend a token for a caller already cleared by `canTakeJupiterToken`. Mutates `state`. */
export function takeJupiterToken(state: JupiterGateState): void {
  state.tokens = Math.max(0, state.tokens - 1)
}

const GATE = createJupiterGate()
const STATE: JupiterGateState = { tokens: GATE.capacity, updatedAt: 0, tradeWaiting: 0 }

export const JUPITER_MAX_RPS = GATE.rps
export const JUPITER_USER_AGENT = 'BuyBulk/1.0'

export function resetJupiterRpsForTests(): void {
  STATE.tokens = GATE.capacity
  STATE.updatedAt = 0
  STATE.tradeWaiting = 0
}

export async function throttleJupiterRps(lane: JupiterLane = 'background'): Promise<void> {
  if (lane === 'trade') STATE.tradeWaiting += 1
  try {
    for (;;) {
      const now = Date.now()
      refillJupiterTokens(STATE, now, GATE)
      const { ok, waitMs } = canTakeJupiterToken(STATE, lane, GATE)
      if (ok) {
        takeJupiterToken(STATE)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  } finally {
    if (lane === 'trade') STATE.tradeWaiting -= 1
  }
}

export function jupiterApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'cache-control': 'no-cache',
    'user-agent': JUPITER_USER_AGENT,
  }
  const key = process.env.JUPITER_API_KEY?.trim()
  if (key) headers['x-api-key'] = key
  return headers
}
