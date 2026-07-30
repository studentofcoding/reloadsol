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
  PERMIT2,
  PERMIT2_MAX_UINT160,
  PERMIT2_MAX_UINT48,
  computePullAmounts,
  encodeExecuteBatch,
  getRhBatchExecutorAddress,
  isRhPermit2SwapsEnabled,
  permit2Abi,
  planExecutorBatch,
  type ExecutorSwapLeg,
} from '@/utils/dlmm/rh-batch-executor'
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

/** On-chain WETH wrap state for `needWei` (used by wrap + executor planning). */
export async function readWethWrapState(params: {
  publicClient: PublicClient
  account: Address
  needWei: bigint
}): Promise<{ shortfall: bigint; wethBal: bigint }> {
  if (params.needWei <= BigInt(0)) return { shortfall: BigInt(0), wethBal: BigInt(0) }
  const wethBal = await params.publicClient.readContract({
    address: RH_WETH,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [params.account],
  })
  return { shortfall: wethWrapShortfall(params.needWei, wethBal), wethBal }
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
  const { shortfall } = await readWethWrapState(params)
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
 * Approval strategy for prepared legs:
 *  - `router`  — legacy: per-leg approve(kyberRouter, maxUint256).
 *  - `permit2` — REL-7: one-time approve(Permit2, maxUint256) if the ERC20
 *    allowance to canonical Permit2 is short, plus
 *    permit2.approve(token, spender, maxUint160, maxUint48) when the Permit2
 *    allowance is short/expired. `spender` defaults to the leg's Kyber router;
 *    executor mode passes the BatchExecutor address instead.
 */
export type KyberApprovalPlan =
  | { mode: 'router' }
  | { mode: 'permit2'; spender?: Address }

/** Swap metadata needed to move a leg into the BatchExecutor (REL-6). */
export type KyberPreparedSwap = {
  router: Address
  data: `0x${string}`
  valueWei: bigint
  amountIn: bigint
}

/**
 * Parallel route+build for many legs: all Kyber /routes concurrently, then all
 * builds concurrently, then all allowance reads concurrently. Returns one
 * entry per leg (same order); failed legs carry an error message.
 * `buildSender` overrides the Kyber build sender (executor mode builds swaps
 * with sender = executor, recipient stays `account`).
 */
export async function prepareKyberSwapLegsParallel(params: {
  publicClient: PublicClient
  account: Address
  legs: Array<{ tokenIn: string; tokenOut: string; amountIn: string }>
  slippageBps: number
  approval?: KyberApprovalPlan
  buildSender?: Address
}): Promise<Array<{ calls: RhTxCall[]; swap: KyberPreparedSwap } | { error: string }>> {
  const { publicClient, account, legs, slippageBps } = params
  const approval: KyberApprovalPlan = params.approval ?? { mode: 'router' }
  const buildSender = params.buildSender ?? account
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
            sender: buildSender,
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

  // Phase 3: all allowance reads concurrently, then assemble calls per leg.
  // Router mode: one ERC20 allowance read per leg (account → router).
  // Permit2 mode: ERC20 allowance (account → Permit2) + Permit2 allowance
  // (account, token, spender) per leg — still fully parallel.
  type AllowanceState =
    | { mode: 'router'; routerAllowance: bigint }
    | { mode: 'permit2'; permit2Erc20Allowance: bigint; allowedAmount: bigint; expiration: number }
  const allowanceStates = await Promise.all(
    builds.map(async (built, i): Promise<Error | AllowanceState> => {
      if (built instanceof Error) return built
      const leg = legs[i]
      if (isKyberNative(leg.tokenIn)) {
        return approval.mode === 'permit2'
          ? { mode: 'permit2', permit2Erc20Allowance: maxUint256, allowedAmount: maxUint256, expiration: Number.MAX_SAFE_INTEGER }
          : { mode: 'router', routerAllowance: maxUint256 }
      }
      const token = leg.tokenIn as Address
      try {
        if (approval.mode === 'router') {
          const routerAllowance = await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, built.routerAddress],
          })
          return { mode: 'router', routerAllowance }
        }
        const spender = approval.spender ?? built.routerAddress
        const [permit2Erc20Allowance, p2] = await Promise.all([
          publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [account, PERMIT2],
          }),
          publicClient.readContract({
            address: PERMIT2,
            abi: permit2Abi,
            functionName: 'allowance',
            args: [account, token, spender],
          }),
        ])
        return {
          mode: 'permit2',
          permit2Erc20Allowance,
          allowedAmount: p2[0],
          expiration: Number(p2[1]),
        }
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e))
      }
    }),
  )

  const now = Math.floor(Date.now() / 1000)
  return legs.map((leg, i) => {
    const built = builds[i]
    if (built instanceof Error) return { error: built.message }
    const state = allowanceStates[i]
    if (state instanceof Error) return { error: state.message }
    const swap: KyberPreparedSwap = {
      router: built.routerAddress,
      data: built.data,
      valueWei: built.valueWei,
      amountIn: BigInt(built.amountIn),
    }
    const calls: RhTxCall[] = []
    if (!isKyberNative(leg.tokenIn)) {
      const token = leg.tokenIn as Address
      const amountIn = swap.amountIn
      if (state.mode === 'router') {
        if (state.routerAllowance < amountIn) {
          calls.push({
            to: token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [built.routerAddress, maxUint256],
            }),
          })
        }
      } else {
        // REL-7: Permit2 path (mirrors v4.ts planPermit2Calls).
        if (state.permit2Erc20Allowance < amountIn) {
          calls.push({
            to: token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [PERMIT2, maxUint256],
            }),
          })
        }
        const spender = (approval as { mode: 'permit2'; spender?: Address }).spender ?? built.routerAddress
        const need = amountIn > PERMIT2_MAX_UINT160 ? PERMIT2_MAX_UINT160 : amountIn
        if (state.allowedAmount < need || state.expiration <= now + 60) {
          calls.push({
            to: PERMIT2,
            data: encodeFunctionData({
              abi: permit2Abi,
              functionName: 'approve',
              args: [token, spender, PERMIT2_MAX_UINT160, Number(PERMIT2_MAX_UINT48)],
            }),
          })
        }
      }
    }
    calls.push({
      to: built.routerAddress,
      data: built.data,
      value: built.valueWei,
    })
    return { calls, swap }
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

  const prepared: Array<{
    item: GmgnBulkBuyItem
    calls: RhTxCall[]
    swap: KyberPreparedSwap
  }> = []
  const prepFailures: GmgnBulkLegResult[] = []

  // Mode selection (REL-6 / REL-7):
  //   executor configured → Permit2 approvals to the executor + one atomic
  //     executeBatch tx (wallet signs once regardless of EIP-5792);
  //   else RH_PERMIT2_SWAPS=1 → Permit2 approvals to the Kyber router;
  //   else legacy per-leg approve(router, maxUint256) — unchanged default.
  const executor = getRhBatchExecutorAddress()
  const approval: KyberApprovalPlan = executor
    ? { mode: 'permit2', spender: executor }
    : isRhPermit2SwapsEnabled()
      ? { mode: 'permit2' }
      : { mode: 'router' }

  const legPlans = await prepareKyberSwapLegsParallel({
    publicClient: params.publicClient,
    account: params.account,
    legs: params.tokenMints.map((item) => ({
      tokenIn,
      tokenOut: item.tokenAddress,
      amountIn,
    })),
    slippageBps: params.slippageBps,
    approval,
    buildSender: executor ?? undefined,
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
      prepared.push({ item, calls: plan.calls, swap: plan.swap })
    }
  })

  if (prepared.length === 0) {
    return { success: false, results: prepFailures }
  }

  // ── REL-6: executor mode — ONE atomic executeBatch tx for wrap+N swaps ──
  if (executor) {
    const nativeIn = isKyberNative(tokenIn)
    let wethWrapWei = BigInt(0)
    let pullAmounts: bigint[]
    try {
      if (nativeIn) {
        pullAmounts = prepared.map(() => BigInt(0))
      } else if (isRhWeth(tokenIn)) {
        const totalNeed = BigInt(amountIn) * BigInt(prepared.length)
        const { shortfall, wethBal } = await readWethWrapState({
          publicClient: params.publicClient,
          account: params.account,
          needWei: totalNeed,
        })
        if (shortfall > BigInt(0)) {
          const ethBal = await params.publicClient.getBalance({
            address: params.account,
          })
          const reserve = GAS_RESERVE_WEI[RH_CHAIN_ID]
          if (ethBal < shortfall + reserve) {
            throw new Error(
              'Insufficient ETH/WETH (need wrap shortfall + gas reserve)',
            )
          }
        }
        wethWrapWei = shortfall
        // Pull only what the wallet already holds as WETH; the shortfall is
        // wrapped from native ETH inside the executor batch.
        pullAmounts = computePullAmounts(
          prepared.map((p) => p.swap.amountIn),
          wethBal,
        )
      } else {
        pullAmounts = prepared.map((p) => p.swap.amountIn)
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

    const execLegs: ExecutorSwapLeg[] = prepared.map((p, idx) => ({
      nativeIn,
      tokenIn: nativeIn ? undefined : (tokenIn as Address),
      router: p.swap.router,
      pullAmount: pullAmounts[idx],
      approveAmount: p.swap.amountIn,
      swapData: p.swap.data,
      swapValueWei: p.swap.valueWei,
    }))
    const { batch, txValue } = planExecutorBatch({
      executor,
      account: params.account,
      wethWrapWei,
      legs: execLegs,
    })
    const batchCall: RhTxCall = {
      to: executor,
      data: encodeExecuteBatch(batch),
      value: txValue,
    }
    // Wallet calls: per-leg Permit2 approvals (everything but the direct swap
    // call, which moves inside the batch), then the single atomic batch tx.
    const walletCalls: RhTxCall[] = [
      ...prepared.flatMap((p) => p.calls.slice(0, -1)),
      batchCall,
    ]
    try {
      const { hash } = await executeRhWalletCalls({
        publicClient: params.publicClient,
        walletClient: params.walletClient,
        account: params.account,
        calls: walletCalls,
      })
      // Atomic: one hash confirms every leg.
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
      // Executor batch is all-or-nothing: if it (or a preceding approval)
      // failed, no leg executed.
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

  // ── Legacy / Permit2 wallet path (5792 → sequential fallback) ──
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
  // (mode selection mirrors the buy path — see executeRhParentKyberBuy).
  const executor = getRhBatchExecutorAddress()
  const approval: KyberApprovalPlan = executor
    ? { mode: 'permit2', spender: executor }
    : isRhPermit2SwapsEnabled()
      ? { mode: 'permit2' }
      : { mode: 'router' }
  const legPlans = await prepareKyberSwapLegsParallel({
    publicClient: params.publicClient,
    account: params.account,
    legs: sellable.map(({ leg, amountIn }) => ({
      tokenIn: leg.tokenAddress,
      tokenOut,
      amountIn,
    })),
    slippageBps: params.slippageBps,
    approval,
    buildSender: executor ?? undefined,
  })

  const prepared: Array<{
    leg: (typeof params.legs)[number]
    calls: RhTxCall[]
    swap: KyberPreparedSwap
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
      prepared.push({ leg, calls: plan.calls, swap: plan.swap })
    }
  })

  if (prepared.length === 0) {
    return { success: false, results: prepFailures }
  }

  // ── REL-6: executor mode — ONE atomic executeBatch tx for N sells ──
  if (executor) {
    const execLegs: ExecutorSwapLeg[] = prepared.map((p) => ({
      nativeIn: false,
      tokenIn: p.leg.tokenAddress as Address,
      router: p.swap.router,
      pullAmount: p.swap.amountIn,
      approveAmount: p.swap.amountIn,
      swapData: p.swap.data,
      swapValueWei: p.swap.valueWei,
    }))
    const { batch, txValue } = planExecutorBatch({
      executor,
      account: params.account,
      wethWrapWei: BigInt(0),
      legs: execLegs,
    })
    const batchCall: RhTxCall = {
      to: executor,
      data: encodeExecuteBatch(batch),
      value: txValue,
    }
    const walletCalls: RhTxCall[] = [
      ...prepared.flatMap((p) => p.calls.slice(0, -1)),
      batchCall,
    ]
    try {
      const { hash } = await executeRhWalletCalls({
        publicClient: params.publicClient,
        walletClient: params.walletClient,
        account: params.account,
        calls: walletCalls,
      })
      // Atomic: one hash confirms every leg.
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
      // All-or-nothing (see buy path).
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
