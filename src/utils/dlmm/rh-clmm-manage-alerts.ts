/**
 * Pure alert helpers for the RH CLMM alert-only manage cycle (rec 3.1 phase A).
 * Kept free of server-only imports so they are unit-testable.
 */

export type RhClmmManageAlertKind = 'oor' | 'fees'

export function rhClmmManageAlertKey(
  owner: string,
  tokenId: string,
  kind: RhClmmManageAlertKind,
): string {
  return `rh-clmm-manage:alert:v1:${owner.trim().toLowerCase()}:${tokenId}:${kind}`
}

export function shouldAlertFees(feesUsd: number, thresholdUsd: number): boolean {
  return Number.isFinite(feesUsd) && feesUsd >= thresholdUsd && thresholdUsd > 0
}

export function formatRhClmmManageAlert(params: {
  kind: RhClmmManageAlertKind
  pairLabel: string
  protocol: string
  tokenId: string
  owner: string
  tickLower?: number | null
  tickUpper?: number | null
  currentTick?: number | null
  unclaimedFeesUsd?: number | null
}): string {
  const title =
    params.kind === 'oor'
      ? '⚠️ <b>RH CLMM out of range</b>'
      : '💰 <b>RH CLMM fees ready to claim</b>'
  const lines = [
    title,
    '',
    `<b>${params.pairLabel}</b> [${params.protocol}]`,
    `Position: <code>#${params.tokenId}</code>`,
    `Owner: <code>${params.owner.slice(0, 10)}…</code>`,
  ]
  if (params.kind === 'oor') {
    lines.push(
      `Tick: ${params.currentTick ?? '?'} outside [${params.tickLower ?? '?'}, ${params.tickUpper ?? '?'}]`,
      'Action: review position — claim/close from the app.',
    )
  } else {
    lines.push(
      `Unclaimed fees: ~$${(params.unclaimedFeesUsd ?? 0).toFixed(2)}`,
      'Action: claim fees from the app (no server signer yet).',
    )
  }
  return lines.join('\n')
}
