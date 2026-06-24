import type { TrackingRecord } from '@/utils/trading-tracker'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { getSolPriceUSD } from '@/utils/solana'

export interface OpenSimCycle {
  mintAddress: string
  symbol?: string
  name?: string
  logoURI?: string
  remainingTokenAmount: number
  totalSolBought: number
  simulationType?: 'manual' | 'strategy'
  weightedBuyPriceUsd: number
}

/** Compute open simulation cycle for a mint from trading records. */
export function computeOpenSimCycle(
  records: TrackingRecord[],
  mintAddress: string,
): OpenSimCycle | null {
  return computeOpenTradeCycle(records, mintAddress, 'sim')
}

/** Compute open trade cycle for sim or live wallet records. */
export function computeOpenTradeCycle(
  records: TrackingRecord[],
  mintAddress: string,
  mode: 'sim' | 'live' = 'sim',
): OpenSimCycle | null {
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp)
  let cycle: OpenSimCycle | null = null

  for (const op of sorted) {
    const isSim = op.is_simulation === true
    if (mode === 'sim' && !isSim) continue
    if (mode === 'live' && isSim) continue
    if (op.successCount === 0 || !op.solAmount) continue

    const tokensInOp = op.tokens || []
    const solPerToken = op.solAmount / op.successCount

    for (const tkn of tokensInOp) {
      if (tkn.mintAddress !== mintAddress) continue

      if (op.operationType === 'buy') {
        if (!cycle) {
          cycle = {
            mintAddress,
            symbol: tkn.symbol,
            name: tkn.name,
            logoURI: tkn.logoURI,
            remainingTokenAmount: 0,
            totalSolBought: 0,
            simulationType: op.simulation_type,
            weightedBuyPriceUsd: tkn.priceUsd || 0,
          }
        }

        const tokenAmt = tkn.tokenAmount || 0
        cycle.totalSolBought += solPerToken
        cycle.remainingTokenAmount += tokenAmt
        if (tkn.priceUsd) {
          cycle.weightedBuyPriceUsd = tkn.priceUsd
        }
        if (op.simulation_type) {
          cycle.simulationType = op.simulation_type
        }
      } else if (op.operationType === 'sell' && cycle) {
        let tokenAmt = tkn.tokenAmount || 0
        if (op.close_position) {
          tokenAmt = cycle.remainingTokenAmount
        } else if (tokenAmt >= cycle.remainingTokenAmount * 0.99) {
          tokenAmt = cycle.remainingTokenAmount
        }

        cycle.remainingTokenAmount = Math.max(
          0,
          cycle.remainingTokenAmount - tokenAmt,
        )
      }
    }
  }

  if (!cycle || cycle.remainingTokenAmount <= 1e-6) {
    return null
  }

  return cycle
}

type TrackFn = (
  operation: Omit<TrackingRecord, 'id' | 'timestamp'>,
) => Promise<void>

export interface CloseSimulationParams {
  walletAddress: string
  mintAddress: string
  records: TrackingRecord[]
  trackOperation: TrackFn
  sellPriceUsd?: number
  symbol?: string
  name?: string
  logoURI?: string
}

export interface CloseSimulationResult {
  solReceived: number
}

/** Close an open simulation position using exact remaining token amount. */
export async function closeSimulationPosition({
  walletAddress,
  mintAddress,
  records,
  trackOperation,
  sellPriceUsd,
  symbol,
  name,
  logoURI,
}: CloseSimulationParams): Promise<CloseSimulationResult> {
  const cycle = computeOpenSimCycle(records, mintAddress)
  if (!cycle) {
    throw new Error('No open simulation position found for this token')
  }

  const buyRecord = [...records]
    .sort((a, b) => b.timestamp - a.timestamp)
    .find(
      (r) =>
        r.operationType === 'buy' &&
        r.is_simulation &&
        r.tokens?.some((t) => t.mintAddress === mintAddress),
    )
  const botStrategy = buyRecord?.bot_strategy

  const solPrice = await getSolPriceUSD()
  let priceUsd = sellPriceUsd

  if (!priceUsd) {
    const prices = await fetchTokenPricesForTracking([mintAddress])
    priceUsd = prices[mintAddress] || cycle.weightedBuyPriceUsd
  }

  const remaining = cycle.remainingTokenAmount
  const solReceived =
    priceUsd && solPrice > 0
      ? (remaining * priceUsd) / solPrice
      : cycle.totalSolBought

  await trackOperation({
    walletAddress,
    operationType: 'sell',
    is_simulation: true,
    simulation_type: cycle.simulationType || 'manual',
    bot_strategy: botStrategy,
    close_position: true,
    tokens: [
      {
        mintAddress,
        symbol: symbol || cycle.symbol,
        name: name || cycle.name,
        logoURI: logoURI || cycle.logoURI,
        tokenAmount: remaining,
        solAmount: solReceived,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: solReceived,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? solReceived * solPrice : undefined,
    signatures: [`sim-close-${Date.now()}`],
    status: 'won',
  })

  return { solReceived }
}
