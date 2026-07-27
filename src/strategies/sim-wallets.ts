/** Canonical sim wallet addresses for strategy paper domains. */

import type { StrategyChain } from './types'

/** Robinhood paper PnL lives in its own wallet so it never mixes with Solana. */
export function simWalletForChain(wallet: string, chain: StrategyChain): string {
  return chain === 'robinhood' ? `${wallet}-rh` : wallet
}

export const TRENDING_BOT_SIM_WALLET =
  process.env.TRENDING_BOT_SIM_WALLET_ADDRESS || 'trending-bot-sim'

export const MCAP_TRACKER_SIM_WALLET =
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'

export const SIGNALS_SIM_WALLET =
  process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim'

export const GMGN_SIM_WALLET =
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim'

export const SOCIAL_SIM_WALLET =
  process.env.SOCIAL_SIM_WALLET_ADDRESS || 'social-sim'
