import { supabase } from '@/utils/supabase'
import {
  formatSupabaseError,
  isSupabaseCircuitOpen,
  isSupabaseQuotaOrTimeoutError,
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

async function getOrCreateState(): Promise<BotTradingStateRow | null> {
  const { data, error } = await supabase
    .from('bot_trading_state')
    .select('*')
    .eq('id', STATE_ID)
    .maybeSingle()

  if (error) {
    console.warn('[bot-trading-state] read failed:', error.message)
    return null
  }

  if (data) return data as BotTradingStateRow

  const { data: inserted, error: insertError } = await supabase
    .from('bot_trading_state')
    .insert({
      id: STATE_ID,
      consecutive_failures: 0,
      real_trading_halted: false,
    })
    .select('*')
    .maybeSingle()

  if (insertError) {
    console.warn('[bot-trading-state] init failed:', insertError.message)
    return null
  }

  return inserted as BotTradingStateRow | null
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
      await supabase
        .from('bot_trading_state')
        .update({
          real_trading_halted: false,
          consecutive_failures: 0,
          halted_at: null,
          halt_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', STATE_ID)
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
  await supabase
    .from('bot_trading_state')
    .upsert({
      id: STATE_ID,
      consecutive_failures: 0,
      real_trading_halted: false,
      halted_at: null,
      halt_reason: null,
      updated_at: new Date().toISOString(),
    })
}

export async function recordTradingFailure(reason: string): Promise<void> {
  const state = await getOrCreateState()
  const failures = (state?.consecutive_failures ?? 0) + 1
  const shouldHalt = failures >= FAILURE_THRESHOLD

  await supabase.from('bot_trading_state').upsert({
    id: STATE_ID,
    consecutive_failures: failures,
    real_trading_halted: shouldHalt,
    halted_at: shouldHalt ? new Date().toISOString() : null,
    halt_reason: shouldHalt ? reason : null,
    updated_at: new Date().toISOString(),
  })

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
  if (isSupabaseCircuitOpen()) {
    return {
      acquired: false,
      reason: 'Supabase circuit open — trade lock not acquired',
    }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()

  await supabase
    .from('bot_trade_locks')
    .delete()
    .lt('expires_at', now.toISOString())

  const { error } = await supabase.from('bot_trade_locks').insert({
    token_address: tokenAddress,
    strategy_id: strategyId,
    locked_at: now.toISOString(),
    expires_at: expiresAt,
  })

  if (!error) {
    return { acquired: true }
  }

  if (error.code === '23505') {
    return {
      acquired: false,
      reason: `Trade lock held for ${tokenAddress} (${strategyId})`,
    }
  }

  console.warn('[bot-trading-state] trade lock insert failed:', formatSupabaseError(error))
  return {
    acquired: false,
    reason: isSupabaseQuotaOrTimeoutError(error)
      ? 'Supabase unavailable (quota/timeout) — trade lock not acquired'
      : formatSupabaseError(error),
  }
}

export async function releaseTradeLock(
  tokenAddress: string,
  strategyId: string,
): Promise<void> {
  await supabase
    .from('bot_trade_locks')
    .delete()
    .eq('token_address', tokenAddress)
    .eq('strategy_id', strategyId)
}
