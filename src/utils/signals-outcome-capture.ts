import type { TrackingRecord } from '@/utils/trading-tracker'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { recordSignalsOutcome } from '@/strategies/outcomes'
import { computeOpenTradeCycle } from '@/utils/simulation-trades'
import { isSignalsStrategyId } from '@/utils/signals-strategy-id'

function readEntryFeatures(
  record: TrackingRecord | undefined,
): Record<string, unknown> {
  const sim = record?.trading_simulation
  if (sim && typeof sim === 'object' && sim.entry_features) {
    return sim.entry_features as Record<string, unknown>
  }
  return {}
}

function readEntryAt(record: TrackingRecord | undefined): string | null {
  const sim = record?.trading_simulation
  if (sim && typeof sim === 'object' && typeof sim.entry_at === 'string') {
    return sim.entry_at
  }
  if (record?.timestamp) {
    return new Date(record.timestamp).toISOString()
  }
  return null
}

function findSignalsBuyRecord(
  records: TrackingRecord[],
  mintAddress: string,
  isSimulation: boolean,
): TrackingRecord | undefined {
  return [...records]
    .sort((a, b) => b.timestamp - a.timestamp)
    .find(
      (r) =>
        r.operationType === 'buy' &&
        r.is_simulation === isSimulation &&
        isSignalsStrategyId(r.bot_strategy) &&
        r.tokens?.some((t) => t.mintAddress === mintAddress),
    )
}

function computeClosePnl(
  records: TrackingRecord[],
  mintAddress: string,
  closingRecord: TrackingRecord,
  mode: 'sim' | 'live',
): { pnlPct: number; solSpent: number; solReceived: number; sellPriceUsd: number } | null {
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp)
  let totalSolBought = 0
  let remaining = 0
  let sellPriceUsd = closingRecord.tokens?.[0]?.priceUsd ?? 0

  for (const op of sorted) {
    const isSim = op.is_simulation === true
    if (mode === 'sim' && !isSim) continue
    if (mode === 'live' && isSim) continue
    if (op.successCount === 0 || !op.solAmount) continue

    for (const tkn of op.tokens ?? []) {
      if (tkn.mintAddress !== mintAddress) continue

      if (op.operationType === 'buy') {
        const solPerToken = op.solAmount / op.successCount
        totalSolBought += solPerToken
        remaining += tkn.tokenAmount ?? 0
        if (tkn.priceUsd) sellPriceUsd = tkn.priceUsd
      } else if (op.operationType === 'sell' || op.operationType === 'close') {
        let tokenAmt = tkn.tokenAmount ?? 0
        if (op.close_position || tokenAmt >= remaining * 0.99) {
          tokenAmt = remaining
        }
        remaining = Math.max(0, remaining - tokenAmt)
      }
    }
  }

  if (totalSolBought <= 0) return null

  const solReceived = closingRecord.solAmount ?? 0
  const pnlPct = ((solReceived - totalSolBought) / totalSolBought) * 100
  return { pnlPct, solSpent: totalSolBought, solReceived, sellPriceUsd }
}

async function recordOutcomeForClose(params: {
  record: TrackingRecord
  records: TrackingRecord[]
  mintAddress: string
  isSimulation: boolean
}): Promise<void> {
  const { record, records, mintAddress, isSimulation } = params
  const mode = isSimulation ? 'sim' : 'live'

  if (computeOpenTradeCycle(records, mintAddress, mode)) {
    return
  }

  const buyRecord = findSignalsBuyRecord(records, mintAddress, isSimulation)
  const strategyId = record.bot_strategy ?? buyRecord?.bot_strategy ?? null
  if (!isSignalsStrategyId(strategyId)) return

  const pnl = computeClosePnl(records, mintAddress, record, mode)
  if (!pnl) return

  const symbol =
    record.tokens?.[0]?.symbol ??
    buyRecord?.tokens?.find((t) => t.mintAddress === mintAddress)?.symbol ??
    mintAddress.slice(0, 8)

  await recordSignalsOutcome({
    strategyId: strategyId!,
    tokenAddress: mintAddress,
    entryAt: readEntryAt(buyRecord),
    exitAt: new Date(record.timestamp).toISOString(),
    pnlPct: pnl.pnlPct,
    status: pnl.pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: isSimulation,
    features: {
      ...readEntryFeatures(buyRecord),
      token_symbol: symbol,
      exit_price_usd: pnl.sellPriceUsd,
      sol_spent: pnl.solSpent,
      sol_received: pnl.solReceived,
      close_source: isSimulation ? 'manual_sim_ui' : 'live_wallet',
    },
  })
}

/**
 * When a signals-attributed position fully closes (sim or live), write strategy_outcomes.
 */
export async function maybeRecordSignalsOutcome(
  record: TrackingRecord,
): Promise<void> {
  if (record.operationType !== 'sell' && record.operationType !== 'close') return
  if ((record.successCount ?? 0) === 0) return

  const mintAddress = record.tokens?.[0]?.mintAddress
  if (!mintAddress || !record.walletAddress) return

  const records = await fetchTradingRecordsForWallet(record.walletAddress)
  await recordOutcomeForClose({
    record,
    records,
    mintAddress,
    isSimulation: record.is_simulation === true,
  })
}

/** @deprecated Use maybeRecordSignalsOutcome */
export const maybeRecordLiveSignalsOutcome = maybeRecordSignalsOutcome
