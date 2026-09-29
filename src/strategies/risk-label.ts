/**
 * Shared shadow risk-label contract — the one shape every display layer renders.
 *
 * Composed from RugCheck features + dev reputation. In shadow mode every rendered
 * line carries a "(shadow)" suffix so nothing reads as enforced. Pure; no IO.
 */

import type { RugcheckFeatures } from '@/strategies/rugcheck-features'
import type { DevReputation, DevVerdict } from '@/strategies/dev-reputation'

export type RiskLabel = {
  rugcheck: string | null
  devRep: string | null
  verdict: DevVerdict
  shadow: boolean
  reasons: string[]
}

export type RiskChipTone = 'red' | 'amber' | 'emerald' | 'gray'

export function composeRiskLabel(params: {
  rugcheck?: RugcheckFeatures | null
  dev?: DevReputation | null
  shadow: boolean
}): RiskLabel {
  const { rugcheck, dev, shadow } = params

  const rugParts: string[] = []
  if (rugcheck?.available) {
    rugParts.push(
      rugcheck.scoreNormalised != null
        ? `${Math.round(rugcheck.scoreNormalised)}/100`
        : 'score n/a',
    )
    rugParts.push(
      rugcheck.riskNames.length > 0
        ? rugcheck.riskNames.slice(0, 2).join(', ')
        : 'no listed risks',
    )
    if (rugcheck.graphInsidersDetected != null && rugcheck.graphInsidersDetected > 0) {
      rugParts.push(`insiders ${rugcheck.graphInsidersDetected}`)
    }
    if (rugcheck.lpLockedPct != null) {
      rugParts.push(`LP locked ${rugcheck.lpLockedPct.toFixed(0)}%`)
    }
  }

  const devParts: string[] = []
  if (dev) {
    devParts.push(dev.verdict)
    if (dev.reasons[0]) devParts.push(dev.reasons[0])
  }

  const rugcheckText = rugParts.length > 0 ? rugParts.join(' · ') : null
  const devRepText = devParts.length > 0 ? devParts.join(' · ') : null

  return {
    rugcheck: rugcheckText,
    devRep: devRepText,
    verdict: dev?.verdict ?? 'unknown',
    shadow,
    reasons: [
      ...(rugcheckText ? [`rugcheck ${rugcheckText}`] : []),
      ...(devRepText ? [`dev ${devRepText}`] : []),
    ],
  }
}

/** Reason lines for Telegram / summaries, with the shadow suffix applied. */
export function riskLabelLines(label: RiskLabel | null | undefined): string[] {
  if (!label) return []
  const suffix = label.shadow ? ' (shadow)' : ''
  return label.reasons.map((line) => `${line}${suffix}`)
}

/** Compact chip for tiles / lists. */
export function riskLabelChip(
  label: RiskLabel | null | undefined,
): { text: string; tone: RiskChipTone } | null {
  if (!label) return null
  const parts: string[] = []
  if (label.verdict !== 'unknown') parts.push(`dev ${label.verdict}`)
  if (label.rugcheck) parts.push(label.rugcheck)
  if (parts.length === 0) return null
  const suffix = label.shadow ? ' (shadow)' : ''
  return { text: `${parts.join(' · ')}${suffix}`, tone: riskTone(label) }
}

function riskTone(label: RiskLabel): RiskChipTone {
  if (label.verdict === 'ban') return 'red'
  if (label.verdict === 'good') return 'emerald'
  return 'gray'
}
