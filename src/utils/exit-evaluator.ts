/**
 * The one exit decision (SPEC-strategy-exit-standard S2/S3).
 *
 * Extracted from `checkSLTPTriggers`, with one thing added: the basis is read off the data rather
 * than implied by which caller ran. That is the whole defect this replaces — the mcap family's
 * thresholds are the same numbers whether the tracker or the mcap closer reads them, but one
 * interpreted them as a USD price and the other as mcap growth, so the two could disagree in the
 * same tick and neither was wrong by its own rules.
 *
 * Pure: no I/O, no clock, no cache. Everything it needs is an argument, which is what makes it
 * testable and what keeps a stale value from entering through a side door.
 */

export type ExitBasis = 'price' | 'mcap'

export type ExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'max_hold'
  | 'max_age'
  | 'label_rugged'
  | 'hold'
  | 'stale'

export type ExitDecision = {
  close: boolean
  reason: ExitReason
  /** The gain the decision was made on, in the declared basis. Null when it could not be computed. */
  pnlPct: number | null
  basisUsed: ExitBasis
  /**
   * The worker's own trigger vocabulary, so an outcome row records which tick fired rather than a
   * generic "take_profit". Null when nothing fired.
   */
  triggerType:
    | 'stop_loss'
    | 'take_profit_1'
    | 'take_profit_2'
    | 'take_profit_3'
    | 'max_hold_time'
    | 'max_age'
    | 'label_rugged'
    | null
  /** Partial sell, when the fired trigger is a ladder step. 100 otherwise. */
  sellPercentage: number
}

export type ExitLadder = {
  tp1Pct?: number | null
  tp1SellPct?: number | null
  tp2Pct?: number | null
  tp3Pct?: number | null
  tp3Enabled?: boolean | null
  tp1Executed?: boolean | null
  tp2Executed?: boolean | null
  tp3Executed?: boolean | null
}

export type EvaluateExitInput = {
  /** The value the thresholds are measured against, stamped at open (S8). */
  referenceValue: number | null | undefined
  /** What `referenceValue` is. Anything but 'mcap' is treated as 'price'. */
  referenceKind?: string | null
  /** The live value in the same basis. */
  live: number | null | undefined
  /** Stop loss, as a percentage. Negative. */
  stopLossPct?: number | null
  /** Single take profit, as a percentage. Used when there is no ladder. */
  takeProfitPct?: number | null
  ladder?: ExitLadder | null
  entryAt?: string | null
  maxHoldHours?: number | null
  /** True when the live value is older than the configured age bound — fail closed (S4). */
  stale?: boolean
  /**
   * True when the token is known-rug. Closes regardless of where the price sits, because a rug is
   * not a threshold event — the threshold it would cross is the one that never comes back.
   *
   * The caller resolves this and passes it in, which keeps this function pure. A read that fails
   * must pass `false` (fail-open): the price path then decides, exactly as it would without this
   * input, so a rug lookup that times out can never block an exit.
   */
  rugged?: boolean
  nowMs?: number
  /** A hold longer than this is the last-resort backstop, counted as a health metric (S5). */
  maxAgeHours?: number | null
}

const HOLD: Omit<ExitDecision, 'basisUsed'> = {
  close: false,
  reason: 'hold',
  pnlPct: null,
  triggerType: null,
  sellPercentage: 0,
}

