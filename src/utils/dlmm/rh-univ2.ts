import { defineChain, type Address, type Hex } from 'viem'
import type {
  LpTerminalPoolRaw,
  LpTerminalTokenMeta,
} from '@/utils/dlmm/lp-terminal-pools'
import { tokenSymbol } from '@/utils/dlmm/lp-terminal-pools'

/** Robinhood Chain mainnet */
export const RH_CHAIN_ID = 4663 as const

/** Default ArrowRPC (no key). Prefer NEXT_PUBLIC_* in the browser for wallet_addEthereumChain. */
export const RH_DEFAULT_RPC = 'https://rpc.arrowrpc.com'

export function getRhRpcUrl(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_RPC_4663 ||
    process.env.RPC_4663 ||
    ''
  return fromEnv.trim() || RH_DEFAULT_RPC
}

export const RH_CHAIN = defineChain({
  id: RH_CHAIN_ID,
  name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [getRhRpcUrl()] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
    },
  },
})

export const RH_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address
export const RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address

/** Uniswap V2 on Robinhood — verify on Blockscout before mainnet size */
export const RH_V2_FACTORY =
  '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f' as Address
export const RH_V2_ROUTER =
  '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba' as Address

export const RH_QUOTE_SYMBOLS = new Set(['USDG', 'WETH'])
export const DEFAULT_RH_SLIPPAGE_BPS = 100 // 1%
export const RH_AMOUNT_CHIPS = [25, 50, 100, 250] as const

export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase()
}

export function isRhQuoteAddress(addr: string): boolean {
  const a = normalizeAddress(addr)
  return a === normalizeAddress(RH_USDG) || a === normalizeAddress(RH_WETH)
}

export function quoteSymbolForAddress(addr: string): 'USDG' | 'WETH' | null {
  const a = normalizeAddress(addr)
  if (a === normalizeAddress(RH_USDG)) return 'USDG'
  if (a === normalizeAddress(RH_WETH)) return 'WETH'
  return null
}

export type RhUniv2QuotePool = {
  pool: LpTerminalPoolRaw
  quoteAddress: string
  quoteSymbol: 'USDG' | 'WETH'
  baseAddress: string
  tvlUsd: number
}

/** Filter univ2 pools for token that pair with USDG or WETH; pick highest TVL. */
export function pickHighestTvlUniv2QuotePool(
  pools: LpTerminalPoolRaw[],
  tokenAddress: string,
  tokens?: Record<string, LpTerminalTokenMeta>,
): RhUniv2QuotePool | null {
  const token = normalizeAddress(tokenAddress)
  let best: RhUniv2QuotePool | null = null

  for (const pool of pools) {
    if (String(pool.proto).toLowerCase() !== 'univ2') continue
    const t0 = normalizeAddress(pool.token0)
    const t1 = normalizeAddress(pool.token1)
    if (t0 !== token && t1 !== token) continue

    const other = t0 === token ? t1 : t0
    let quoteSymbol = quoteSymbolForAddress(other)
    if (!quoteSymbol && tokens) {
      const sym = tokenSymbol(tokens, other).toUpperCase()
      if (sym === 'USDG' || sym === 'WETH') quoteSymbol = sym
    }
    if (!quoteSymbol) continue

    const tvlUsd = Number(pool.tvlUsd) || 0
    if (!best || tvlUsd > best.tvlUsd) {
      best = {
        pool,
        quoteAddress: other,
        quoteSymbol,
        baseAddress: token,
        tvlUsd,
      }
    }
  }
  return best
}

/** True when pool is univ2 and one side is USDG/WETH. */
export function isRhUniv2QuotePool(
  pool: Pick<LpTerminalPoolRaw, 'proto' | 'token0' | 'token1'>,
  tokens?: Record<string, LpTerminalTokenMeta>,
): boolean {
  if (String(pool.proto).toLowerCase() !== 'univ2') return false
  for (const side of [pool.token0, pool.token1]) {
    if (quoteSymbolForAddress(side)) return true
    if (tokens) {
      const sym = tokenSymbol(tokens, side).toUpperCase()
      if (RH_QUOTE_SYMBOLS.has(sym)) return true
    }
  }
  return false
}

/** Split quote into swap half (exact) + remainder for addLiquidity. */
export function zapSplitQuote(quoteAmount: bigint): {
  swapAmount: bigint
  remainAmount: bigint
} {
  if (quoteAmount <= BigInt(0)) return { swapAmount: BigInt(0), remainAmount: BigInt(0) }
  const swapAmount = quoteAmount / BigInt(2)
  const remainAmount = quoteAmount - swapAmount
  return { swapAmount, remainAmount }
}

export function applySlippageMinOut(
  expectedOut: bigint,
  slippageBps: number = DEFAULT_RH_SLIPPAGE_BPS,
): bigint {
  if (expectedOut <= BigInt(0)) return BigInt(0)
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))))
  return (expectedOut * (BigInt(10000) - bps)) / BigInt(10000)
}

/** Constant-product getAmountOut (Uniswap V2). */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  if (amountIn <= BigInt(0) || reserveIn <= BigInt(0) || reserveOut <= BigInt(0)) return BigInt(0)
  const amountInWithFee = amountIn * BigInt(997)
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * BigInt(1000) + amountInWithFee
  return numerator / denominator
}

/** Soft warning when deposit quote exceeds this fraction of pool TVL. */
export const RH_TVL_SOFT_WARN_FRAC = 0.1

export function exceedsTvlSoftWarn(
  quoteUsd: number,
  poolTvlUsd: number,
): boolean {
  if (!(poolTvlUsd > 0) || !(quoteUsd > 0)) return false
  return quoteUsd > poolTvlUsd * RH_TVL_SOFT_WARN_FRAC
}

/** LP share value in quote units from reserves (both sides valued via quote reserve). */
export function lpShareValueQuoteUnits(
  lpBalance: bigint,
  totalSupply: bigint,
  reserveQuote: bigint,
  reserveBase: bigint,
  /** price of base in quote (quote per base), from reserves */
): number {
  if (lpBalance <= BigInt(0) || totalSupply <= BigInt(0)) return 0
  // Value ≈ 2 * quote_side_share (balanced CPMM mark)
  const quoteShare =
    Number((reserveQuote * lpBalance) / totalSupply) +
    // base share converted at spot
    (() => {
      const baseShare = (reserveBase * lpBalance) / totalSupply
      if (reserveBase <= BigInt(0)) return 0
      const spot = Number(reserveQuote) / Number(reserveBase)
      return Number(baseShare) * spot
    })()
  return quoteShare
}

export function explorerTxUrl(txHash: string): string {
  return `${RH_CHAIN.blockExplorers.default.url}/tx/${txHash}`
}

export function explorerAddressUrl(address: string): string {
  return `${RH_CHAIN.blockExplorers.default.url}/address/${address}`
}

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

export const wethAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const

export const univ2FactoryAbi = [
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const

export const univ2RouterAbi = [
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'addLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'amountADesired', type: 'uint256' },
      { name: 'amountBDesired', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'removeLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

export const univ2PairAbi = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

export type { Address, Hex }
