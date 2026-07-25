/**
 * Parent-wallet (Rabby) RH swaps via Kyber Aggregator.
 * Bound wallet keeps GMGN server-sign.
 */

import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import type { GmgnBulkBuyItem, GmgnBulkLegResult } from '@/utils/gmgn-bulk-trade'
import {
  executeRhWalletCalls,
  type RhTxCall,
} from '@/utils/dlmm/rh-send-calls'
import { GAS_RESERVE_WEI, weth9Abi } from '@/utils/dlmm/rh-clmm/wrap'
import { RH_CHAIN_ID, RH_WETH, erc20Abi } from '@/utils/dlmm/rh-univ2'
import type { RhSwapQuote } from '@/utils/dlmm/rh-univ2-swap'
import {
  clientKyberBuild,
  clientKyberRoute,
  isKyberNative,
  kyberQuoteDecimals,
  kyberQuoteTokenAddress,
  toKyberAmountRaw,
} from '@/utils/kyber-aggregator'

/** Wei to wrap so WETH balance covers `need` (0 if already covered). */
export function wethWrapShortfall(need: bigint, wethBal: bigint): bigint {
  return need > wethBal ? need - wethBal : BigInt(0)
}

function sameToken(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function isRhWeth(addr: string): boolean {
  return sameToken(addr, RH_WETH)
}

/**
 * One deposit() call when WETH ERC20 is short — leaves gas reserve on native ETH.
 * Callers prepend once for the full batch need (not per leg).
 */
export async function prepareWethWrapCalls(params: {
  publicClient: PublicClient
  account: Address
  needWei: bigint
}): Promise<RhTxCall[]> {
  if (params.needWei <= BigInt(0)) return []
  const wethBal = await params.publicClient.readContract({
    address: RH_WETH,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [params.account],
  })
  const shortfall = wethWrapShortfall(params.needWei, wethBal)
  if (shortfall <= BigInt(0)) return []
  const ethBal = await params.publicClient.getBalance({
    address: params.account,
  })
  const reserve = GAS_RESERVE_WEI[RH_CHAIN_ID]
  if (ethBal < shortfall + reserve) {
    throw new Error('Insufficient ETH/WETH (need wrap shortfall + gas reserve)')
  }
  return [
    {
      to: RH_WETH,
      data: encodeFunctionData({ abi: weth9Abi, functionName: 'deposit' }),
      value: shortfall,
    },
  ]
}

async function quoteAndBuild(params: {
  tokenIn: string
  tokenOut: string
  amountIn: string
  account: Address
  slippageBps: number
}): Promise<{
  data: `0x${string}`
  routerAddress: Address
  amountIn: string
  valueWei: bigint
}> {
  const route = await clientKyberRoute({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
  })
  const build = await clientKyberBuild({
    routeSummary: route.routeSummary,
    sender: params.account,
    recipient: params.account,
    slippageTolerance: params.slippageBps,
  })
  const routerAddress = (build.routerAddress ||
    route.routerAddress) as Address
  if (!routerAddress || !/^0x[a-fA-F0-9]{40}$/.test(routerAddress)) {
    throw new Error('Kyber routerAddress missing')
  }
  return {
    data: build.data,
    routerAddress,
    amountIn: build.amountIn,
    valueWei: build.valueWei,
  }
}

/** Approve (if needed) + Kyber swap calldata for one leg (no wrap). */
export async function prepareKyberSwapCalls(params: {
  publicClient: PublicClient
  account: Address
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippageBps: number
}): Promise<RhTxCall[]> {
  if (sameToken(params.tokenIn, params.tokenOut)) {
    throw new Error('tokenIn and tokenOut must differ')
  }
  const built = await quoteAndBuild({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amountIn,
    account: params.account,
    slippageBps: params.slippageBps,
  })
  const calls: RhTxCall[] = []
  if (!isKyberNative(params.tokenIn)) {
    const token = params.tokenIn as Address
    const amountIn = BigInt(built.amountIn)
    const allowance = await params.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [params.account, built.routerAddress],
    })
    if (allowance < amountIn) {
      calls.push({
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [built.routerAddress, maxUint256],
        }),
      })
    }
  }
  calls.push({
    to: built.routerAddress,
    data: built.data,
    value: built.valueWei,
  })
  return calls
}

export async function executeRhParentKyberSwap(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippageBps: number
}): Promise<{ hash: string }> {
  const swapCalls = await prepareKyberSwapCalls(params)
  const wrapCalls = isRhWeth(params.tokenIn)
    ? await prepareWethWrapCalls({
        publicClient: params.publicClient,
        account: params.account,
        needWei: BigInt(params.amountIn),
      })
    : []
  const { hash } = await executeRhWalletCalls({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    account: params.account,
    calls: [...wrapCalls, ...swapCalls],
  })
  return { hash }
}

