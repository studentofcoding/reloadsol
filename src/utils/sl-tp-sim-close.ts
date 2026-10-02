/**
 * The SL/TP worker closing a PAPER position (SPEC-strategy-exit-standard G1 / S9).
 *
 * The worker could already detect a paper trigger, but `markSimulatedPositionClosed` only flips the
 * `sl_tp_positions` mirror row — it writes no outcome and no sell record, so the trade stayed open
 * everywhere that matters. This is the missing half.
 *
 * It dispatches to the closers that already exist for strategy deactivation
 * (`close-strategy-sim-position.ts`) rather than writing a third close path: those already build the
 * sell trading record that retires the open cycle, compute the PnL, and write the domain outcome —
 * the only thing they lacked was a reason other than "deactivated", and a live price to close at.
 *
 * Deliberately NOT touching the chain: every path here is `is_simulation: true`, and
 * `executeSellOrder` (which hardcodes `isSimulated: false`) is unreachable from this module.
 */
import type { SLTPPosition } from '@/utils/sl-tp-tracker'
import {
  closeMcapStrategySimPositions,
  closePriceStrategySimPosition,
  closeReasonForTrigger,
} from '@/strategies/close-strategy-sim-position'
import type { StrategyChain } from '@/strategies/types'
import { query, queryOne } from '@/utils/db'
import { INSTANCE_ID } from '@/utils/bot-job-lock'

export type SimCloseDomain = 'mcap' | 'signals' | 'gmgn' | 'social'

/**
 * Which closer owns a strategy's paper positions, from its id.
 *
 * Returns null for an unrecognised family. That is deliberate: guessing a close path would write an
 * outcome under the wrong domain, which is worse than leaving the row for the strategy's own
 * closer. The coverage test asserts every active strategy resolves here.
 */
export function simCloseDomainForStrategy(strategyId: string): SimCloseDomain | null {
  if (strategyId.startsWith('search_mcap') || strategyId.startsWith('mcap_enter')) return 'mcap'
  if (strategyId.startsWith('gmgn')) return 'gmgn'
  if (strategyId.startsWith('social')) return 'social'
  // Signals ids arrive in two shapes: `signals_default_rh` and
  // `search_signals_signals_score40_g0_default`. Both are the signals domain.
  if (strategyId.startsWith('signals') || strategyId.startsWith('search_signals')) return 'signals'
  return null
}

export type SimCloseOutcome = {
  /** True when a close was written; false when the family is unrecognised or no cycle was found. */
  closed: boolean
  domain: SimCloseDomain | null
  /**
   * True when nothing was written because this trade had already closed — the caller should retire
   * the mirror and stop. Distinct from `closed: true`, which means this call wrote the close.
   */
  alreadyClosed?: boolean
  /**
   * True when another pass holds the claim on this position, so nothing was evaluated or written.
   * NOT a shadow and NOT a failure: the caller must not count it as either.
   */
  claimedElsewhere?: boolean
}

/** Long enough to cover one slow close (a wallet hydration + two inserts); short enough to retry. */
const CLOSE_CLAIM_TTL_SEC = 300

/**
 * Atomically claim the right to close ONE position.
 *
 * `outcomeAlreadyExists` is a read-then-write guard, so it only protects SEQUENTIAL passes. The
 * `sltp_monitor` job lock cannot make passes sequential: it has a 120s TTL and no heartbeat (55e259e),
 * a route handler is not cancelled when the Go client's 120s timeout abandons the request, and
 * `releaseJobLock` deletes on `locked_by = INSTANCE_ID`, which is per PROCESS — so a finished slow
 * pass releases the lock a newer pass is holding. Two passes can therefore be inside the close at the
 * same time, both read "no outcome yet", and both insert a sell record for one trade.
 *
 * This is a single-statement upsert on the existing `bot_job_locks` primary key (no migration): it
 * returns a row only when the key was absent or its previous claim has expired.
 *
 * Fail-open, like the guard it complements: if the claim itself errors, the close proceeds.
 */
export async function claimPositionClose(positionId: string): Promise<boolean> {
  try {
    const { rows } = await query<{ job_name: string }>(
      `INSERT INTO bot_job_locks (job_name, locked_at, locked_by, expires_at)
       VALUES ($1, now(), $2, now() + make_interval(secs => $3))
       ON CONFLICT (job_name) DO UPDATE
         SET locked_at = EXCLUDED.locked_at,
             locked_by = EXCLUDED.locked_by,
             expires_at = EXCLUDED.expires_at
         WHERE bot_job_locks.expires_at < now()
       RETURNING job_name`,
      [`sltp_close:${positionId}`, INSTANCE_ID, CLOSE_CLAIM_TTL_SEC],
    )
    return rows.length > 0
  } catch (error) {
    console.warn(
      '[sl-tp-sim-close] close claim failed; closing anyway:',
      error instanceof Error ? error.message : error,
    )
    return true
  }
}

