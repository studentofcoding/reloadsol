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

/**
 * The one risk fetch, both chains — the replacement for the retired Axiom client.
 *
 * Server-side callers (risk-assessment, /api/trending) need an absolute host; browser callers must
 * stay relative so they hit the same origin. The retired Axiom client had the same split.
 *
 * Returns `{ success, data }` deliberately: that is the shape the existing call sites branch on, so
 * moving them off Axiom is an import change rather than a rewrite.
 */
function apiBaseUrl(): string {
  if (typeof window !== 'undefined') return ''
  return process.env.API_HOST || process.env.NEXT_PUBLIC_API_HOST || 'http://localhost:3000'
}

export async function fetchTokenRisk(
  address: string,
  chain: 'sol' | 'robinhood' = 'sol',
  marketCap?: number,
): Promise<{ success: boolean; data?: AxiomTokenInfo; risk?: RiskIndicators; error?: string }> {
  try {
    const q = new URLSearchParams({ chain, address })
    const res = await fetch(`${apiBaseUrl()}/api/gmgn/token-snapshot?${q}`)
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok || json.success !== true) {
      return { success: false, error: (json.error as string) || `HTTP ${res.status}` }
    }
    const snapshot: GmgnRiskSnapshotInput = {
      top10HoldPct: json.top10HoldPct as number | null,
      devHoldPct: json.devHoldPct as number | null,
      snipersHoldPct: json.snipersHoldPct as number | null,
      insidersHoldPct: json.insidersHoldPct as number | null,
      bundlersHoldPct: json.bundlersHoldPct as number | null,
      holders: json.holders as number | null,
      isHoneypot: json.isHoneypot as boolean | null,
      marketCap,
    }
    const mapped = mapGmgnSnapshotToRisk({ snapshot, marketCap })
    return { success: true, data: mapped.axiomData, risk: mapped.risk }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
