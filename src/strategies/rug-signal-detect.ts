/**
 * Rug-signal detector: resolve the score's inputs, evaluate, and — on trip — write
 * `rug` straight through the shared rug list (`markTokenRug`, so tracker label,
 * `trading_signals` and the OHLC corpus all sync).
 *
 * Env-gated (`RUG_SIGNAL_ENABLED`, default off) and best-effort: a fetcher or DB
 * failure returns without writing and never throws into the calling pipeline.
 * `RUG_SIGNAL_MODE=shadow` logs the would-be verdict and writes nothing; a kill
 * switch forces shadow. See docs/specs/SPEC-rug-signal-v1.md.
 */

import type { AppNetwork } from '@/utils/app-network'
import { queryOne } from '@/utils/db'
import { isTokenRugged, markTokenRug } from '@/utils/rug-list/service'
import {
  loadOwn1mBars,
  getCachedTokenOhlc24h1m,
  tokenOhlcToRugBars,
} from '@/strategies/token-map-chart'
import {
  evaluateRugSignalFrom1m,
  isRugSignalEnabled,
  resolveRugSignalThresholds,
  rugSignalMode,
  type RugSignalEval,
} from '@/strategies/rug-signal'

export type RugSignalDetectResult = {
  /** False when the feature is off, bars were unavailable, or an error occurred. */
  evaluated: boolean
  wrote: boolean
  eval: RugSignalEval | null
  reason: string | null
}

type TrackerRow = {
  current_mcap: number | null
  first_seen_at: string | null
}

type RiskRow = {
  rugcheck_lp_locked_usd: number | null
  gmgn_liquidity_usd: number | null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Accepts an ISO string, or a unix timestamp in seconds or milliseconds. */
function toMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  const n = num(v)
  if (n == null || n <= 0) return null
  return n > 1e12 ? n : n * 1000
}

/**
 * Score one token. Returns `evaluated: false` (with a reason) whenever the feature is
 * off or there were no bars, so callers can tell "not a rug" from "not checked".
 */
export async function detectRugSignal(params: {
  chain: string
  tokenAddress: string
  tokenSymbol?: string | null
  info?: Record<string, unknown> | null
}): Promise<RugSignalDetectResult> {
  if (!isRugSignalEnabled()) {
    return { evaluated: false, wrote: false, eval: null, reason: 'disabled' }
  }

  const mint = params.tokenAddress
  try {
    const [cached, own] = await Promise.all([
      getCachedTokenOhlc24h1m(mint).catch(() => null),
      loadOwn1mBars(mint).catch(() => []),
    ])
    const cachedCandles = cached?.candles ?? []
    const bars1m = tokenOhlcToRugBars(
      cachedCandles.length > 0 ? cachedCandles : own,
    )
    if (bars1m.length === 0) {
      return { evaluated: false, wrote: false, eval: null, reason: 'no bars' }
    }

    const [tracker, risk] = await Promise.all([
      queryOne<TrackerRow>(
        `SELECT current_mcap, first_seen_at FROM token_mcap_tracking
          WHERE token_address = $1 LIMIT 1`,
        [mint],
      ).catch(() => null),
      queryOne<RiskRow>(
        `SELECT rugcheck_lp_locked_usd, gmgn_liquidity_usd FROM token_risk_features
          WHERE chain = $1 AND token_address = $2 LIMIT 1`,
        [params.chain, mint],
      ).catch(() => null),
    ])

    const mcap =
      num(tracker?.current_mcap) ?? num(params.info?.market_cap) ?? null
    const liquidityUsd =
      num(risk?.rugcheck_lp_locked_usd) ??
      num(risk?.gmgn_liquidity_usd) ??
      num(params.info?.liquidity) ??
      num(params.info?.pool_liquidity) ??
      null
    const firstMs =
      toMs(tracker?.first_seen_at) ?? toMs(params.info?.create_timestamp)
    const ageHours = firstMs != null ? (Date.now() - firstMs) / 3_600_000 : null

    const result = evaluateRugSignalFrom1m(
      { bars1m, mcap, liquidityUsd, ageHours },
      resolveRugSignalThresholds(),
    )

    if (!result.isRug) {
      return {
        evaluated: true,
        wrote: false,
        eval: result,
        reason: result.reasons[result.reasons.length - 1] ?? null,
      }
    }

    const mode = rugSignalMode()
    if (mode === 'shadow') {
      console.info('[rug-signal:counterfactual]', {
        mint,
        symbol: params.tokenSymbol ?? null,
        score: result.score,
        breakdown: result.breakdown,
        reasons: result.reasons,
        at: new Date().toISOString(),
      })
      return { evaluated: true, wrote: false, eval: result, reason: 'shadow' }
    }

    if (await isTokenRugged(mint, params.chain as AppNetwork).catch(() => false)) {
      return { evaluated: true, wrote: false, eval: result, reason: 'already rugged' }
    }

    await markTokenRug({
      tokenAddress: mint,
      tokenSymbol: params.tokenSymbol ?? null,
      source: 'rug-signal',
      chain: params.chain as AppNetwork,
    })
    console.info('[rug-signal:trip]', {
      mint,
      symbol: params.tokenSymbol ?? null,
      score: result.score,
      breakdown: result.breakdown,
      at: new Date().toISOString(),
    })
    return { evaluated: true, wrote: true, eval: result, reason: null }
  } catch (error) {
    console.warn('[rug-signal] detect failed', {
      mint,
      error: error instanceof Error ? error.message : String(error),
    })
    return { evaluated: false, wrote: false, eval: null, reason: 'error' }
  }
}
