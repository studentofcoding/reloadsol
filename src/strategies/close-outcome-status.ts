/**
 * Flat closes are breakeven, not wins.
 * Win% numerator is strictly positive pnl. Flats stay in the trade count
 * (denominator) and out of wins. Lost is strictly negative.
 */

/** Dust band. Exact 0 (entry mcap = exit mcap) is flat. */
export const PNL_FLAT_EPSILON_PCT = 1e-6

export type CloseOutcomeStatus = 'won' | 'lost' | 'breakeven'

export function isFlatPnlPct(pnlPct: number): boolean {
  return !Number.isFinite(pnlPct) || Math.abs(pnlPct) < PNL_FLAT_EPSILON_PCT
}

export function isWinningPnlPct(pnlPct: number): boolean {
  return Number.isFinite(pnlPct) && pnlPct > PNL_FLAT_EPSILON_PCT
}

export function isLosingPnlPct(pnlPct: number): boolean {
  return Number.isFinite(pnlPct) && pnlPct < -PNL_FLAT_EPSILON_PCT
}

export function closeOutcomeStatusFromPnl(pnlPct: number): CloseOutcomeStatus {
  if (isWinningPnlPct(pnlPct)) return 'won'
  if (isLosingPnlPct(pnlPct)) return 'lost'
  return 'breakeven'
}

/**
 * Telegram / outcome label. A flat pnl is always breakeven, even if a caller
 * still passed status `won`. Non win/lost statuses (stopped, skipped) pass through
 * when pnl is not flat.
 */
export function telegramCloseStatusLabel(
  pnlPct: number,
  status?: string | null,
): string {
  if (isFlatPnlPct(pnlPct)) return 'breakeven'
  const raw = status?.trim()
  if (!raw) return closeOutcomeStatusFromPnl(pnlPct)
  const lower = raw.toLowerCase()
  if (lower === 'won' || lower === 'lost' || lower === 'breakeven') {
    return closeOutcomeStatusFromPnl(pnlPct)
  }
  return raw
}

export type ClosedPnlSummary = {
  winCount: number
  lossCount: number
  breakevenCount: number
  /**
   * wins / n. Flats are in n and not in the numerator.
   * n is the length of `pnls` (caller decides whether nulls are included).
   */
  winRate: number
}

export function summarizeClosedPnls(pnls: number[]): ClosedPnlSummary {
  let winCount = 0
  let lossCount = 0
  let breakevenCount = 0
  for (const p of pnls) {
    if (isWinningPnlPct(p)) winCount += 1
    else if (isLosingPnlPct(p)) lossCount += 1
    else breakevenCount += 1
  }
  const n = pnls.length
  return {
    winCount,
    lossCount,
    breakevenCount,
    winRate: n > 0 ? winCount / n : 0,
  }
}
