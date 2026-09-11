import {
  GMGN_RH_USDG,
  GMGN_RH_WETH,
  gmgnNativeToken,
  gmgnTokenDecimals,
  matchesTradeChainAddress,
  type GmgnTradeChain,
} from '@/utils/gmgn-currencies'
import { TOKENS } from '@/utils/solana'
import type { RhSwapQuote } from '@/utils/dlmm/rh-univ2-swap'

export type SellOutputPreset = 'native' | 'USDG' | 'WETH' | 'custom'

export type SellOutputResolved = {
  outputMint: string
  gmgnOutputToken: string
  /** Set only for RH custom; presets use `rhQuote` → Kyber mapping. */
  kyberOutputToken?: string
  rhQuote: RhSwapQuote
  symbol: string
  decimals: number
}

function sameAddr(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function sameSellToken(a: string, b: string): boolean {
  return sameAddr(a, b)
}

/** Resolve bulk-sell destination mint. Invalid custom falls back to native. */
export function sellOutputMint(params: {
  chain: GmgnTradeChain
  preset: SellOutputPreset
  customAddress?: string
}): SellOutputResolved {
  const custom = params.customAddress?.trim() ?? ''
  const customOk =
    params.preset === 'custom' &&
    matchesTradeChainAddress(params.chain, custom)

  if (params.chain === 'sol') {
    if (customOk) {
      return {
        outputMint: custom,
        gmgnOutputToken: custom,
        rhQuote: 'ETH',
        symbol: 'TOKEN',
        // ponytail: unknown SPL decimals default to 9 (native); UI overlays holdings decimals.
        decimals: gmgnTokenDecimals('sol', custom),
      }
    }
    return {
      outputMint: TOKENS.SOL,
      gmgnOutputToken: gmgnNativeToken('sol'),
      rhQuote: 'ETH',
      symbol: 'SOL',
      decimals: 9,
    }
  }

  if (customOk) {
    return {
      outputMint: custom,
      gmgnOutputToken: custom,
      kyberOutputToken: custom,
      rhQuote: 'ETH',
      symbol: 'TOKEN',
      decimals: gmgnTokenDecimals('robinhood', custom),
    }
  }
  if (params.preset === 'USDG') {
    return {
      outputMint: GMGN_RH_USDG,
      gmgnOutputToken: GMGN_RH_USDG,
      rhQuote: 'USDG',
      symbol: 'USDG',
      decimals: 6,
    }
  }
  if (params.preset === 'WETH') {
    return {
      outputMint: GMGN_RH_WETH,
      gmgnOutputToken: GMGN_RH_WETH,
      rhQuote: 'WETH',
      symbol: 'WETH',
      decimals: 18,
    }
  }
  return {
    outputMint: gmgnNativeToken('robinhood'),
    gmgnOutputToken: gmgnNativeToken('robinhood'),
    rhQuote: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  }
}
