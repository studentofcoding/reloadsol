/** GMGN chain currency addresses — copy from gmgn-cli swap skill; never invent. */

export type GmgnTradeChain = 'sol' | 'robinhood'

export const GMGN_NATIVE_ETH = '0x0000000000000000000000000000000000000000'
export const GMGN_SOL_NATIVE = 'So11111111111111111111111111111111111111112'
export const GMGN_SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export const GMGN_CHAIN_CURRENCIES: Record<
  GmgnTradeChain,
  { native: string; nativeSymbol: string; nativeDecimals: number; usdc?: string }
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
  },
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

export function parseTradeTokenAddresses(
  chain: GmgnTradeChain,
  input: string,
  limit = 10,
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