/** Parent bulk buy — amountHuman is per-token (caller splits). */
export async function executeRhParentKyberBuy(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  amountHuman: number
  tokenMints: GmgnBulkBuyItem[]
  slippageBps: number
  quote?: RhSwapQuote
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const quote = params.quote ?? 'ETH'
  const tokenIn = kyberQuoteTokenAddress(quote)
  const decimals = kyberQuoteDecimals(quote)
  const amountIn = toKyberAmountRaw(params.amountHuman, decimals)

  if (params.tokenMints.length === 0) {
    return { success: false, results: [] }
  }

  const prepared: Array<{ item: GmgnBulkBuyItem; calls: RhTxCall[] }> = []
  const prepFailures: GmgnBulkLegResult[] = []

  for (const item of params.tokenMints) {
    try {
      if (sameToken(tokenIn, item.tokenAddress)) {
        throw new Error('Cannot buy WETH with WETH')
      }
      const calls = await prepareKyberSwapCalls({
        publicClient: params.publicClient,
        account: params.account,
        tokenIn,
        tokenOut: item.tokenAddress,
        amountIn,
        slippageBps: params.slippageBps,
      })
      prepared.push({ item, calls })
    } catch (error) {
      prepFailures.push({
        tokenAddress: item.tokenAddress,
        symbol: item.symbol,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (prepared.length === 0) {
    return { success: false, results: prepFailures }
  }

  let wrapCalls: RhTxCall[] = []
  try {
    if (isRhWeth(tokenIn)) {
      const totalNeed =
        BigInt(amountIn) * BigInt(prepared.length)
      wrapCalls = await prepareWethWrapCalls({
        publicClient: params.publicClient,
        account: params.account,
        needWei: totalNeed,
      })
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      results: [
        ...prepFailures,
        ...prepared.map(({ item }) => ({
          tokenAddress: item.tokenAddress,
          symbol: item.symbol,
          success: false,
          error: msg,
        })),
      ],
    }
  }

  const flatCalls = [...wrapCalls, ...prepared.flatMap((p) => p.calls)]
  try {
    const { hash } = await executeRhWalletCalls({
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      account: params.account,
      calls: flatCalls,
    })
    const batchResults: GmgnBulkLegResult[] = prepared.map(({ item }) => ({
      tokenAddress: item.tokenAddress,
      symbol: item.symbol,
      success: true,
      hash,
      status: 'confirmed',
    }))
    const results = [...prepFailures, ...batchResults]
    return {
      success: results.length > 0 && results.every((r) => r.success),
      results,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      results: [
        ...prepFailures,
        ...prepared.map(({ item }) => ({
          tokenAddress: item.tokenAddress,
          symbol: item.symbol,
          success: false,
          error: msg,
        })),
      ],
    }
  }
}

/** Parent bulk sell — % of each token → ETH, USDG, or WETH via Kyber. */
export async function executeRhParentKyberSell(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  legs: Array<{ tokenAddress: string; percent: number; symbol?: string }>
  slippageBps: number
  quote?: RhSwapQuote
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const quote = params.quote ?? 'ETH'
  const tokenOut = kyberQuoteTokenAddress(quote)

  if (params.legs.length === 0) {
    return { success: false, results: [] }
  }

  const prepared: Array<{
    leg: (typeof params.legs)[number]
    calls: RhTxCall[]
  }> = []
  const prepFailures: GmgnBulkLegResult[] = []

  for (const leg of params.legs) {
    try {
      if (sameToken(leg.tokenAddress, tokenOut)) {
        throw new Error('Cannot sell WETH into WETH')
      }
      const pct = leg.percent
      if (!(pct > 0) || pct > 100) throw new Error('Sell % must be 1–100')
      const token = leg.tokenAddress as Address
      const balance = await params.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [params.account],
      })
      const amountIn =
        (balance * BigInt(Math.floor(pct * 100))) / BigInt(10_000)
      if (amountIn <= BigInt(0)) throw new Error('No token balance to sell')
      const calls = await prepareKyberSwapCalls({
        publicClient: params.publicClient,
        account: params.account,
        tokenIn: token,
        tokenOut,
        amountIn: amountIn.toString(),
        slippageBps: params.slippageBps,
      })
      prepared.push({ leg, calls })
    } catch (error) {
      prepFailures.push({
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (prepared.length === 0) {
    return { success: false, results: prepFailures }
  }

  const flatCalls = prepared.flatMap((p) => p.calls)
  try {
    const { hash } = await executeRhWalletCalls({
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      account: params.account,
      calls: flatCalls,
    })
    const batchResults: GmgnBulkLegResult[] = prepared.map(({ leg }) => ({
      tokenAddress: leg.tokenAddress,
      symbol: leg.symbol,
      success: true,
      hash,
      status: 'confirmed',
    }))
    const results = [...prepFailures, ...batchResults]
    return {
      success: results.length > 0 && results.every((r) => r.success),
      results,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      results: [
        ...prepFailures,
        ...prepared.map(({ leg }) => ({
          tokenAddress: leg.tokenAddress,
          symbol: leg.symbol,
          success: false,
          error: msg,
        })),
      ],
    }
  }
}