function positive(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * Decide whether a position closes, and why.
 *
 * Order matters and is deliberate: stop loss first (risk before reward), then the take-profit
 * ladder, then max-hold, then the age backstop. A stale input closes nothing — it reports `stale`
 * so the caller can count it, because holding on an unreadable value is how a position stays open
 * past its stop.
 */
export function evaluateExit(input: EvaluateExitInput): ExitDecision {
  const basisUsed: ExitBasis = input.referenceKind === 'mcap' ? 'mcap' : 'price'

  // Stale FIRST, above the value guards. `stale` means "no usable input", and a value that could not
  // be read arrives as a missing/zero `live` — so checking the guards first reported the missing
  // price as an ordinary `hold`, which is exactly the silent hold S4 forbids. Reported, and never
  // valued from the stale number.
  if (input.stale) {
    return { ...HOLD, reason: 'stale', basisUsed }
  }
  if (!positive(input.referenceValue) || !positive(input.live)) {
    return { ...HOLD, basisUsed }
  }

  const gainPct = ((input.live - input.referenceValue) / input.referenceValue) * 100

  // Rugged, before the thresholds. It is deliberately below the two positive-value guards above:
  // closing needs a price to close AT, so an unpriced rugged token reports `stale` instead, which
  // is visible and counted. Where a price exists, a rug close records the real loss rather than
  // waiting for the stop to catch a price that may never print.
  if (input.rugged) {
    return {
      close: true,
      reason: 'label_rugged',
      pnlPct: gainPct,
      basisUsed,
      triggerType: 'label_rugged',
      sellPercentage: 100,
    }
  }

  // Stop loss. The stored threshold is negative; a positive one would sit above the entry and fire
  // on the first tick, so the comparison is made against the signed value as stored.
  if (input.stopLossPct != null && gainPct <= input.stopLossPct) {
    return {
      close: true,
      reason: 'stop_loss',
      pnlPct: gainPct,
      basisUsed,
      triggerType: 'stop_loss',
      sellPercentage: 100,
    }
  }

  // Take profit. A row with a ladder reads the ladder; a row with only a single target reads that.
  // Reading only the ladder is what made `take_profit_percentage` a field the worker never
  // evaluated — `Finished: 211 (SL: 211, TP1: 0, TP2: 0, TP3: 0)`.
  const ladder = input.ladder ?? null
  const hasLadder =
    ladder != null && (ladder.tp1Pct != null || ladder.tp2Pct != null || ladder.tp3Pct != null)

  if (hasLadder) {
    if (ladder!.tp1Pct != null && !ladder!.tp1Executed && gainPct >= ladder!.tp1Pct) {
      return {
        close: true,
        reason: 'take_profit',
        pnlPct: gainPct,
        basisUsed,
        triggerType: 'take_profit_1',
        sellPercentage: ladder!.tp1SellPct ?? 80,
      }
    }
    if (
      ladder!.tp2Pct != null &&
      ladder!.tp1Executed &&
      !ladder!.tp2Executed &&
      gainPct >= ladder!.tp2Pct
    ) {
      return {
        close: true,
        reason: 'take_profit',
        pnlPct: gainPct,
        basisUsed,
        triggerType: 'take_profit_2',
        sellPercentage: 100,
      }
    }
    if (
      ladder!.tp3Pct != null &&
      ladder!.tp3Enabled &&
      ladder!.tp1Executed &&
      !ladder!.tp3Executed &&
      gainPct <= ladder!.tp3Pct
    ) {
      return {
        close: true,
        reason: 'take_profit',
        pnlPct: gainPct,
        basisUsed,
        triggerType: 'take_profit_3',
        sellPercentage: 100,
      }
    }
  } else if (input.takeProfitPct != null && gainPct >= input.takeProfitPct) {
    return {
      close: true,
      reason: 'take_profit',
      pnlPct: gainPct,
      basisUsed,
      triggerType: 'take_profit_1',
      // A lone target sells all of it: there is no TP2 to catch the remainder.
      sellPercentage: 100,
    }
  }

  const entryMs = input.entryAt ? new Date(input.entryAt).getTime() : NaN
  const nowMs = input.nowMs ?? Date.now()
  if (Number.isFinite(entryMs)) {
    const heldHours = (nowMs - entryMs) / 3_600_000
    if (input.maxHoldHours != null && input.maxHoldHours > 0 && heldHours >= input.maxHoldHours) {
      return {
        close: true,
        reason: 'max_hold',
        pnlPct: gainPct,
        basisUsed,
        triggerType: 'max_hold_time',
        sellPercentage: 100,
      }
    }
    if (input.maxAgeHours != null && input.maxAgeHours > 0 && heldHours >= input.maxAgeHours) {
      return {
        close: true,
        reason: 'max_age',
        pnlPct: gainPct,
        basisUsed,
        // Its own trigger, not `max_hold_time`. Both backstops used to return the same value, so a
        // row could not say which one fired and `WORKER_CLOSE_REASONS`'s `max_age` entry was
        // unreachable. S5's backstop share is uncomputable while they are indistinguishable.
        triggerType: 'max_age',
        sellPercentage: 100,
      }
    }
  }

  return { ...HOLD, pnlPct: gainPct, basisUsed }
}

/**
 * The values `sl_tp_positions.close_reason` may hold (S2's closed set, plus the non-trigger ways a
 * row stops being active).
 *
 * Kept here, next to `ExitReason`, because the exit vocabulary is one thing. `closeReasonForTrigger`
 * in `close-strategy-sim-position` maps the worker's trigger names onto these.
 */
export const PERSISTED_CLOSE_REASONS = [
  'stop_loss',
  'take_profit',
  'max_hold',
  'max_age',
  'label_rugged',
  'strategy_deactivated',
  'tracking_stopped',
  'no_balance',
  'reconciled',
  'removed',
  'unknown',
] as const

export type PersistedCloseReason = (typeof PERSISTED_CLOSE_REASONS)[number]

/**
 * Coerce anything to a persistable reason.
 *
 * Unrecognised input becomes `'unknown'` rather than throwing, and that is deliberate: this runs on
 * the close path, and a position left open past its stop because a diagnostic label did not match a
 * list is a far worse failure than a missing reason. `'unknown'` is a member of the set so the
 * `close_reason` CHECK can never reject a close, and an unexpected value is still visible in the
 * data instead of silently absent.
 */
export function toPersistedCloseReason(value: string | null | undefined): PersistedCloseReason {
  return (PERSISTED_CLOSE_REASONS as readonly string[]).includes(value ?? '')
    ? (value as PersistedCloseReason)
    : 'unknown'
}
