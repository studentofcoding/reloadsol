import { fetchLastOhlcRugBars } from '@/strategies/detect-snapshots'
import {
  evaluateOhlcRugRules,
  ohlcRugHitReasons,
  OHLC_RUG_MAX_BARS,
  type OhlcRugBar,
  type OhlcRugEval,
} from '@/strategies/ohlc-rug-rules'

export type AttachOhlcRugShadowResult = {
  features: Record<string, unknown>
  reject: boolean
  reason: string | null
  trip: boolean
  evalResult: OhlcRugEval | null
  /** Bars used, so the caller can persist them without a second fetch. */
  bars: OhlcRugBar[]
  source: string
}

export function mergeOhlcRugIntoEntryFeatures(
  entryFeatures: Record<string, unknown>,
  evalResult: OhlcRugEval,
  scoredAt = new Date().toISOString(),
): Record<string, unknown> {
  const hitIds = evalResult.hits.filter((h) => h.passed).map((h) => h.id)
  return {
    ...entryFeatures,
    ohlc_rug_shadow_at: scoredAt,
    ohlc_rug_trip: evalResult.trip ? 1 : 0,
    ohlc_rug_would_reject: evalResult.trip ? 1 : 0,
    ohlc_rug_n: evalResult.features.n,
    ohlc_rug_dump_pct: evalResult.features.dumpPct,
    ohlc_rug_avg_upper_wick: evalResult.features.avgUpperWick,
    ohlc_rug_vol_death: evalResult.features.volDeathRatio,
    ohlc_rug_up_only_count: evalResult.features.upOnlyCount,
    ohlc_rug_hits: hitIds,
  }
}

export function logOhlcRugCounterfactual(input: {
  mintAddress: string
  trip: boolean
  hits: string[]
  dumpPct: number | null
  reason?: string | null
}): void {
  console.info('[ohlc-rug:counterfactual]', {
    mint: input.mintAddress,
    trip: input.trip,
    hits: input.hits,
    dump_pct: input.dumpPct,
    reason: input.reason ?? null,
    at: new Date().toISOString(),
  })
}

/**
 * OHLC rug hard-rules as first-check shadow on entry features.
 * Bars come from getCachedTokenOhlc24h1m (brain 1m when MARKET_BRAIN_OHLC is on).
 * `fallbackOwn1m` also reads our own `token_ohlc_bars` series when the cache is
 * empty — opt-in, so gmgn/signals stay canonical (Freeview and social opt in).
 * Default enforce=false — never blocks. Flip enforce later to hard-reject.
 * Correlation / Freeview outcome paint stays on buy_bulk.
 */
/** Bars + rule evaluation for a mint — the expensive, entry-feature-independent half. */
export type OhlcRugShadowBase = {
  bars: OhlcRugBar[]
  evalResult: OhlcRugEval | null
  source: string
}

export type OhlcRugShadowMemo = Map<string, Promise<OhlcRugShadowBase>>

/**
 * Fetch the bars and evaluate the rules — the part that goes through the shared, rate-gated
 * market-data path (measured ~1.07 s per call, i.e. the GMGN gate at 1.4 rps).
 *
 * It does not depend on the caller's entry features, so a caller evaluating the same mint for
 * several strategies can share a `memo` and pay that fetch **once per run** instead of once per
 * strategy. Pass a fresh Map per request: this gates an entry, so it must not go stale across
 * requests.
 */
export async function loadOhlcRugShadowBase(
  tokenAddress: string,
  opts?: { fallbackOwn1m?: boolean; memo?: OhlcRugShadowMemo },
): Promise<OhlcRugShadowBase> {
  const memoKey = `${tokenAddress}|${opts?.fallbackOwn1m === true ? 'own' : 'canonical'}`
  const memo = opts?.memo
  const cached = memo?.get(memoKey)
  if (cached) return cached

  const load = (async (): Promise<OhlcRugShadowBase> => {
    try {
      const { bars, source } = await fetchLastOhlcRugBars(tokenAddress, OHLC_RUG_MAX_BARS, {
        fallbackOwn1m: opts?.fallbackOwn1m === true,
      })
      if (bars.length === 0) return { bars: [], evalResult: null, source: source || 'none' }
      return { bars, evalResult: evaluateOhlcRugRules(bars), source: source || 'none' }
    } catch {
      return { bars: [], evalResult: null, source: 'error' }
    }
  })()

  memo?.set(memoKey, load)
  return load
}

export async function attachOhlcRugShadow(
  tokenAddress: string,
  entryFeatures: Record<string, unknown>,
  opts?: { enforce?: boolean; fallbackOwn1m?: boolean; memo?: OhlcRugShadowMemo },
): Promise<AttachOhlcRugShadowResult> {
  const enforce = opts?.enforce === true
  const { bars, evalResult, source } = await loadOhlcRugShadowBase(tokenAddress, {
    fallbackOwn1m: opts?.fallbackOwn1m,
    memo: opts?.memo,
  })

  if (!evalResult) {
    return {
      features: {
        ...entryFeatures,
        ohlc_rug_skipped: 'no_bars_or_error',
        ohlc_rug_shadow_at: new Date().toISOString(),
      },
      reject: false,
      reason: null,
      trip: false,
      evalResult: null,
      bars,
      source,
    }
  }

  const features = mergeOhlcRugIntoEntryFeatures(entryFeatures, evalResult)
  const reasons = ohlcRugHitReasons(evalResult)
  const reason = reasons.length > 0 ? reasons.join('; ') : null

  if (evalResult.trip) {
    logOhlcRugCounterfactual({
      mintAddress: tokenAddress,
      trip: true,
      hits: (features.ohlc_rug_hits as string[]) ?? [],
      dumpPct: evalResult.features.dumpPct,
      reason,
    })
  }

  const reject = enforce && evalResult.trip
  return {
    features,
    reject,
    reason: reject ? reason : null,
    trip: evalResult.trip,
    evalResult,
    bars,
    source,
  }
}
