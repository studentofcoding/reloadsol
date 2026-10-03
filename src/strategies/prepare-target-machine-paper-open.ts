/**
 * Shared paper open: live price required, OHLC rug hard-skip, then
 * closed-loop size and TP/SL. Callers still apply domain extras
 * (brain size scale, overlay audit) after a pass.
 */
import { attachMlEntryShadow } from '@/strategies/ml-entry-shadow'
import {
  attachOhlcRugShadow,
  type AttachOhlcRugShadowResult,
} from '@/strategies/ohlc-rug-shadow'
import { loadTargetMachineClScore } from '@/strategies/target-machine-cl-score'
import {
  applyClosedLoopExit,
  sizeFromClosedLoop,
  stampTargetMachineCl,
} from '@/strategies/target-machine-cl-size'
import type { McapEffectiveExit } from '@/utils/mcap-sim-track'
import type { SoftMlSize } from '@/strategies/ml-soft-size'
import { impactedEntryPriceUsd, type ExitBasis } from './sim-exit-contract'
import { isOpenRetryPolicyEnabled, runOpenWithRetry } from './open-attempts'

export type PaperSpineStage = 'price' | 'rug' | 'size'

export type PrepareTargetMachinePaperOpenInput = {
  mint: string
  chain: 'sol' | 'robinhood'
  features: Record<string, unknown>
  priceUsd: number | null | undefined
  baseSol: number
  baseExit: {
    takeProfitPct: number
    stopLossPct: number
    maxHoldHours: number
  }
  entryMcap?: number | null
  /** Also read our own 1m `token_ohlc_bars` when the 24h cache is empty. */
  fallbackOwn1m?: boolean
  /** Caller already resolved the OHLC shadow (e.g. for a Noul state) — reuse it. */
  precomputedOhlc?: AttachOhlcRugShadowResult
  /** Names the strategy in `position_open_attempts` / retry logs. Optional; defaults to 'spine'. */
  strategyId?: string
  /** Fresh spot price for the failed-open retry (OPEN_RETRY_POLICY=1). Default: Jupiter market hints. */
  refetchPriceUsd?: () => Promise<number | null | undefined>
}

export type PrepareTargetMachinePaperOpenResult =
  | {
      ok: false
      stage: PaperSpineStage
      reason: string
    }
  | {
      ok: true
      /**
       * The price actually paid (S10): the quote plus the modelled impact. This is the ONLY entry
       * price the caller may use — for the record, the features and the exit contract alike.
       */
      priceUsd: number
      /** What the thresholds are expressed in. 'price' today; the value that makes it declarable. */
      exitBasis: ExitBasis
      solAmount: number
      p: number
      sized: SoftMlSize
      effectiveExit: McapEffectiveExit
      features: Record<string, unknown>
      ohlcBars: AttachOhlcRugShadowResult['bars']
      ohlcSource: string
    }

/**
 * Entry point for every paper open. With `OPEN_RETRY_POLICY=1` a failed try (threw, or no price) is
 * retried twice and a price that moved > 5 % since the last failed try fails loudly and skips
 * (SPEC-open-attempts-reporting-v1). Off by default: identical to a single call.
 */
export async function prepareTargetMachinePaperOpen(
  input: PrepareTargetMachinePaperOpenInput,
): Promise<PrepareTargetMachinePaperOpenResult> {
  if (!isOpenRetryPolicyEnabled()) return prepareTargetMachinePaperOpenOnce(input)
  return runOpenWithRetry<PrepareTargetMachinePaperOpenResult>({
    strategyId: input.strategyId ?? 'spine',
    chain: input.chain,
    mint: input.mint,
    initialPriceUsd: input.priceUsd,
    attempt: (priceUsd) => prepareTargetMachinePaperOpenOnce({ ...input, priceUsd }),
    refetchPriceUsd:
      input.refetchPriceUsd ??
      (async () => {
        const { fetchJupiterMarketHints } = await import('@/utils/jupiter-metadata')
        return (await fetchJupiterMarketHints(input.mint))?.usdPrice ?? null
      }),
  })
}

async function prepareTargetMachinePaperOpenOnce(
  input: PrepareTargetMachinePaperOpenInput,
): Promise<PrepareTargetMachinePaperOpenResult> {
  const priceUsd = input.priceUsd
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return { ok: false, stage: 'price', reason: 'missing_price' }
  }

  const ohlc =
    input.precomputedOhlc ??
    (await attachOhlcRugShadow(input.mint, input.features, {
      enforce: true,
      fallbackOwn1m: input.fallbackOwn1m === true,
    }))
  if (ohlc.reject) {
    return {
      ok: false,
      stage: 'rug',
      reason: `ohlc_rug (${ohlc.reason ?? 'trip'})`,
    }
  }

  const ml = await attachMlEntryShadow(ohlc.features, { enforce: false })
  const cl = await loadTargetMachineClScore({
    mint: input.mint,
    chain: input.chain,
    entryMcap: input.entryMcap ?? null,
  })
  const sized = sizeFromClosedLoop(input.baseSol, cl.mlScore)
  if (!(sized.sol > 0)) {
    return { ok: false, stage: 'size', reason: 'size_stand_down' }
  }

  const clExit = applyClosedLoopExit(
    {
      takeProfitPct: input.baseExit.takeProfitPct,
      stopLossPct: input.baseExit.stopLossPct,
    },
    sized.p,
  )
  const features = stampTargetMachineCl(ml.features, {
    p: sized.p,
    sized,
    exit: clExit,
    modelVersion: cl.modelVersion,
  })

  // ONE price (S10): what this size would actually have paid, impact included.
  //
  // Every consumer reads this same value — the trading record, the entry features, and the exit
  // contract — because the alternative is what the system had until now: the record valuing the
  // position at the market quote while the exit measured from the fill, so the recorded PnL and the
  // trigger disagreed about the entry by exactly the impact.
  const entryPriceUsd = impactedEntryPriceUsd({
    spotPriceUsd: priceUsd,
    notionalQuote: sized.sol,
  })

  return {
    ok: true,
    priceUsd: entryPriceUsd,
    exitBasis: 'price',
    solAmount: sized.sol,
    p: sized.p,
    sized,
    effectiveExit: {
      takeProfitPct: clExit.takeProfitPct,
      stopLossPct: clExit.stopLossPct,
      maxHoldHours: input.baseExit.maxHoldHours,
    },
    features: {
      ...features,
      // The same one price, so the feature snapshot cannot disagree with the record or the contract.
      initial_price_usd: entryPriceUsd,
    },
    ohlcBars: ohlc.bars,
    ohlcSource: ohlc.source,
  }
}
