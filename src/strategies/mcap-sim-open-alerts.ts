import type { McapToast } from '@/types/mcap-toasts'
import { formatMcapUsd } from '@/utils/telegram'

export const MCAP_MANUAL_TRADE_STRATEGIES = [
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
] as const

export type McapManualTradeStrategyId = (typeof MCAP_MANUAL_TRADE_STRATEGIES)[number]

export type McapSimOpenAlert = {
  strategyId: McapManualTradeStrategyId
  strategyName: string
  tokenAddress: string
  tokenSymbol: string
  entryMcap: number
  entryAt: string
  entryTemplate: 'first_seen' | 'milestone_80'
  recordedAt: number
  delivered: boolean
}

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000
/** Recent alerts stay peekable for UI poll without one-shot consume. */
const PEEK_WINDOW_MS = 90_000
const MAX_BUFFER = 50

const recentKeys = new Map<string, number>()
const pending: McapSimOpenAlert[] = []

export function isMcapManualTradeStrategy(
  strategyId: string,
): strategyId is McapManualTradeStrategyId {
  return (MCAP_MANUAL_TRADE_STRATEGIES as readonly string[]).includes(strategyId)
}

export function strategyLabelForManualTrade(
  strategyId: McapManualTradeStrategyId,
): string {
  if (
    strategyId === 'mcap_enter_at_80' ||
    strategyId === 'mcap_enter_at_80_rh'
  ) {
    return strategyId.endsWith('_rh')
      ? 'Enter at 80% milestone (RH)'
      : 'Enter at 80% milestone'
  }
  return strategyId.endsWith('_rh')
    ? 'Enter at first seen (RH)'
    : 'Enter at first seen'
}

function pruneRecentKeys(now: number): void {
  const keysToDelete: string[] = []
  recentKeys.forEach((ts, key) => {
    if (now - ts > DEDUP_WINDOW_MS) keysToDelete.push(key)
  })
  keysToDelete.forEach((key) => recentKeys.delete(key))
}

export function simOpenDedupKey(strategyId: string, tokenAddress: string): string {
  return `sim_open:${strategyId}:${tokenAddress}`
}

export function recordSimOpenAlert(params: {
  strategyId: string
  tokenAddress: string
  tokenSymbol: string
  entryMcap: number
  entryAt: string
  entryTemplate: 'first_seen' | 'milestone_80'
}): McapSimOpenAlert | null {
  if (!isMcapManualTradeStrategy(params.strategyId)) return null

  const now = Date.now()
  pruneRecentKeys(now)

  const key = simOpenDedupKey(params.strategyId, params.tokenAddress)
  const last = recentKeys.get(key)
  if (last && now - last <= DEDUP_WINDOW_MS) return null

  recentKeys.set(key, now)

  const alert: McapSimOpenAlert = {
    strategyId: params.strategyId,
    strategyName: strategyLabelForManualTrade(params.strategyId),
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol || 'UNKNOWN',
    entryMcap: params.entryMcap,
    entryAt: params.entryAt,
    entryTemplate: params.entryTemplate,
    recordedAt: now,
    delivered: false,
  }

  pending.push(alert)
  while (pending.length > MAX_BUFFER) pending.shift()

  return alert
}

export function buildSimOpenToast(alert: McapSimOpenAlert): McapToast {
  const mcapLabel = formatMcapUsd(alert.entryMcap)
  return {
    type: 'success',
    category: 'sim_open',
    title: 'Mcap Sim Open',
    message: `${alert.strategyName} — ${alert.tokenSymbol} @ ${mcapLabel} entry mcap`,
    key: simOpenDedupKey(alert.strategyId, alert.tokenAddress),
    items: [
      {
        symbol: alert.tokenSymbol,
        address: alert.tokenAddress,
        growthPercent: 0,
        strategyId: alert.strategyId,
        entryMcap: alert.entryMcap,
        entryTemplate: alert.entryTemplate,
      },
    ],
  }
}

function prunePending(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].recordedAt > PEEK_WINDOW_MS) {
      pending.splice(i, 1)
    }
  }
}

export function drainSimOpenAlerts(): McapToast[] {
  const now = Date.now()
  prunePending(now)
  return pending
    .filter((a) => now - a.recordedAt <= PEEK_WINDOW_MS)
    .map(buildSimOpenToast)
}

/** Test helper — clears in-memory state. */
export function resetSimOpenAlertsForTests(): void {
  recentKeys.clear()
  pending.length = 0
}
