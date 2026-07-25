/**
 * Map GMGN token-snapshot / security fields into Axiom-shaped risk for RiskAnalysis.
 */

import type { AxiomTokenInfo, RiskIndicators } from '@/utils/axiom'
import { getRiskIndicators } from '@/utils/axiom'

export type GmgnRiskSnapshotInput = {
  top10HoldPct?: number | null
  devHoldPct?: number | null
  snipersHoldPct?: number | null
  insidersHoldPct?: number | null
  bundlersHoldPct?: number | null
  /** Holder count from GMGN token info when present. */
  holders?: number | null
  isHoneypot?: boolean | null
  marketCap?: number | null
}

function pct(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Flatten GMGN snapshot → AxiomTokenInfo (fees unused on RH → 0). */
export function mapGmgnSnapshotToAxiomData(
  input: GmgnRiskSnapshotInput,
): AxiomTokenInfo {
  return {
    numHolders: Math.max(0, Math.floor(pct(input.holders))),
    numBotUsers: 0,
    top10HoldersPercent: pct(input.top10HoldPct),
    devHoldsPercent: pct(input.devHoldPct),
    insidersHoldPercent: pct(input.insidersHoldPct),
    bundlersHoldPercent: pct(input.bundlersHoldPct),
    snipersHoldPercent: pct(input.snipersHoldPct),
    dexPaid: false,
    totalPairFeesPaid: 0,
  }
}

export function mapGmgnSnapshotToRisk(params: {
  snapshot: GmgnRiskSnapshotInput
  marketCap?: number
}): { axiomData: AxiomTokenInfo; risk: RiskIndicators } {
  const axiomData = mapGmgnSnapshotToAxiomData(params.snapshot)
  const risk = getRiskIndicators(axiomData, params.marketCap ?? params.snapshot.marketCap ?? undefined)
  if (params.snapshot.isHoneypot) {
    return {
      axiomData,
      risk: { ...risk, overallRisk: 'HIGH', feeRisk: 'HIGH' },
    }
  }
  return { axiomData, risk }
}
