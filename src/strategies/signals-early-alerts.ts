import type { McapToast } from '@/types/mcap-toasts'
import type { AppNetwork } from '@/utils/app-network'
import { parseDbChain } from '@/utils/app-network-db'
import { formatMcapUsd } from '@/utils/telegram'
import { formatPatternShadowLabel } from './signals-early-pattern-cache'
import type { ScoredSignal } from './signals-pipeline'

export type SignalsEarlyAlert = {
  tokenAddress: string
  tokenSymbol: string
  entryMcap: number
  growthPercent: number
  score: number
  rationale: string
  entryAt: string
  recordedAt: number
  delivered: boolean
  chain: AppNetwork
  /** Pattern ML shadow — display only; never gates Stage-1 */
  mlShadow: true
  pWinner: number | null
  predicted: 'winner' | 'loser' | null
  mlReason: string | null
}

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_BUFFER = 50
const EARLY_GROWTH_CEILING = 100

const recentKeys = new Map<string, number>()
const pending: SignalsEarlyAlert[] = []

function pruneRecentKeys(now: number): void {
  const keysToDelete: string[] = []
  recentKeys.forEach((ts, key) => {
    if (now - ts > DEDUP_WINDOW_MS) keysToDelete.push(key)
  })
  keysToDelete.forEach((key) => recentKeys.delete(key))
}

export function signalsEnterDedupKey(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
): string {
  return `signals_enter:${chain}:${tokenAddress}`
}

export function shouldEmitSignalsEarlyAlert(signal: {
  decision: string
  mcap_growth_percent?: number | null
  is_tracking_stuck?: boolean
  label?: string | null
}): boolean {
  if (signal.decision !== 'enter') return false
  if (signal.is_tracking_stuck === true) return false
  if (signal.label === 'rugged') return false
  const growth = signal.mcap_growth_percent ?? 0
  return growth < EARLY_GROWTH_CEILING
}

export function recordSignalsEarlyAlert(params: {
  tokenAddress: string
  tokenSymbol: string
  entryMcap: number
  growthPercent: number
  score: number
  chain?: AppNetwork | string | null
  rationale?: string
  entryAt?: string
  pWinner?: number | null
  predicted?: 'winner' | 'loser' | null
  mlReason?: string | null
}): SignalsEarlyAlert | null {
  const now = Date.now()
  pruneRecentKeys(now)
  const chain = parseDbChain(params.chain)

  const key = signalsEnterDedupKey(params.tokenAddress, chain)
  const last = recentKeys.get(key)
  if (last && now - last <= DEDUP_WINDOW_MS) return null

  recentKeys.set(key, now)

  const alert: SignalsEarlyAlert = {
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol || 'UNKNOWN',
    entryMcap: params.entryMcap,
    growthPercent: params.growthPercent,
    score: params.score,
    rationale: params.rationale || 'Strong momentum and recency',
    entryAt: params.entryAt || new Date(now).toISOString(),
    recordedAt: now,
    delivered: false,
    chain,
    mlShadow: true,
    pWinner: params.pWinner ?? null,
    predicted: params.predicted ?? null,
    mlReason: params.mlReason ?? null,
  }

  pending.push(alert)
  while (pending.length > MAX_BUFFER) pending.shift()

  return alert
}

/** Attach Pattern ML shadow fields to an already-recorded alert (mutates pending entry). */
export function attachPatternShadowToAlert(
  alert: SignalsEarlyAlert,
  shadow: {
    pWinner: number | null
    predicted: 'winner' | 'loser' | null
    reason?: string | null
  },
): SignalsEarlyAlert {
  alert.pWinner = shadow.pWinner
  alert.predicted = shadow.predicted
  alert.mlReason = shadow.reason ?? null
  alert.mlShadow = true
  return alert
}

export function buildSignalsEarlyToast(alert: SignalsEarlyAlert): McapToast {
  const mcapLabel = formatMcapUsd(alert.entryMcap)
  const growthLabel = `${alert.growthPercent >= 0 ? '+' : ''}${alert.growthPercent.toFixed(1)}%`
  const mlLabel = formatPatternShadowLabel(alert)
  const mlSnippet =
    alert.pWinner != null && Number.isFinite(alert.pWinner)
      ? ` · ML ${mlLabel}`
      : ' · ML n/a'

  return {
    type: 'info',
    category: 'signals_enter',
    title: 'Early Enter',
    message: `${alert.tokenSymbol} ${growthLabel} @ ${mcapLabel} — score ${alert.score.toFixed(0)}${mlSnippet}`,
    key: signalsEnterDedupKey(alert.tokenAddress, alert.chain),
    items: [
      {
        symbol: alert.tokenSymbol,
        address: alert.tokenAddress,
        growthPercent: alert.growthPercent,
        entryMcap: alert.entryMcap,
        entryTemplate: 'signals_enter',
        pWinner: alert.pWinner ?? undefined,
        predicted: alert.predicted ?? undefined,
      },
    ],
  }
}

export function drainSignalsEarlyAlerts(chain: AppNetwork): McapToast[] {
  const undelivered = pending.filter((a) => !a.delivered && a.chain === chain)
  for (const alert of undelivered) {
    alert.delivered = true
  }
  return undelivered.map(buildSignalsEarlyToast)
}

/** Mark pending early toasts delivered without emitting (notify.ui off). */
export function discardPendingSignalsEarlyToasts(tokenAddresses: string[]): void {
  const set = new Set(tokenAddresses)
  for (const alert of pending) {
    if (!alert.delivered && set.has(alert.tokenAddress)) {
      alert.delivered = true
    }
  }
}

/** Emit Stage-1 alerts for eligible scored signals. Returns newly recorded alerts. */
export function emitSignalsEarlyAlertsFromScored(
  signals: ScoredSignal[],
  chain: AppNetwork = 'sol',
): SignalsEarlyAlert[] {
  const recorded: SignalsEarlyAlert[] = []
  for (const signal of signals) {
    if (!shouldEmitSignalsEarlyAlert(signal)) continue
    const alert = recordSignalsEarlyAlert({
      tokenAddress: signal.token_address,
      tokenSymbol: signal.token_symbol,
      entryMcap: signal.current_mcap,
      growthPercent: signal.mcap_growth_percent || 0,
      score: signal.score,
      rationale: signal.rationale,
      entryAt: signal.last_updated_at || signal.first_seen_at,
      pWinner: signal.ml_pattern_p_winner ?? null,
      predicted: signal.ml_pattern_predicted ?? null,
      chain,
    })
    if (alert) recorded.push(alert)
  }
  return recorded
}

/** Test helper — clears in-memory state. */
export function resetSignalsEarlyAlertsForTests(): void {
  recentKeys.clear()
  pending.length = 0
}
