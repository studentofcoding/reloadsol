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

/** Tokens that represent real tracked trades: excludes skipped and waiting. */
export function isPnlEligibleTrackerToken(token: { status?: string | null }): boolean {
  return token.status !== 'skipped' && token.status !== 'waiting'
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

export type TrackerDisplayStatus =
  | 'skipped'
  | 'won'
  | 'lost'
  | 'tracking'
  | 'waiting'
  | 'manual_sell'
  | 'stopped'
  | string

/** UI/API label: skipped stays skipped; terminal rows use realized gain. */
export function getEffectiveDisplayStatus(token: {
  status?: string | null
  current_gain_percentage?: number | null
  peak_gain_percentage?: number | null
}): TrackerDisplayStatus {
  if (isSkippedTrackerToken(token)) return 'skipped'
  const outcome = resolveCompletedOutcome(token)
  if (outcome) return outcome
  return token.status ?? 'unknown'
}

export type TrackerOutcomeStats = {
  total: number
  won: number
  lost: number
  skipped: number
  tracking: number
  waiting: number
  winRate: number
}

export function countTrackerOutcomeStats(
  tokens: Array<{ status?: string | null; current_gain_percentage?: number | null; peak_gain_percentage?: number | null }>,
): TrackerOutcomeStats {
  let won = 0
  let lost = 0
  let skipped = 0
  let tracking = 0
  let waiting = 0

  for (const token of tokens) {
    if (isSkippedTrackerToken(token)) {
      skipped += 1
      continue
    }
    if (token.status === 'tracking') {
      tracking += 1
      continue
    }
    if (token.status === 'waiting') {
      waiting += 1
      continue
    }
    const outcome = resolveCompletedOutcome(token)
    if (outcome === 'won') won += 1
    else if (outcome === 'lost') lost += 1
  }

  const completed = won + lost
  return {
    total: tokens.length,
    won,
    lost,
    skipped,
    tracking,
    waiting,
    winRate: completed > 0 ? (won / completed) * 100 : 0,
  }
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
