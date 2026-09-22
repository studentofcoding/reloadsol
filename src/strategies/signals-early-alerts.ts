import type { McapToast } from '@/types/mcap-toasts'
import type { AppNetwork } from '@/utils/app-network'
import { parseDbChain } from '@/utils/app-network-db'
import { formatMcapUsd } from '@/utils/telegram'
import { formatPatternShadowLabel } from './signals-early-pattern-cache'
import {
  getEarlyEnterMlMin,
  isEarlyEnterMlSoftGateEnabled,
  passesEarlyEnterMlSoftGate,
} from './signals-early-ml-gate'
import {
  isEarlyEnterNoulShadowEnabled,
  isEarlyEnterNoulSoftActiveEnabled,
  resolveEarlyEnterNoulStrategyKey,
  shouldEmitWithNoulSoftActive,
} from './early-enter-noul-shadow'
import { evaluateEarlyEnterNoulShadow } from './early-enter-noul-evaluate'
import type { TypeSafeNoulCallResult } from './typesafe-noul'
import type { EarlyEnterNoulState } from './early-enter-noul-shadow'
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
  /** Closed-loop score that passed the soft gate (display optional) */
  mlClosedLoopScore: number | null
  mlClosedLoopVersion: string | null
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
  mlClosedLoopScore?: number | null
  mlClosedLoopVersion?: string | null
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
    mlClosedLoopScore:
      params.mlClosedLoopScore != null && Number.isFinite(params.mlClosedLoopScore)
        ? params.mlClosedLoopScore
        : null,
    mlClosedLoopVersion: params.mlClosedLoopVersion ?? null,
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
  const clSnippet =
    alert.mlClosedLoopScore != null && Number.isFinite(alert.mlClosedLoopScore)
      ? ` · cl ${alert.mlClosedLoopScore.toFixed(2)}`
      : ''

  return {
    type: 'info',
    category: 'signals_enter',
    title: 'Early Enter',
    message: `${alert.tokenSymbol} ${growthLabel} @ ${mcapLabel} — score ${alert.score.toFixed(0)}${mlSnippet}${clSnippet}`,
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
  opts?: { mlSoftGateEnabled?: boolean; mlMin?: number },
): SignalsEarlyAlert[] {
  const gateEnabled = opts?.mlSoftGateEnabled ?? isEarlyEnterMlSoftGateEnabled()
  const mlMin = opts?.mlMin ?? getEarlyEnterMlMin()
  const recorded: SignalsEarlyAlert[] = []
  for (const signal of signals) {
    if (!shouldEmitSignalsEarlyAlert(signal)) continue
    // Soft gate before record so a suppress does not burn the 24h dedup key.
    if (
      !passesEarlyEnterMlSoftGate(signal.ml_closed_loop_score, {
        enabled: gateEnabled,
        min: mlMin,
      })
    ) {
      continue
    }
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
      mlClosedLoopScore: signal.ml_closed_loop_score ?? null,
      mlClosedLoopVersion: signal.ml_closed_loop_version ?? null,
      chain,
    })
    if (alert) recorded.push(alert)
  }
  return recorded
}


export type EmitEarlyEnterOpts = {
  mlSoftGateEnabled?: boolean
  mlMin?: number
  /** Active mcap strategy ids for Noul arm scope (first_seen / at_80 / _rh). */
  activeNoulStrategyKeys?: Iterable<string>
  noulShadowEnabled?: boolean
  noulSoftActive?: boolean
  /** Injectable TypeSafe call for tests. */
  callNoul?: (
    state: EarlyEnterNoulState,
  ) => Promise<TypeSafeNoulCallResult>
}

/**
 * Stage-1 Early Enter emit with optional Jev Noul shadow beside the soft gate.
 * Shadow rows only for locked mcap arms; toast stays SPEC-owned until soft-active.
 * Paper / sim-open never call this with Noul — keep those paths on the sync helper.
 */
export async function emitSignalsEarlyAlertsFromScoredAsync(
  signals: ScoredSignal[],
  chain: AppNetwork = 'sol',
  opts?: EmitEarlyEnterOpts,
): Promise<SignalsEarlyAlert[]> {
  const gateEnabled = opts?.mlSoftGateEnabled ?? isEarlyEnterMlSoftGateEnabled()
  const mlMin = opts?.mlMin ?? getEarlyEnterMlMin()
  const shadowEnabled = opts?.noulShadowEnabled ?? isEarlyEnterNoulShadowEnabled()
  const softActive = opts?.noulSoftActive ?? isEarlyEnterNoulSoftActiveEnabled()
  const activeKeys = opts?.activeNoulStrategyKeys

  const recorded: SignalsEarlyAlert[] = []
  for (const signal of signals) {
    if (!shouldEmitSignalsEarlyAlert(signal)) continue

    const growth = signal.mcap_growth_percent || 0
    const specWouldPass = passesEarlyEnterMlSoftGate(signal.ml_closed_loop_score, {
      enabled: gateEnabled,
      min: mlMin,
    })

    let band: import('./early-enter-noul-shadow').NoulShadowBand | null = null

    if (shadowEnabled && activeKeys) {
      const strategyKey = resolveEarlyEnterNoulStrategyKey({
        chain,
        growthPercent: growth,
        activeStrategyKeys: activeKeys,
      })
      if (strategyKey) {
        try {
          const evalResult = await evaluateEarlyEnterNoulShadow({
            tokenAddress: signal.token_address,
            symbol: signal.token_symbol,
            chain,
            strategyKey,
            clMlScore: signal.ml_closed_loop_score,
            clModelVersion: signal.ml_closed_loop_version,
            mlSoftGateEnabled: gateEnabled,
            mlMin,
            callNoul: opts?.callNoul,
          })
          band = evalResult.band
        } catch (err) {
          // Never throw past Early Enter emit — treat as soft-fail → SPEC.
          console.error('[early-enter-noul] evaluate failed:', err)
          band = 'api_miss'
        }
      }
    }

    const shouldEmit = shouldEmitWithNoulSoftActive({
      specWouldPass,
      softActive: softActive && band != null,
      band,
    })
    if (!shouldEmit) continue

    const alert = recordSignalsEarlyAlert({
      tokenAddress: signal.token_address,
      tokenSymbol: signal.token_symbol,
      entryMcap: signal.current_mcap,
      growthPercent: growth,
      score: signal.score,
      rationale: signal.rationale,
      entryAt: signal.last_updated_at || signal.first_seen_at,
      pWinner: signal.ml_pattern_p_winner ?? null,
      predicted: signal.ml_pattern_predicted ?? null,
      mlClosedLoopScore: signal.ml_closed_loop_score ?? null,
      mlClosedLoopVersion: signal.ml_closed_loop_version ?? null,
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
