export type SummaryToken = {
  peak_gain_percentage?: number | null
  current_gain_percentage?: number | null
  status?: string | null
}

/** Realized/mark-to-market PnL: last price vs tracking start. Never peak. */
export function getSummaryTokenGainPct(token: SummaryToken): number {
  return Number(token.current_gain_percentage ?? 0)
}

/** Peak gain during tracking (informational only, not profit). */
export function getPeakGainPct(token: SummaryToken): number {
  return Number(token.peak_gain_percentage ?? token.current_gain_percentage ?? 0)
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
