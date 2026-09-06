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
      const entryFeatures =
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {}
      const entryPriceUsd =
        finite(sim.entry_price_usd) ??
        finite(entryFeatures.initial_price_usd) ??
        cycle.weightedBuyPriceUsd ??
        0

      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol || t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryPriceUsd,
        entryFeatures,
      })
    }
  }

  return open
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export type PriceSimExitConfig = {
  stopLossPct: number
  takeProfitPct: number
  maxHoldHours: number
}

export type PriceSimExitDecision = {
  close: boolean
  reason: 'missing_price' | 'stop_loss' | 'take_profit' | 'max_hold' | 'hold'
  pnlPct: number | null
}

/** Shared SL / TP / max-hold exit for price-based paper domains (gmgn, social, …). */
export function shouldClosePriceSimPosition(params: {
  entryPriceUsd: number
  currentPriceUsd: number
  entryAt: string | null
  exit: PriceSimExitConfig
  nowMs?: number
}): PriceSimExitDecision {
  const { entryPriceUsd, currentPriceUsd, entryAt, exit } = params
  if (entryPriceUsd <= 0 || currentPriceUsd <= 0) {
    return { close: false, reason: 'missing_price', pnlPct: null }
  }
  const pnlPct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
  if (pnlPct <= exit.stopLossPct) return { close: true, reason: 'stop_loss', pnlPct }
  if (pnlPct >= exit.takeProfitPct) return { close: true, reason: 'take_profit', pnlPct }
  if (entryAt && exit.maxHoldHours > 0) {
    const heldMs = (params.nowMs ?? Date.now()) - new Date(entryAt).getTime()
    if (heldMs >= exit.maxHoldHours * 60 * 60 * 1000) {
      return { close: true, reason: 'max_hold', pnlPct }
    }
  }
  return { close: false, reason: 'hold', pnlPct }
}