async function releasePositionClose(positionId: string): Promise<void> {
  try {
    await query(`DELETE FROM bot_job_locks WHERE job_name = $1`, [`sltp_close:${positionId}`])
  } catch {
    // The claim expires on its own TTL.
  }
}

/**
 * Has this trade already been closed?
 *
 * The worker retires the mirror LAST (`markSimulatedPositionClosed` runs after the closer returns),
 * so a pass killed between the outcome write and the mirror update leaves a row that is still
 * `is_active = true` with its outcome already written. The next tick re-evaluates it and would close
 * it again, writing a SECOND sell record for one trade — and the sim's ledger is built from those
 * records, so a duplicate invents a trade that never happened.
 *
 * Keyed on the FULL identity the outcome table is already unique on
 * (`db/init/45-strategy-outcomes-identity.sql`). Never the mint alone: the same mint traded twice is
 * two different trades — `att_rh` has one mint at 1,610 closes — so a mint-keyed check would silently
 * skip every re-entry.
 *
 * Fail-open. If the check itself fails, this returns false and the close proceeds: a guard on the
 * close path must never be the reason a position stays open.
 */
async function outcomeAlreadyExists(params: {
  chain: string
  strategyId: string
  mint: string
  entryAt: string | null | undefined
}): Promise<boolean> {
  if (!params.entryAt) return false
  try {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM strategy_outcomes
        WHERE chain = $1 AND strategy_id = $2 AND token_address = $3 AND entry_at = $4
        LIMIT 1`,
      [params.chain, params.strategyId, params.mint, params.entryAt],
    )
    return row != null
  } catch (error) {
    console.warn(
      '[sl-tp-sim-close] closed-outcome check failed; closing anyway:',
      error instanceof Error ? error.message : error,
    )
    return false
  }
}

/**
 * Close one paper position on a worker trigger. Never throws: a close that fails is reported, not
 * allowed to abort the worker pass for every other position.
 */
export async function closeSimulatedPositionFromWorker(params: {
  position: SLTPPosition
  /** The `trigger_type` from `checkSLTPTriggers`, mapped onto the outcome vocabulary. */
  triggerType: string
  /** The live price the decision was made on — the same tick the trigger was evaluated against. */
  currentPrice: number
}): Promise<SimCloseOutcome> {
  const { position } = params
  const strategyId = position.strategy_id
  if (!strategyId) return { closed: false, domain: null }

  const domain = simCloseDomainForStrategy(strategyId)
  if (!domain) return { closed: false, domain: null }

  const chain: StrategyChain = position.chain === 'robinhood' ? 'robinhood' : 'sol'
  const closeReason = closeReasonForTrigger(params.triggerType)
  const sellPriceUsd =
    params.currentPrice > 0 ? params.currentPrice : undefined

  // One closer per position at a time (see claimPositionClose). Taken before the idempotency check so
  // the check-then-write below is no longer a race between concurrent passes.
  if (!(await claimPositionClose(position.id))) {
    return { closed: false, domain, claimedElsewhere: true }
  }

  // Re-runnable by construction: if this trade already closed, retire the mirror (the caller does
  // that when `closed` is true) and write nothing else. See outcomeAlreadyExists for why the check
  // is keyed on the full identity and why it fails open.
  if (
    await outcomeAlreadyExists({
      chain,
      strategyId,
      mint: position.token_address,
      entryAt: position.created_at,
    })
  ) {
    return { closed: true, domain, alreadyClosed: true }
  }

  try {
    if (domain === 'mcap') {
      const result = await closeMcapStrategySimPositions(strategyId, chain, {
        closeReason,
        mintAddress: position.token_address,
        sellPriceUsd,
      })
      if (result.closed <= 0) await releasePositionClose(position.id)
      return { closed: result.closed > 0, domain }
    }

    await closePriceStrategySimPosition({
      domain,
      chain,
      strategyId,
      mintAddress: position.token_address,
      symbol: position.token_symbol,
      // The mirror row's creation is the open, so it is the best entry timestamp this side has.
      // `ensureCompleteBuyFeaturesForOutcome` rebuilds the features from the mint.
      entryAt: position.created_at,
      entryFeatures: {},
      closeReason,
      sellPriceUsd,
    })
    return { closed: true, domain }
  } catch (error) {
    console.warn(
      '[sl-tp-sim-close] paper close failed:',
      error instanceof Error ? error.message : error,
      { strategyId, mint: position.token_address, triggerType: params.triggerType },
    )
    // A failed close must be retryable on the next tick, not parked behind its own claim.
    await releasePositionClose(position.id)
    return { closed: false, domain }
  }
}
