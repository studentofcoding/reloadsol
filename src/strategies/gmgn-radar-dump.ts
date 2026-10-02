/**
 * Radar dump (≤-80% vs previous price): ban mint + close open sim positions.
 */

import { randomUUID } from 'crypto'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import {
  closeSimulationPosition,
  computeOpenSimCycle,
} from '@/utils/simulation-trades'
import { insertTradingRecord } from '@/utils/trading-records-db'
import { markTokenRug } from '@/utils/rug-list/service'
import { log } from '@/utils/unified-logger'

const SIM_WALLETS = () => [
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim',
  process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim',
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim',
]

export async function banTokenFromRadarDump(params: {
  tokenAddress: string
  tokenSymbol?: string | null
}): Promise<void> {
  await markTokenRug({
    tokenAddress: params.tokenAddress,
    tokenSymbol: params.tokenSymbol,
    source: 'gmgn-radar',
  })
}

/** Close any open sim cycles for mint across known sim wallets. */
export async function closeOpenSimsForRadarDump(params: {
  tokenAddress: string
  tokenSymbol?: string | null
  sellPriceUsd?: number | null
}): Promise<{ closed: number; errors: string[] }> {
  let closed = 0
  const errors: string[] = []

  for (const wallet of SIM_WALLETS()) {
    try {
      const records = await fetchTradingRecordsForWallet(wallet)
      const cycle = computeOpenSimCycle(records, params.tokenAddress)
      if (!cycle) continue

      await closeSimulationPosition({
        walletAddress: wallet,
        mintAddress: params.tokenAddress,
        records,
        sellPriceUsd: params.sellPriceUsd ?? undefined,
        symbol: params.tokenSymbol ?? cycle.symbol,
        name: cycle.name,
        logoURI: cycle.logoURI,
        trackOperation: async (op) => {
          await insertTradingRecord({
            ...op,
            id: randomUUID(),
            timestamp: Date.now(),
            trading_simulation: { close_reason: 'gmgn_radar_dump' },
          })
        },
      })
      closed++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${wallet}: ${msg}`)
      log.warn('error_handling', 'Radar dump sim close failed', {
        wallet,
        mint: params.tokenAddress,
        error: msg,
      })
    }
  }

  return { closed, errors }
}

export async function killAndBanRadarDump(params: {
  tokenAddress: string
  tokenSymbol?: string | null
  sellPriceUsd?: number | null
}): Promise<{ banned: boolean; closed: number }> {
  await banTokenFromRadarDump(params)
  const { closed } = await closeOpenSimsForRadarDump(params)
  return { banned: true, closed }
}
