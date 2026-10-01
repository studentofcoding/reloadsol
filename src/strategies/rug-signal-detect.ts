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
import { load1mOhlcv, type OhlcvMinute } from '@/strategies/token-metrics-history'
import {
  evaluateRugSignalFrom1m,
  isRugSignalEnabled,
  resolveRugSignalThresholds,
  rugSignalMode,
  type RugSignalBar,
  type RugSignalEval,
} from '@/strategies/rug-signal'

/** Which source the scored bars came from — the difference between "not a rug" and "not fed". */
export type RugSignalBarsSource = 'series' | 'cache' | 'own' | 'none'

export type RugSignalDetectResult = {
  /** False when the feature is off, bars were unavailable, or an error occurred. */
  evaluated: boolean
  wrote: boolean
  eval: RugSignalEval | null
  reason: string | null
  /** Where the bars came from. Only `series` can carry volume, so only `series` feeds the band. */
  barsSource: RugSignalBarsSource
}

/**
 * The metrics series → the scorer's 1m bars.
 *
 * A minute is only a usable bar when all four prices were observed: `aggregateTo5m` drops a bar
 * with a missing o/h/l/c anyway, and without a price there is no shape to score. Volume is carried
 * only when present, so a bucket the source never observed keeps an absent volume instead of a
 * fabricated 0 — the band reads "unknown", not "flat".
 *
 * This is the adapter that makes the 30-point volume band reachable at all: `token_ohlc_bars` has
 * no volume and the 24h cache has it for a handful of mints, so before this the band scored 0 and
 * the signal was capped at 60 < the 80 threshold — it could never trip.
 */
export function ohlcvMinutesToRugBars(minutes: OhlcvMinute[]): RugSignalBar[] {
  const out: RugSignalBar[] = []
  for (const minute of minutes) {
    if (!Number.isFinite(minute?.t)) continue
    const { o, h, l, c, v } = minute
    if (o == null || h == null || l == null || c == null) continue
    out.push({ t: minute.t, o, h, l, c, ...(v != null ? { v } : {}) })
  }
  return out
}

/** Lookback the scorer needs: `windowBars` 5m bars, with slack so a sparse series can still fill it. */
export function rugSignalLookbackMs(windowBars: number): number {
  const bars = Number.isFinite(windowBars) && windowBars > 0 ? windowBars : 20
  return Math.max(bars * 5, 60) * 60_000 * 4
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
    return { evaluated: false, wrote: false, eval: null, reason: 'disabled', barsSource: 'none' }
  }

  const mint = params.tokenAddress
  try {
    const thresholds = resolveRugSignalThresholds()
    const nowMs = Date.now()

    // The series first: it is the only source carrying per-minute volume, so it is the only one that
    // can feed the 30-point band. The older paths stay as fallbacks for minutes that predate the
    // copier — they contribute shape, never volume.
    const [series, cached, own, seriesLiquidity] = await Promise.all([
      load1mOhlcv({
        tokenAddress: mint,
        chain: params.chain,
        fromIso: new Date(nowMs - rugSignalLookbackMs(thresholds.windowBars)).toISOString(),
        toIso: new Date(nowMs).toISOString(),
      }).catch(() => []),
      getCachedTokenOhlc24h1m(mint).catch(() => null),
      loadOwn1mBars(mint).catch(() => []),
      queryOne<{ liquidity_close: number | null }>(
        `SELECT liquidity_close FROM token_metrics_history
          WHERE token_address = $1 AND liquidity_close IS NOT NULL
          ORDER BY hour_bucket DESC LIMIT 1`,
        [mint],
      ).catch(() => null),
    ])

    const seriesBars = ohlcvMinutesToRugBars(series)
    let bars1m: RugSignalBar[] = seriesBars
    let barsSource: RugSignalBarsSource = seriesBars.length > 0 ? 'series' : 'none'
    if (bars1m.length === 0) {
      const cachedCandles = cached?.candles ?? []
      bars1m = tokenOhlcToRugBars(cachedCandles.length > 0 ? cachedCandles : own)
      barsSource = bars1m.length === 0 ? 'none' : cachedCandles.length > 0 ? 'cache' : 'own'
    }
    if (bars1m.length === 0) {
      return { evaluated: false, wrote: false, eval: null, reason: 'no bars', barsSource }
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
      // Last resort: what the copier recorded from GMGN web. Placed last so the existing
      // precedence is untouched; it exists so the C20 band is not inert for a token that has a
      // series but never landed in `token_risk_features`.
      num(seriesLiquidity?.liquidity_close) ??
      null
    const firstMs =
      toMs(tracker?.first_seen_at) ?? toMs(params.info?.create_timestamp)
    const ageHours = firstMs != null ? (Date.now() - firstMs) / 3_600_000 : null

    const result = evaluateRugSignalFrom1m(
      { bars1m, mcap, liquidityUsd, ageHours },
      thresholds,
    )

    if (!result.isRug) {
      return {
        evaluated: true,
        wrote: false,
        eval: result,
        reason: result.reasons[result.reasons.length - 1] ?? null,
        barsSource,
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
        barsSource,
        at: new Date().toISOString(),
      })
      return { evaluated: true, wrote: false, eval: result, reason: 'shadow', barsSource }
    }

    if (await isTokenRugged(mint, params.chain as AppNetwork).catch(() => false)) {
      return {
        evaluated: true,
        wrote: false,
        eval: result,
        reason: 'already rugged',
        barsSource,
      }
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
      barsSource,
      at: new Date().toISOString(),
    })
    return { evaluated: true, wrote: true, eval: result, reason: null, barsSource }
  } catch (error) {
    console.warn('[rug-signal] detect failed', {
      mint,
      error: error instanceof Error ? error.message : String(error),
    })
    return { evaluated: false, wrote: false, eval: null, reason: 'error', barsSource: 'none' }
  }
}
