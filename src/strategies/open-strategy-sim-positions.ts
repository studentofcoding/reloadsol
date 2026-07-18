import { computeOpenSimCycle } from '@/utils/simulation-trades'
import type { TrackingRecord } from '@/utils/trading-tracker'

export type StrategySimOpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryPriceUsd: number
  entryFeatures: Record<string, unknown>
}

/** Open strategy sim cycles for a wallet filtered by bot_strategy. */
export function getOpenStrategySimPositions(
  records: TrackingRecord[],
  strategyId: string,
): StrategySimOpenPosition[] {
  const seen = new Set<string>()
  const open: StrategySimOpenPosition[] = []

  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategyId) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenSimCycle(records, t.mintAddress)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      seen.add(t.mintAddress)

      const buyRecord = records.find(
        (rec) =>
          rec.operationType === 'buy' &&
          rec.bot_strategy === strategyId &&
          rec.is_simulation &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      const sim = (buyRecord?.trading_simulation ?? {}) as Record<string, unknown>
      const entryPriceUsd =
        typeof sim.entry_price_usd === 'number'
          ? sim.entry_price_usd
          : cycle.weightedBuyPriceUsd

      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol ?? t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryPriceUsd,
        entryFeatures:
          sim.entry_features && typeof sim.entry_features === 'object'
            ? (sim.entry_features as Record<string, unknown>)
            : {},
      })
    }
  }

  return open
}
