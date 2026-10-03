/**
 * Position-open attempt record + the failed-open retry policy.
 * SPEC: docs/specs/SPEC-open-attempts-reporting-v1.md
 *
 * Two independent pieces, each behind its own flag:
 *   - recording (`OPEN_ATTEMPTS_RECORD`, default ON — it is reporting data, passive, best-effort)
 *   - the retry policy (`OPEN_RETRY_POLICY`, default OFF — it changes behaviour)
 */
import { query } from '@/utils/db'
import { log } from '@/utils/unified-logger'

type EnvLike = Record<string, string | undefined>

export type OpenAttemptOutcome = 'success' | 'failed' | 'skipped'

export type OpenAttemptRow = {
  strategyId: string
  chain?: string
  tokenAddress: string
  outcome: OpenAttemptOutcome
  stage?: string | null
  reason?: string | null
  attemptNo?: number
  isFinal?: boolean
  priceUsd?: number | null
  prevPriceUsd?: number | null
  priceMovePct?: number | null
  detail?: Record<string, unknown> | null
}

export function isOpenRecordingEnabled(env: EnvLike = process.env): boolean {
  const v = env.OPEN_ATTEMPTS_RECORD?.trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off')
}

export function isOpenRetryPolicyEnabled(env: EnvLike = process.env): boolean {
  return env.OPEN_RETRY_POLICY?.trim() === '1'
}

export type OpenRetryConfig = {
  /** Extra tries after the first (user policy: 2). */
  maxRetries: number
  /** Fail loudly and skip when the price moved more than this vs. the last failed try (either direction). */
  maxMovePct: number
  delayMs: number
}

export function openRetryConfig(env: EnvLike = process.env): OpenRetryConfig {
  const retries = Number(env.OPEN_RETRY_MAX)
  const move = Number(env.OPEN_RETRY_MAX_MOVE_PCT)
  const delay = Number(env.OPEN_RETRY_DELAY_MS)
  return {
    maxRetries: Number.isFinite(retries) && retries >= 0 ? Math.min(Math.floor(retries), 5) : 2,
    maxMovePct: Number.isFinite(move) && move > 0 ? move : 5,
    delayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 30_000) : 1500,
  }
}

/** Signed percent change from `prev` to `next`; null when either is unusable. */
export function priceMovePct(prev: number | null | undefined, next: number | null | undefined): number | null {
  if (prev == null || next == null) return null
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) return null
  return ((next - prev) / prev) * 100
}

export type RetryDecision =
  | { action: 'retry' }
  | { action: 'skip_price_moved'; movePct: number }

/** The user's policy: retry unless the fresh price moved > maxMovePct (either direction) from the last failed try. */
export function decideRetry(
  lastFailedPriceUsd: number | null | undefined,
  freshPriceUsd: number | null | undefined,
  cfg: Pick<OpenRetryConfig, 'maxMovePct'>,
): RetryDecision {
  const move = priceMovePct(lastFailedPriceUsd, freshPriceUsd)
  if (move != null && Math.abs(move) > cfg.maxMovePct) return { action: 'skip_price_moved', movePct: move }
  return { action: 'retry' }
}

// If the migration has not been applied, fail quiet-after-first instead of one warn per tick.
let disabledUntil = 0
const MISSING_TABLE_BACKOFF_MS = 10 * 60_000

