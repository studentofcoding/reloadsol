import type { TrackingRecord } from '@/utils/trading-tracker'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { recordSignalsOutcome } from '@/strategies/outcomes'
import { computeOpenTradeCycle } from '@/utils/simulation-trades'

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

function computeLiveClosePnl(
  records: TrackingRecord[],
  mintAddress: string,
  closingRecord: TrackingRecord,
): { pnlPct: number; solSpent: number; solReceived: number; sellPriceUsd: number } | null {
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp)
  let totalSolBought = 0
  let remaining = 0
  let sellPriceUsd = closingRecord.tokens?.[0]?.priceUsd ?? 0

  for (const op of sorted) {
    if (op.is_simulation) continue
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

/**
 * When a live wallet sell fully closes a signals-attributed position, write strategy_outcomes.
 */
export async function maybeRecordLiveSignalsOutcome(
  record: TrackingRecord,
): Promise<void> {
  if (record.is_simulation) return
  if (record.operationType !== 'sell' && record.operationType !== 'close') return
  if ((record.successCount ?? 0) === 0) return

  const mintAddress = record.tokens?.[0]?.mintAddress
  if (!mintAddress || !record.walletAddress) return

  const records = await fetchTradingRecordsForWallet(record.walletAddress)
  if (computeOpenTradeCycle(records, mintAddress, 'live')) {
    return
  }

  const buyRecord = [...records]
    .sort((a, b) => b.timestamp - a.timestamp)
    .find(
      (r) =>
        r.operationType === 'buy' &&
        !r.is_simulation &&
        r.bot_strategy &&
        r.tokens?.some((t) => t.mintAddress === mintAddress),
    )

  const strategyId = record.bot_strategy ?? buyRecord?.bot_strategy ?? null
  if (!strategyId) return

  const pnl = computeLiveClosePnl(records, mintAddress, record)
  if (!pnl) return

  const symbol =
    record.tokens?.[0]?.symbol ??
    buyRecord?.tokens?.find((t) => t.mintAddress === mintAddress)?.symbol ??
    mintAddress.slice(0, 8)

  await recordSignalsOutcome({
    strategyId,
    tokenAddress: mintAddress,
    entryAt: readEntryAt(buyRecord),
    exitAt: new Date(record.timestamp).toISOString(),
    pnlPct: pnl.pnlPct,
    status: pnl.pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: false,
    features: {
      ...readEntryFeatures(buyRecord),
      token_symbol: symbol,
      exit_price_usd: pnl.sellPriceUsd,
      sol_spent: pnl.solSpent,
      sol_received: pnl.solReceived,
      close_source: 'live_wallet',
    },
  })
}
