/**
 * Shared paper open: live price required, OHLC rug hard-skip, then
 * closed-loop size and TP/SL. Callers still apply domain extras
 * (brain size scale, overlay audit) after a pass.
 */
import { attachMlEntryShadow } from '@/strategies/ml-entry-shadow'
import { attachOhlcRugShadow } from '@/strategies/ohlc-rug-shadow'
import { loadTargetMachineClScore } from '@/strategies/target-machine-cl-score'
import {
  applyClosedLoopExit,
  sizeFromClosedLoop,
  stampTargetMachineCl,
} from '@/strategies/target-machine-cl-size'
import type { McapEffectiveExit } from '@/utils/mcap-sim-track'
import type { SoftMlSize } from '@/strategies/ml-soft-size'

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
}

export type PrepareTargetMachinePaperOpenResult =
  | {
      ok: false
      stage: PaperSpineStage
      reason: string
    }
  | {
      ok: true
      priceUsd: number
      solAmount: number
      p: number
      sized: SoftMlSize
      effectiveExit: McapEffectiveExit
      features: Record<string, unknown>
    }

export async function prepareTargetMachinePaperOpen(
  input: PrepareTargetMachinePaperOpenInput,
): Promise<PrepareTargetMachinePaperOpenResult> {
  const priceUsd = input.priceUsd
  if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return { ok: false, stage: 'price', reason: 'missing_price' }
  }

  const ohlc = await attachOhlcRugShadow(input.mint, input.features, {
    enforce: true,
  })
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

  return {
    ok: true,
    priceUsd,
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
      initial_price_usd: priceUsd,
    },
  }
}