export async function recordOpenAttempt(
  row: OpenAttemptRow,
  deps: { query?: typeof query; env?: EnvLike; now?: () => number } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env
  if (!isOpenRecordingEnabled(env)) return false
  const now = (deps.now ?? Date.now)()
  if (now < disabledUntil) return false
  const q = deps.query ?? query
  try {
    await q(
      `INSERT INTO position_open_attempts
         (strategy_id, chain, token_address, outcome, stage, reason, attempt_no, is_final,
          price_usd, prev_price_usd, price_move_pct, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        row.strategyId,
        row.chain ?? 'sol',
        row.tokenAddress,
        row.outcome,
        row.stage ?? null,
        row.reason ?? null,
        row.attemptNo ?? 1,
        row.isFinal ?? true,
        row.priceUsd ?? null,
        row.prevPriceUsd ?? null,
        row.priceMovePct ?? null,
        row.detail ? JSON.stringify(row.detail) : null,
      ],
    )
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/position_open_attempts/.test(msg) && /does not exist/.test(msg)) {
      disabledUntil = now + MISSING_TABLE_BACKOFF_MS
      log.warn('error_handling', 'position_open_attempts missing — apply db/init/65; recording paused 10 min')
    } else {
      log.warn('error_handling', 'position_open_attempts insert failed', { error: msg })
    }
    return false
  }
}

/** Test helper. */
export function __resetOpenAttemptsForTests(): void {
  disabledUntil = 0
}

type SpineStage = 'gate' | 'price' | 'rug' | 'size' | 'pass'

/**
 * Map a spine decision (already emitted by every sim-track route / gmgn-open-sim / social cross-check)
 * to an attempt row. A `pass` is NOT recorded: whether the position then opened is read from
 * `sl_tp_positions`, which cannot lie; recording the pass here would call an un-opened position a success.
 * `price` = we could not even price it = a failed open. gate / rug / size = a deliberate stand-down = skipped.
 */
export function spineDecisionToAttempt(d: {
  workerId: string
  mint: string
  stage: SpineStage
  reason: string | null
  passed: boolean
}): OpenAttemptRow | null {
  if (d.passed || d.stage === 'pass') return null
  // The retry policy already recorded this one with its prices (price_moved_gt_Npct).
  if (d.reason?.startsWith('price_moved_gt_')) return null
  return {
    strategyId: d.workerId,
    tokenAddress: d.mint,
    outcome: d.stage === 'price' ? 'failed' : 'skipped',
    stage: d.stage,
    reason: d.reason,
    detail: { source: 'spine_decision' },
  }
}

// ---------------------------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------------------------

export type RetryableOpenResult = { ok: boolean; stage?: string; reason?: string }

function usablePrice(p: number | null | undefined): number | null {
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
}

/**
 * Failed-open policy (user, 2026-10-04): retry 2 times; if the price moved > 5 % (either direction)
 * from the last failed try, fail loudly and skip.
 *
 * Retryable = the attempt threw, or the spine could not price it (`stage: 'price'`). A rug / size
 * stand-down is a decision, not a failure, and is returned untouched on the first try.
 *
 * Exhausted retries: a thrown error is re-thrown (callers already handle it); a price-stage result is
 * returned as-is (the route records it through its spine decision). Intermediate failures are recorded
 * with `is_final=false`; the price-moved skip is recorded here with both prices.
 */
export async function runOpenWithRetry<R extends RetryableOpenResult>(args: {
  strategyId: string
  chain: string
  mint: string
  initialPriceUsd: number | null | undefined
  attempt: (priceUsd: number | null | undefined) => Promise<R>
  refetchPriceUsd: () => Promise<number | null | undefined>
  cfg?: OpenRetryConfig
  sleep?: (ms: number) => Promise<void>
  record?: (row: OpenAttemptRow) => Promise<boolean>
}): Promise<R | { ok: false; stage: 'price'; reason: string }> {
  const cfg = args.cfg ?? openRetryConfig()
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const record = args.record ?? ((row: OpenAttemptRow) => recordOpenAttempt(row))
  const totalTries = 1 + cfg.maxRetries

  let price = args.initialPriceUsd
  let lastFailedPrice: number | null = null
  let lastResult: R | null = null
  let lastError: unknown = null

  for (let tryNo = 1; tryNo <= totalTries; tryNo++) {
    if (tryNo > 1) {
      if (cfg.delayMs > 0) await sleep(cfg.delayMs)
      let fresh: number | null = null
      try {
        fresh = usablePrice(await args.refetchPriceUsd())
      } catch {
        fresh = null
      }
      if (fresh != null) {
        const decision = decideRetry(lastFailedPrice, fresh, cfg)
        if (decision.action === 'skip_price_moved') {
          const reason = `price_moved_gt_${cfg.maxMovePct}pct`
          log.error('error_handling', `OPEN SKIPPED — price moved ${decision.movePct.toFixed(2)}% since the failed try`, undefined, {
            strategyId: args.strategyId,
            tokenAddress: args.mint,
            prevPriceUsd: lastFailedPrice,
            priceUsd: fresh,
            movePct: decision.movePct,
            tryNo,
          })
          await record({
            strategyId: args.strategyId,
            chain: args.chain,
            tokenAddress: args.mint,
            outcome: 'failed',
            stage: 'retry',
            reason,
            attemptNo: tryNo,
            isFinal: true,
            priceUsd: fresh,
            prevPriceUsd: lastFailedPrice,
            priceMovePct: decision.movePct,
            detail: { policy: 'open_retry' },
          })
          return { ok: false, stage: 'price', reason }
        }
        price = fresh
      }
    }

    const priceForTry = usablePrice(price)
    try {
      const res = await args.attempt(price)
      if (res.ok || res.stage !== 'price') {
        if (res.ok && tryNo > 1) {
          log.warn('error_handling', `open succeeded on retry ${tryNo - 1}`, { strategyId: args.strategyId, tokenAddress: args.mint })
        }
        return res
      }
      lastResult = res
      lastError = null
    } catch (error) {
      lastError = error
      lastResult = null
    }

    if (priceForTry != null) lastFailedPrice = priceForTry
    const isLast = tryNo === totalTries
    const errMsg = lastError ? (lastError instanceof Error ? lastError.message : String(lastError)) : null
    // The final price-stage failure is recorded by the route's spine decision; a final throw has no
    // such path, so it is recorded here.
    if (!isLast || lastError) {
      await record({
        strategyId: args.strategyId,
        chain: args.chain,
        tokenAddress: args.mint,
        outcome: 'failed',
        stage: lastError ? 'exception' : 'price',
        reason: errMsg ?? lastResult?.reason ?? 'missing_price',
        attemptNo: tryNo,
        isFinal: isLast,
        priceUsd: priceForTry,
        detail: { policy: 'open_retry', ...(isLast ? { exhausted: true } : {}) },
      })
    }
  }

  log.error('error_handling', 'OPEN FAILED — retries exhausted', undefined, {
    strategyId: args.strategyId,
    tokenAddress: args.mint,
    tries: totalTries,
    error: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
    reason: lastResult?.reason,
  })
  if (lastError) throw lastError
  return lastResult as R
}
