/**
 * Parent-wallet (Rabby) RH swaps via Kyber Aggregator.
 * Bound wallet keeps GMGN server-sign.
 */

import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import type { GmgnBulkBuyItem, GmgnBulkLegResult } from '@/utils/gmgn-bulk-trade'
import {
  executeRhWalletCalls,
  RhSequentialWriteError,
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

type KyberBuilt = Awaited<ReturnType<typeof quoteAndBuild>>

/**
 * Parallel route+build for many legs: all Kyber /routes concurrently, then all
 * builds concurrently, then all allowance reads concurrently. Returns one
 * entry per leg (same order); failed legs carry an error message.
 */
export async function prepareKyberSwapLegsParallel(params: {
  publicClient: PublicClient
  account: Address
  legs: Array<{ tokenIn: string; tokenOut: string; amountIn: string }>
  slippageBps: number
}): Promise<Array<{ calls: RhTxCall[] } | { error: string }>> {
  const { publicClient, account, legs, slippageBps } = params
  if (legs.length === 0) return []

  // Phase 1: all routes concurrently (per-leg errors isolated)
  const routes = await Promise.all(
    legs.map((leg) =>
      sameToken(leg.tokenIn, leg.tokenOut)
        ? Promise.resolve<Error | Awaited<ReturnType<typeof clientKyberRoute>>>(
            new Error('tokenIn and tokenOut must differ'),
          )
        : clientKyberRoute({
            tokenIn: leg.tokenIn,
            tokenOut: leg.tokenOut,
            amountIn: leg.amountIn,
          }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ),
  )

  // Phase 2: all builds concurrently (skip legs whose route failed)
  const builds = await Promise.all(
    routes.map((route) =>
      route instanceof Error
        ? Promise.resolve<Error | KyberBuilt>(route)
        : clientKyberBuild({
            routeSummary: route.routeSummary,
            sender: account,
            recipient: account,
            slippageTolerance: slippageBps,
          })
            .then((build): KyberBuilt => {
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
            })
            .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ),
  )

  // Phase 3: all allowance reads concurrently, then assemble calls per leg
  const allowances = await Promise.all(
    builds.map((built, i) => {
      if (built instanceof Error) return Promise.resolve<Error | bigint>(built)
      const leg = legs[i]
      if (isKyberNative(leg.tokenIn)) return Promise.resolve<bigint>(maxUint256)
      return publicClient
        .readContract({
          address: leg.tokenIn as Address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account, built.routerAddress],
        })
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    }),
  )

  return legs.map((leg, i) => {
    const built = builds[i]
    if (built instanceof Error) return { error: built.message }
    const allowance = allowances[i]
    if (allowance instanceof Error) return { error: allowance.message }
    const calls: RhTxCall[] = []
    if (!isKyberNative(leg.tokenIn)) {
      const amountIn = BigInt(built.amountIn)
      if (allowance < amountIn) {
        calls.push({
          to: leg.tokenIn as Address,
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
    return { calls }
  })
}

/**
 * Per-leg execution results. A leg is confirmed only when its final call index
 * is below `failedCallIndex` (sequential fallback) or when the whole batch
 * succeeded (`failedCallIndex === null`). Pure — unit tested.
 */
export function buildKyberLegResults(params: {
  legs: Array<{ tokenAddress: string; symbol?: string }>
  /** Flat-call index of each leg's last call (same order as `legs`). */
  legEndCallIndex: number[]
  /** Per-leg tx hash of its last confirmed call, when known. */
  legHashes: Array<string | undefined>
  /** Flat-call index where sequential execution failed, or null on success. */
  failedCallIndex: number | null
  /** Batch/last hash used for confirmed legs without an individual hash. */
  batchHash?: string
  error?: string
}): GmgnBulkLegResult[] {
  return params.legs.map((leg, i) => {
    const confirmed =
      params.failedCallIndex == null ||
      params.legEndCallIndex[i] < params.failedCallIndex
    if (confirmed) {
      const hash = params.legHashes[i] ?? params.batchHash
      return {
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: true,
        ...(hash ? { hash } : {}),
        status: 'confirmed',
      }
    }
    return {
      tokenAddress: leg.tokenAddress,
      symbol: leg.symbol,
      success: false,
      error: params.error ?? 'Execution failed before this leg confirmed',
    }
  })
}

/**
 * Flatten wrap + per-leg calls and precompute the leg mapping so a mid-batch
 * sequential failure can be attributed to an exact leg index.
 */
export function planKyberLegCalls(
  wrapCalls: RhTxCall[],
  prepared: Array<{ calls: RhTxCall[] }>,
): {
  flatCalls: RhTxCall[]
  callLeg: number[]
  legEndCallIndex: number[]
  legHashes: (string | undefined)[]
  onProgress: (callIndex: number, hash: Hex) => void
} {
  const flatCalls = [...wrapCalls, ...prepared.flatMap((p) => p.calls)]
  const callLeg = new Array<number>(flatCalls.length).fill(-1)
  const legEndCallIndex: number[] = []
  let cursor = wrapCalls.length
  prepared.forEach((p, legIdx) => {
    for (let k = 0; k < p.calls.length; k++) callLeg[cursor + k] = legIdx
    cursor += p.calls.length
    legEndCallIndex.push(cursor - 1)
  })
  const legHashes: (string | undefined)[] = new Array(prepared.length).fill(undefined)
  const onProgress = (callIndex: number, hash: Hex) => {
    const leg = callLeg[callIndex]
    if (leg >= 0 && callIndex === legEndCallIndex[leg]) {
      legHashes[leg] = hash
    }
  }
  return { flatCalls, callLeg, legEndCallIndex, legHashes, onProgress }
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

  const legPlans = await prepareKyberSwapLegsParallel({
    publicClient: params.publicClient,
    account: params.account,
    legs: params.tokenMints.map((item) => ({
      tokenIn,
      tokenOut: item.tokenAddress,
      amountIn,
    })),
    slippageBps: params.slippageBps,
  })
  legPlans.forEach((plan, i) => {
    const item = params.tokenMints[i]
    if ('error' in plan) {
      prepFailures.push({
        tokenAddress: item.tokenAddress,
        symbol: item.symbol,
        success: false,
        error: sameToken(tokenIn, item.tokenAddress)
          ? 'Cannot buy WETH with WETH'
          : plan.error,
      })
    } else {
      prepared.push({ item, calls: plan.calls })
    }
  })

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

  const plan = planKyberLegCalls(wrapCalls, prepared)
  try {
    const { hash } = await executeRhWalletCalls({
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      account: params.account,
      calls: plan.flatCalls,
      onProgress: plan.onProgress,
    })
    const batchResults = buildKyberLegResults({
      legs: prepared.map(({ item }) => item),
      legEndCallIndex: plan.legEndCallIndex,
      legHashes: plan.legHashes,
      failedCallIndex: null,
      batchHash: hash,
    })
    const results = [...prepFailures, ...batchResults]
    return {
      success: results.length > 0 && results.every((r) => r.success),
      results,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Sequential fallback: legs fully confirmed before the failure index keep
    // their own success + hash; the failed leg and everything after it is
    // marked failed so partial buys stay recoverable/reconcilable.
    const failedCallIndex =
      error instanceof RhSequentialWriteError ? error.callIndex : 0
    const legResults = buildKyberLegResults({
      legs: prepared.map(({ item }) => item),
      legEndCallIndex: plan.legEndCallIndex,
      legHashes: plan.legHashes,
      failedCallIndex,
      batchHash: error instanceof RhSequentialWriteError ? error.lastHash : undefined,
      error: msg,
    })
    return {
      success: false,
      results: [...prepFailures, ...legResults],
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

  // Phase 1: validate + balance reads concurrently
  const balancePlans = await Promise.all(
    params.legs.map((leg) =>
      (async () => {
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
        return { leg, amountIn: amountIn.toString() }
      })().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    ),
  )

  const sellable: Array<{ leg: (typeof params.legs)[number]; amountIn: string }> = []
  const prepFailures: GmgnBulkLegResult[] = []
  balancePlans.forEach((plan, i) => {
    const leg = params.legs[i]
    if (plan instanceof Error) {
      prepFailures.push({
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: false,
        error: plan.message,
      })
    } else {
      sellable.push(plan)
    }
  })

  // Phase 2: parallel route+build for the sellable legs
  const legPlans = await prepareKyberSwapLegsParallel({
    publicClient: params.publicClient,
    account: params.account,
    legs: sellable.map(({ leg, amountIn }) => ({
      tokenIn: leg.tokenAddress,
      tokenOut,
      amountIn,
    })),
    slippageBps: params.slippageBps,
  })

  const prepared: Array<{
    leg: (typeof params.legs)[number]
    calls: RhTxCall[]
  }> = []
  legPlans.forEach((plan, i) => {
    const { leg } = sellable[i]
    if ('error' in plan) {
      prepFailures.push({
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: false,
        error: plan.error,
      })
    } else {
      prepared.push({ leg, calls: plan.calls })
    }
  })

  if (prepared.length === 0) {
    return { success: false, results: prepFailures }
  }

  const plan = planKyberLegCalls([], prepared.map((p) => ({ calls: p.calls })))
  try {
    const { hash } = await executeRhWalletCalls({
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      account: params.account,
      calls: plan.flatCalls,
      onProgress: plan.onProgress,
    })
    const batchResults = buildKyberLegResults({
      legs: prepared.map(({ leg }) => leg),
      legEndCallIndex: plan.legEndCallIndex,
      legHashes: plan.legHashes,
      failedCallIndex: null,
      batchHash: hash,
    })
    const results = [...prepFailures, ...batchResults]
    return {
      success: results.length > 0 && results.every((r) => r.success),
      results,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Per-leg attribution for the sequential fallback (see buy path).
    const failedCallIndex =
      error instanceof RhSequentialWriteError ? error.callIndex : 0
    const legResults = buildKyberLegResults({
      legs: prepared.map(({ leg }) => leg),
      legEndCallIndex: plan.legEndCallIndex,
      legHashes: plan.legHashes,
      failedCallIndex,
      batchHash: error instanceof RhSequentialWriteError ? error.lastHash : undefined,
      error: msg,
    })
    return {
      success: false,
      results: [...prepFailures, ...legResults],
    }
  }
}
