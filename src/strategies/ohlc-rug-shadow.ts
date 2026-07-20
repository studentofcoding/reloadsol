import { fetchLastOhlcRugBars } from '@/strategies/detect-snapshots'
import {
  evaluateOhlcRugRules,
  ohlcRugHitReasons,
  type OhlcRugEval,
} from '@/strategies/ohlc-rug-rules'

export type AttachOhlcRugShadowResult = {
  features: Record<string, unknown>
  reject: boolean
  reason: string | null
  trip: boolean
  evalResult: OhlcRugEval | null
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
 * Default enforce=false — never blocks. Flip enforce later to hard-reject.
 */
export async function attachOhlcRugShadow(
  tokenAddress: string,
  entryFeatures: Record<string, unknown>,
  opts?: { enforce?: boolean },
): Promise<AttachOhlcRugShadowResult> {
  const enforce = opts?.enforce === true

  try {
    const { bars } = await fetchLastOhlcRugBars(tokenAddress)
    if (bars.length === 0) {
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
      }
    }

    const evalResult = evaluateOhlcRugRules(bars)
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
    }
  } catch {
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
    }
  }
}
