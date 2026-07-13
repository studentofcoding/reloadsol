/** Config-driven Radar drawdown death + comeback stages. */

import type { GmgnRadarComebackConfig } from './types'

export function evaluateRadarDrawdownDeath(params: {
  config: GmgnRadarComebackConfig
  peakMcapUsd: number | null
  currentMcapUsd: number | null
}): { isDead: boolean; reasons: string[] } {
  const { config, peakMcapUsd, currentMcapUsd } = params
  if (!config.enabled) return { isDead: false, reasons: [] }
  if (
    peakMcapUsd == null ||
    currentMcapUsd == null ||
    !Number.isFinite(peakMcapUsd) ||
    !Number.isFinite(currentMcapUsd) ||
    peakMcapUsd <= 0 ||
    currentMcapUsd <= 0
  ) {
    return { isDead: false, reasons: [] }
  }

  const reasons: string[] = []
  const dropPct = ((peakMcapUsd - currentMcapUsd) / peakMcapUsd) * 100
  if (dropPct >= config.drawdownPct) {
    reasons.push(
      `drawdown ${dropPct.toFixed(1)}% ≥ ${config.drawdownPct}% (peak $${Math.round(peakMcapUsd).toLocaleString()} → $${Math.round(currentMcapUsd).toLocaleString()})`,
    )
  }
  if (
    currentMcapUsd <= config.troughMcapMax &&
    peakMcapUsd > config.troughMcapMax
  ) {
    reasons.push(
      `trough mcap $${Math.round(currentMcapUsd).toLocaleString()} ≤ $${config.troughMcapMax.toLocaleString()} after peak $${Math.round(peakMcapUsd).toLocaleString()}`,
    )
  }

  return { isDead: reasons.length > 0, reasons }
}

/**
 * Comeback after a dead lifecycle: recover from trough + min score.
 * Does not edit/delete the dead Telegram card — caller opens a new thread.
 */
export function evaluateRadarComeback(params: {
  config: GmgnRadarComebackConfig
  radarScore: number
  troughMcapUsd: number | null
  currentMcapUsd: number | null
  /** Most recent thread for mint is dead (no open thread). */
  hasDeadLifecycle: boolean
}): { isComeback: boolean; reasons: string[] } {
  const { config, radarScore, troughMcapUsd, currentMcapUsd, hasDeadLifecycle } =
    params
  if (!config.enabled) return { isComeback: false, reasons: [] }
  if (!hasDeadLifecycle) return { isComeback: false, reasons: [] }
  if (radarScore < config.minRadarScore) {
    return { isComeback: false, reasons: [] }
  }
  if (
    troughMcapUsd == null ||
    currentMcapUsd == null ||
    !Number.isFinite(troughMcapUsd) ||
    !Number.isFinite(currentMcapUsd) ||
    troughMcapUsd <= 0 ||
    currentMcapUsd <= 0
  ) {
    return { isComeback: false, reasons: [] }
  }

  const need = troughMcapUsd * config.recoverMultiple
  if (currentMcapUsd < need) {
    return { isComeback: false, reasons: [] }
  }

  return {
    isComeback: true,
    reasons: [
      `comeback: mcap $${Math.round(currentMcapUsd).toLocaleString()} ≥ ${config.recoverMultiple}× trough $${Math.round(troughMcapUsd).toLocaleString()} (need $${Math.round(need).toLocaleString()}); score ${radarScore} ≥ ${config.minRadarScore}`,
    ],
  }
}

export function pctChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null
  }
  return ((current - previous) / previous) * 100
}
