export type SummaryToken = {
  peak_gain_percentage?: number | null
  current_gain_percentage?: number | null
  status?: string | null
  trading_simulation?: unknown
}

const TERMINAL_OUTCOME_STATUSES = new Set(['won', 'lost', 'manual_sell'])

/** Realized/mark-to-market PnL: last price vs tracking start. Never peak. */
export function getSummaryTokenGainPct(token: SummaryToken): number {
  return Number(token.current_gain_percentage ?? 0)
}

/** Peak gain during tracking (informational only, not profit). */
export function getPeakGainPct(token: SummaryToken): number {
  return Number(token.peak_gain_percentage ?? token.current_gain_percentage ?? 0)
}

export function isSkippedTrackerToken(token: { status?: string | null }): boolean {
  return token.status === 'skipped'
}

export function hadSimulatedEntry(token: { trading_simulation?: unknown }): boolean {
  const sim = token.trading_simulation
  if (!sim || typeof sim !== 'object') return false
  const buy = (sim as { buy_operation?: unknown }).buy_operation
  return buy != null && typeof buy === 'object'
}

/** Completed trade outcome from realized gain; null if open or skipped. */
export function resolveCompletedOutcome(token: SummaryToken): 'won' | 'lost' | null {
  const status = token.status ?? ''
  if (status === 'skipped' || status === 'waiting' || status === 'tracking') {
    return null
  }
  if (!TERMINAL_OUTCOME_STATUSES.has(status)) {
    return null
  }
  const gain = getSummaryTokenGainPct(token)
  return gain > 0 ? 'won' : 'lost'
}

export function sumSummaryTokenProfitPct(tokens: SummaryToken[]): {
  totalProfitPct: number
  averageProfitPct: number
  tokenCount: number
} {
  if (!tokens.length) {
    return { totalProfitPct: 0, averageProfitPct: 0, tokenCount: 0 }
  }

  let totalProfitPct = 0
  for (const token of tokens) {
    totalProfitPct += getSummaryTokenGainPct(token)
  }

  return {
    totalProfitPct: Math.round(totalProfitPct * 100) / 100,
    averageProfitPct: Math.round((totalProfitPct / tokens.length) * 100) / 100,
    tokenCount: tokens.length,
  }
}
