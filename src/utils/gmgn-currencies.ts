/** GMGN chain currency addresses — copy from gmgn-cli swap skill; never invent. */

import { MAX_TRADE_TOKENS } from '@/utils/trade-ui-limits'

export type GmgnTradeChain = 'sol' | 'robinhood'

export const GMGN_NATIVE_ETH = '0x0000000000000000000000000000000000000000'
export const GMGN_SOL_NATIVE = 'So11111111111111111111111111111111111111112'
export const GMGN_SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
/** Robinhood USDG — same as RH_USDG in rh-univ2. */
export const GMGN_RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
/** Robinhood WETH — same as RH_WETH in rh-univ2. */
export const GMGN_RH_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

export const GMGN_CHAIN_CURRENCIES: Record<
  GmgnTradeChain,
  {
    native: string
    nativeSymbol: string
    nativeDecimals: number
    usdc?: string
    usdg?: string
    weth?: string
  }
> = {
  sol: {
    native: GMGN_SOL_NATIVE,
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    usdc: GMGN_SOL_USDC,
  },
  robinhood: {
    native: GMGN_NATIVE_ETH,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    usdg: GMGN_RH_USDG,
    weth: GMGN_RH_WETH,
  },
}

/** Decimals for GMGN input/output token amount encoding. */
export function gmgnTokenDecimals(
  chain: GmgnTradeChain,
  token: string,
): number {
  const meta = GMGN_CHAIN_CURRENCIES[chain]
  const t = token.trim().toLowerCase()
  if (meta.usdc && t === meta.usdc.toLowerCase()) return 6
  if (meta.usdg && t === meta.usdg.toLowerCase()) return 6
  if (meta.weth && t === meta.weth.toLowerCase()) return 18
  return meta.nativeDecimals
}

export function isGmgnTradeChain(value: string): value is GmgnTradeChain {
  return value === 'sol' || value === 'robinhood'
}

export function gmgnNativeToken(chain: GmgnTradeChain): string {
  return GMGN_CHAIN_CURRENCIES[chain].native
}

/** UI slippage is in bps (100 = 1%); GMGN wants percent 0–100. */
export function slippageBpsToGmgnPercent(slippageBps: number): number {
  return Math.max(0, Math.min(100, Math.round(slippageBps / 100)))
}

/** Human amount → smallest-unit string for GMGN `input_amount`. */
export function toGmgnRawAmount(
  humanAmount: number,
  decimals: number,
): string {
  if (!Number.isFinite(humanAmount) || humanAmount <= 0) {
    throw new Error('Amount must be a positive number')
  }
  const [whole, frac = ''] = humanAmount.toFixed(decimals).split('.')
  return `${whole}${frac.padEnd(decimals, '0').slice(0, decimals)}`.replace(
    /^0+(?=\d)/,
    '',
  )
}

export function isValidTradeTokenAddress(
  chain: GmgnTradeChain,
  address: string,
): boolean {
  const a = address.trim()
  if (!a) return false
  if (chain === 'robinhood') {
    return /^0x[a-fA-F0-9]{40}$/i.test(a) && a.toLowerCase() !== GMGN_NATIVE_ETH
  }
  if (a.length < 32 || a.length > 44) return false
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(a)
}

/** Address formats are disjoint across chains, so callers that don't know the chain can accept either. */
export function isValidAnyChainTokenAddress(address: string): boolean {
  return (
    isValidTradeTokenAddress('sol', address) ||
    isValidTradeTokenAddress('robinhood', address)
  )
}

export function parseTradeTokenAddresses(
  chain: GmgnTradeChain,
  input: string,
  limit = MAX_TRADE_TOKENS,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of input.split(/[\n,\s]+/)) {
    const addr = part.trim()
    if (!addr || !isValidTradeTokenAddress(chain, addr)) continue
    const key = chain === 'robinhood' ? addr.toLowerCase() : addr
    if (seen.has(key)) continue
    seen.add(key)
    out.push(chain === 'robinhood' ? addr.toLowerCase() : addr)
    if (out.length >= limit) break
  }
  return out
}

export function matchesTradeChainAddress(
  chain: GmgnTradeChain,
  address: string,
): boolean {
  return isValidTradeTokenAddress(chain, address)
}
