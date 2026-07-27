import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { getSolPriceUSD } from '@/utils/solana'
import { fetchEthUsdSpot } from '@/utils/rh-trade-sim'

/** USD price of a chain's native token (SOL or ETH). Returns 0 when unavailable. */
export async function getNativeUsd(chain: GmgnTradeChain): Promise<number> {
  return chain === 'robinhood' ? fetchEthUsdSpot() : getSolPriceUSD()
}
