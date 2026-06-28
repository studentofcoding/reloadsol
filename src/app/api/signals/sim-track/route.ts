import { NextRequest, NextResponse } from 'next/server'
import { getActiveSignalsForSim } from '@/strategies/load-signals'
import { scoreSignalsForStrategy } from '@/strategies/signals-pipeline'
import { recordSignalsOutcome } from '@/strategies/outcomes'
import { buildEntryFeatureSnapshot } from '@/strategies/entry-feature-snapshot'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const SIGNALS_SIM_WALLET =
  process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim'

function getSimTrackSecret(): string {
  return (
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

type OpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryFeatures: Record<string, unknown>
}

function getOpenPositionsForStrategy(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
): OpenPosition[] {
  const seen = new Set<string>()
  const open: OpenPosition[] = []

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
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      const sim = (buyRecord?.trading_simulation ?? {}) as Record<string, unknown>
      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol ?? t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryFeatures:
          sim.entry_features && typeof sim.entry_features === 'object'
            ? (sim.entry_features as Record<string, unknown>)
            : {},
      })
    }
  }

  return open
}

async function openSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  solAmount: number
  priceUsd: number
  entryFeatures: Record<string, unknown>
}): Promise<void> {
  const solPrice = await getSolPriceUSD()
  const tokenAmount =
    params.priceUsd > 0 && solPrice > 0
      ? (params.solAmount * solPrice) / params.priceUsd
      : params.solAmount * 1000

  const record = buildTradingRecord({
    walletAddress: SIGNALS_SIM_WALLET,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount: params.solAmount,
        priceUsd: params.priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: params.solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? params.solAmount * solPrice : undefined,
    signatures: [`signals-sim-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      strategy_id: params.strategyId,
      entry_at: new Date().toISOString(),
      entry_features: params.entryFeatures,
    },
  })

  await insertTradingRecord(record)
}

async function closeSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryFeatures: Record<string, unknown>
}): Promise<number> {
  const records = await fetchTradingRecordsForWallet(SIGNALS_SIM_WALLET)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const prices = await fetchTokenPricesForTracking([params.mintAddress])
  const sellPriceUsd = prices[params.mintAddress] || cycle.weightedBuyPriceUsd
  const solPrice = await getSolPriceUSD()
  const remaining = cycle.remainingTokenAmount
  const solReceived =
    sellPriceUsd && solPrice > 0
      ? (remaining * sellPriceUsd) / solPrice
      : cycle.totalSolBought

  const pnlPct =
    cycle.totalSolBought > 0
      ? ((solReceived - cycle.totalSolBought) / cycle.totalSolBought) * 100
      : 0

  const record = buildTradingRecord({
    walletAddress: SIGNALS_SIM_WALLET,
    operationType: 'sell',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    close_position: true,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount: remaining,
        solAmount: solReceived,
        priceUsd: sellPriceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: solReceived,
    feesPaid: 0,
    solPriceUsd: solPrice,
    signatures: [`signals-sim-close-${Date.now()}`],
    status: pnlPct >= 0 ? 'won' : 'lost',
  })

  await insertTradingRecord(record)

  await recordSignalsOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: {
      ...params.entryFeatures,
      exit_price_usd: sellPriceUsd,
      sol_spent: cycle.totalSolBought,
      sol_received: solReceived,
    },
  })

  return pnlPct
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const strategies = await getActiveSignalsForSim()
    const records = await fetchTradingRecordsForWallet(SIGNALS_SIM_WALLET)
    const results: Array<{
      strategyId: string
      opened: number
      closed: number
      skipped: string[]
    }> = []

    for (const strategy of strategies) {
      const openPositions = getOpenPositionsForStrategy(records, strategy.id)
      const openMintSet = new Set(openPositions.map((p) => p.mintAddress))
      let opened = 0
      let closed = 0
      const skipped: string[] = []

      const scored = await scoreSignalsForStrategy(strategy)
      const scoredByMint = new Map(scored.map((s) => [s.token_address, s]))

      for (const pos of openPositions) {
        const signal = scoredByMint.get(pos.mintAddress)
        const decision = signal?.decision ?? 'hold'
        if (decision === 'exit') {
          await closeSimPosition({
            strategyId: strategy.id,
            mintAddress: pos.mintAddress,
            symbol: pos.symbol,
            entryAt: pos.entryAt,
            entryFeatures: pos.entryFeatures,
          })
          closed++
          openMintSet.delete(pos.mintAddress)
        }
      }

      const refreshedRecords = await fetchTradingRecordsForWallet(SIGNALS_SIM_WALLET)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      for (const signal of scored) {
        if (signal.decision !== 'enter') continue
        if (openMintSet.has(signal.token_address)) continue
        if (currentOpen + opened >= maxOpen) {
          skipped.push(`${signal.token_symbol}: max positions`)
          break
        }

        const prices = await fetchTokenPricesForTracking([signal.token_address])
        const priceUsd = prices[signal.token_address] || 0.000001

        await openSimPosition({
          strategyId: strategy.id,
          mintAddress: signal.token_address,
          symbol: signal.token_symbol,
          solAmount: strategy.config.execution.simBuySol,
          priceUsd,
          entryFeatures: {
            score: signal.score,
            decision: signal.decision,
            growth: signal.mcap_growth_percent,
            recency_minutes: signal.trend_age_minutes,
            rationale: signal.rationale,
            ...buildEntryFeatureSnapshot({
              entryAt: new Date().toISOString(),
              firstSeenAt: signal.first_seen_at,
              entryMcap: signal.current_mcap,
              tokenSymbol: signal.token_symbol,
            }),
          },
        })
        opened++
        openMintSet.add(signal.token_address)
      }

      results.push({ strategyId: strategy.id, opened, closed, skipped })
    }

    log.info('mcap_tracker', 'Sim track cycle complete', { results })

    return NextResponse.json({ success: true, wallet: SIGNALS_SIM_WALLET, results })
  } catch (error) {
    log.error('error_handling', 'Sim track failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
