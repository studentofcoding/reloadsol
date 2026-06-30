import { query, queryOne } from '@/utils/db'
import {
  formatDbConnectionError,
  isDbCircuitOpen,
  isDbQuotaOrTimeoutError,
} from '@/utils/db-health'

const STATE_ID = 'global'
const FAILURE_THRESHOLD = parseInt(
  process.env.BOT_TRADING_FAILURE_THRESHOLD || '5',
  10,
)
const HALT_MINUTES = parseInt(process.env.BOT_TRADING_HALT_MINUTES || '30', 10)
const TRADE_LOCK_TTL_SEC = parseInt(process.env.BOT_TRADE_LOCK_TTL_SEC || '120', 10)

interface BotTradingStateRow {
  id: string
  consecutive_failures: number
  real_trading_halted: boolean
  halted_at: string | null
  halt_reason: string | null
  updated_at: string
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

async function getOrCreateState(): Promise<BotTradingStateRow | null> {
  try {
    const row = await queryOne<BotTradingStateRow>(
      `SELECT * FROM bot_trading_state WHERE id = $1`,
      [STATE_ID],
    )
    if (row) return row

    return await queryOne<BotTradingStateRow>(
      `INSERT INTO bot_trading_state (id, consecutive_failures, real_trading_halted)
       VALUES ($1, 0, false)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING *`,
      [STATE_ID],
    )
  } catch (error) {
    console.warn('[bot-trading-state] read/init failed:', (error as Error).message)
    return null
  }
}

/** Returns whether real bot trading is allowed (circuit breaker). */
export async function isRealTradingHalted(): Promise<{
  halted: boolean
  reason?: string
}> {
  const state = await getOrCreateState()
  if (!state?.real_trading_halted) {
    return { halted: false }
  }

  if (state.halted_at) {
    const haltUntil =
      new Date(state.halted_at).getTime() + HALT_MINUTES * 60 * 1000
    if (Date.now() >= haltUntil) {
      await query(
        `UPDATE bot_trading_state SET
           real_trading_halted = false,
           consecutive_failures = 0,
           halted_at = NULL,
           halt_reason = NULL,
           updated_at = $2
         WHERE id = $1`,
        [STATE_ID, new Date().toISOString()],
      )
      return { halted: false }
    }
  }

  return {
    halted: true,
    reason:
      state.halt_reason ||
      `Real trading halted after ${FAILURE_THRESHOLD} consecutive failures`,
  }
}

export async function recordTradingSuccess(): Promise<void> {
  const now = new Date().toISOString()
  await query(
    `INSERT INTO bot_trading_state (
       id, consecutive_failures, real_trading_halted, halted_at, halt_reason, updated_at
     ) VALUES ($1, 0, false, NULL, NULL, $2)
     ON CONFLICT (id) DO UPDATE SET
       consecutive_failures = 0,
       real_trading_halted = false,
       halted_at = NULL,
       halt_reason = NULL,
       updated_at = EXCLUDED.updated_at`,
    [STATE_ID, now],
  )
}

export async function recordTradingFailure(reason: string): Promise<void> {
  const state = await getOrCreateState()
  const failures = (state?.consecutive_failures ?? 0) + 1
  const shouldHalt = failures >= FAILURE_THRESHOLD
  const now = new Date().toISOString()

  await query(
    `INSERT INTO bot_trading_state (
       id, consecutive_failures, real_trading_halted, halted_at, halt_reason, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       consecutive_failures = EXCLUDED.consecutive_failures,
       real_trading_halted = EXCLUDED.real_trading_halted,
       halted_at = EXCLUDED.halted_at,
       halt_reason = EXCLUDED.halt_reason,
       updated_at = EXCLUDED.updated_at`,
    [
      STATE_ID,
      failures,
      shouldHalt,
      shouldHalt ? now : null,
      shouldHalt ? reason : null,
      now,
    ],
  )

  if (shouldHalt) {
    console.error(
      `[bot-trading-state] Circuit breaker OPEN after ${failures} failures: ${reason}`,
    )
  }
}

/** DB-backed lock to prevent duplicate concurrent buys across instances. */
export async function acquireTradeLock(
  tokenAddress: string,
  strategyId: string,
  ttlSeconds = TRADE_LOCK_TTL_SEC,
): Promise<{ acquired: boolean; reason?: string }> {
  if (isDbCircuitOpen()) {
    return {
      acquired: false,
      reason: 'Database circuit open — trade lock not acquired',
    }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()

  await query(
    `DELETE FROM bot_trade_locks WHERE expires_at < $1`,
    [now.toISOString()],
  )

  try {
    await query(
      `INSERT INTO bot_trade_locks (token_address, strategy_id, locked_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenAddress, strategyId, now.toISOString(), expiresAt],
    )
    return { acquired: true }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        acquired: false,
        reason: `Trade lock held for ${tokenAddress} (${strategyId})`,
      }
    }

    console.warn('[bot-trading-state] trade lock insert failed:', formatDbConnectionError(error))
    return {
      acquired: false,
      reason: isDbQuotaOrTimeoutError(error)
        ? 'Database unavailable (timeout) — trade lock not acquired'
        : formatDbConnectionError(error),
    }
  }
}

export async function releaseTradeLock(
  tokenAddress: string,
  strategyId: string,
): Promise<void> {
  await query(
    `DELETE FROM bot_trade_locks WHERE token_address = $1 AND strategy_id = $2`,
    [tokenAddress, strategyId],
  )
}
