import type { StrategyOutcomeRow } from './types'

export function strategyOutcomeTradeKey(row: StrategyOutcomeRow): string {
  return `${row.strategy_id}|${row.token_address ?? ''}|${row.entry_at ?? ''}`
}

export function mcapSimClosedOutcomeKey(
  tokenAddress: string,
  entryAt: string,
): string {
  return `${tokenAddress}|${entryAt}`
}

function outcomeRowSortTime(row: StrategyOutcomeRow): string {
  return row.exit_at ?? row.created_at ?? ''
}

export function dedupeStrategyOutcomeRows(
  rows: StrategyOutcomeRow[],
): StrategyOutcomeRow[] {
  const byKey = new Map<string, StrategyOutcomeRow>()
  for (const row of rows) {
    const key = strategyOutcomeTradeKey(row)
    const existing = byKey.get(key)
    if (!existing || outcomeRowSortTime(row) > outcomeRowSortTime(existing)) {
      byKey.set(key, row)
    }
  }
  return Array.from(byKey.values())
}
