/**
 * Target machine Stage-3: size + TP/SL from closed-loop mlScore `p`.
 * Missing p → 0.5 (continue sizing; no hard gate).
 */
import { softMlSize, stampMlSize, type SoftMlSize } from '@/strategies/ml-soft-size'

const TP_MIN = 10
const SL_MIN = 5

export function resolveClosedLoopP(raw: number | null | undefined): number {
  if (raw != null && Number.isFinite(raw)) return Math.min(1, Math.max(0, raw))
  return 0.5
}

export function closedLoopExitMults(p: number): { tpMult: number; slMult: number } {
  const clamped = resolveClosedLoopP(p)
  return {
    tpMult: 0.8 + 0.4 * clamped,
    slMult: 1.2 - 0.4 * clamped,
  }
}

export function applyClosedLoopExit(
  base: { takeProfitPct: number; stopLossPct: number },
  pRaw: number | null | undefined,
): {
  takeProfitPct: number
  stopLossPct: number
  tpMult: number
  slMult: number
  p: number
} {
  const p = resolveClosedLoopP(pRaw)
  const { tpMult, slMult } = closedLoopExitMults(p)
  return {
    p,
    tpMult,
    slMult,
    takeProfitPct: Math.max(TP_MIN, base.takeProfitPct * tpMult),
    stopLossPct: Math.max(SL_MIN, base.stopLossPct * slMult),
  }
}

export function sizeFromClosedLoop(
  baseSol: number,
  pRaw: number | null | undefined,
): SoftMlSize & { p: number } {
  const p = resolveClosedLoopP(pRaw)
  const sized = softMlSize(baseSol, { pBad: 1 - p })
  return { ...sized, p }
}

export function stampTargetMachineCl(
  features: Record<string, unknown>,
  opts: {
    p: number
    sized: SoftMlSize
    exit?: {
      takeProfitPct: number
      stopLossPct: number
      tpMult: number
      slMult: number
    }
    modelVersion?: string | null
  },
): Record<string, unknown> {
  return {
    ...stampMlSize(features, opts.sized),
    cl_p: opts.p,
    ...(opts.modelVersion != null ? { cl_model_version: opts.modelVersion } : {}),
    ...(opts.exit
      ? {
          cl_take_profit_pct: opts.exit.takeProfitPct,
          cl_stop_loss_pct: opts.exit.stopLossPct,
          cl_tp_mult: opts.exit.tpMult,
          cl_sl_mult: opts.exit.slMult,
        }
      : {}),
  }
}
