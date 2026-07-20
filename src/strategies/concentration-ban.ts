import {
  buildGmgnTokenSnapshot,
  type GmgnTokenSnapshot,
} from '@/strategies/gmgn-token-snapshot'
import { closeOpenSimsForRadarDump } from '@/strategies/gmgn-radar-dump'
import { captureDetectSnapshot } from '@/strategies/detect-snapshots'
import { markTokenRug } from '@/utils/rug-list/service'

/** Hard ban when any axis is strictly greater than this percent. */
export const CONCENTRATION_BAN_PCT = 50

export type ConcentrationBanEval = {
  ban: boolean
  reasons: string[]
}

export function evaluateConcentrationBan(
  metrics: Pick<
    GmgnTokenSnapshot,
    'top10HoldPct' | 'devHoldPct' | 'bundlersHoldPct'
  >,
): ConcentrationBanEval {
  const reasons: string[] = []
  const check = (label: string, pct: number | null) => {
    if (pct == null || !Number.isFinite(pct)) return
    if (pct > CONCENTRATION_BAN_PCT) {
      reasons.push(`${label} ${pct.toFixed(1)}% > ${CONCENTRATION_BAN_PCT}%`)
    }
  }
  check('Top 10 H.', metrics.top10HoldPct)
  check('Dev H.', metrics.devHoldPct)
  check('Bundlers H.', metrics.bundlersHoldPct)
  return { ban: reasons.length > 0, reasons }
}

export type BanConcentrationResult = {
  banned: boolean
  reasons: string[]
  alreadyRugged?: boolean
  closedSims?: number
}

/**
 * If concentration thresholds trip, markTokenRug immediately and close open sims.
 */
export async function banConcentrationIfNeeded(params: {
  tokenAddress: string
  tokenSymbol?: string | null
  info: Record<string, unknown>
  security: Record<string, unknown>
  closeSims?: boolean
}): Promise<BanConcentrationResult> {
  const snapshot = buildGmgnTokenSnapshot(params.info, params.security)
  const { ban, reasons } = evaluateConcentrationBan(snapshot)
  if (!ban) return { banned: false, reasons: [] }

  await markTokenRug({
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol,
    source: 'concentration',
  })

  // ponytail: OHLC snapshot is best-effort; ban must not fail if ST/OHLC is down
  let allReasons = reasons
  try {
    const snap = await captureDetectSnapshot({
      tokenAddress: params.tokenAddress,
      source: 'concentration',
    })
    if (snap.reasons.length > 0) {
      allReasons = [...reasons, ...snap.reasons]
    }
  } catch {
    /* ignore */
  }

  let closedSims = 0
  if (params.closeSims !== false) {
    const { closed } = await closeOpenSimsForRadarDump({
      tokenAddress: params.tokenAddress,
      tokenSymbol: params.tokenSymbol,
    })
    closedSims = closed
  }

  return { banned: true, reasons: allReasons, closedSims }
}
