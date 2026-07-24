/**
 * Parent-wallet (Rabby) token swaps on Robinhood via UniV2.
 * Bound wallet keeps GMGN server-sign — see GMGN_PARENT_FROM_SUPPORTED.
 */

import {
  encodeFunctionData,
  parseEther,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { sendCalls, waitForCallsStatus } from 'viem/actions'
import type { GmgnBulkBuyItem, GmgnBulkLegResult } from '@/utils/gmgn-bulk-trade'
import {
  executeRhWalletCalls,
  shouldFallbackFromSendCalls,
  type RhTxCall,
} from '@/utils/dlmm/rh-send-calls'
import {
  RH_V2_FACTORY,
  RH_V2_ROUTER,
  RH_WETH,
  applySlippageMinOut,
  erc20Abi,
  normalizeAddress,
  univ2FactoryAbi,
  univ2RouterAbi,
} from '@/utils/dlmm/rh-univ2'

const ZERO = '0x0000000000000000000000000000000000000000'

export type RhUniv2TxCall = RhTxCall

async function requireWethPair(
  publicClient: PublicClient,
  token: Address,
): Promise<void> {
  const pair = await publicClient.readContract({
    address: RH_V2_FACTORY,
    abi: univ2FactoryAbi,
    functionName: 'getPair',
    args: [RH_WETH, token],
  })
  if (!pair || normalizeAddress(pair) === ZERO) {
    throw new Error('No UniV2 WETH pair for token — cannot parent-swap')
  }
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
}

/** Pure encode: approve (if allowance < amountIn) + swapExactTokensForETH. */
export function buildRhUniv2SellCalls(params: {
  token: Address
  account: Address
  amountIn: bigint
  minOut: bigint
  allowance: bigint
  deadlineTs: bigint
}): RhUniv2TxCall[] {
  const { token, account, amountIn, minOut, allowance, deadlineTs } = params
  const calls: RhUniv2TxCall[] = []
  if (allowance < amountIn) {
    calls.push({
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [RH_V2_ROUTER, amountIn],
      }),
    })
  }
  const path = [token, RH_WETH] as Address[]
  calls.push({
    to: RH_V2_ROUTER,
    data: encodeFunctionData({
      abi: univ2RouterAbi,
      functionName: 'swapExactTokensForETH',
      args: [amountIn, minOut, path, account, deadlineTs],
    }),
  })
  return calls
}

/** Reads balance / quote / allowance, then builds approve+swap calldata. */
export async function prepareRhUniv2SellLegCalls(params: {
  publicClient: PublicClient
  account: Address
  token: Address
  percent: number
  slippageBps: number
  deadlineTs?: bigint
}): Promise<RhUniv2TxCall[]> {
  const { publicClient, account, token, slippageBps } = params
  const pct = params.percent
  if (!(pct > 0) || pct > 100) throw new Error('Sell % must be 1–100')
  await requireWethPair(publicClient, token)
  const balance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })
  const amountIn = (balance * BigInt(Math.floor(pct * 100))) / BigInt(10_000)
  if (amountIn <= BigInt(0)) throw new Error('No token balance to sell')
  const path = [token, RH_WETH] as Address[]
  const amounts = await publicClient.readContract({
    address: RH_V2_ROUTER,
    abi: univ2RouterAbi,
    functionName: 'getAmountsOut',
    args: [amountIn, path],
  })
  const expected = amounts[amounts.length - 1]!
  const minOut = applySlippageMinOut(expected, slippageBps)
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, RH_V2_ROUTER],
  })
  return buildRhUniv2SellCalls({
    token,
    account,
    amountIn,
    minOut,
    allowance,
    deadlineTs: params.deadlineTs ?? deadline(),
  })
}

export async function rhUniv2BuyExactEth(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  token: Address
  amountEthHuman: number
  slippageBps: number
}): Promise<{ hash: string }> {
  const { publicClient, walletClient, account, token, slippageBps } = params
  if (!(params.amountEthHuman > 0)) throw new Error('ETH amount must be > 0')
  await requireWethPair(publicClient, token)
  const amountIn = parseEther(String(params.amountEthHuman))
  const path = [RH_WETH, token] as Address[]
  const amounts = await publicClient.readContract({
    address: RH_V2_ROUTER,
    abi: univ2RouterAbi,
    functionName: 'getAmountsOut',
    args: [amountIn, path],
  })
  const expected = amounts[amounts.length - 1]!
  const minOut = applySlippageMinOut(expected, slippageBps)
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: RH_V2_ROUTER,
    abi: univ2RouterAbi,
    functionName: 'swapExactETHForTokens',
    args: [minOut, path, account, deadline()],
    value: amountIn,
  })
  await publicClient.waitForTransactionReceipt({ hash })
  return { hash }
}

export async function rhUniv2SellTokenPercent(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  token: Address
  percent: number
  slippageBps: number
}): Promise<{ hash: string }> {
  const calls = await prepareRhUniv2SellLegCalls({
    publicClient: params.publicClient,
    account: params.account,
    token: params.token,
    percent: params.percent,
    slippageBps: params.slippageBps,
  })
  const { hash } = await executeRhWalletCalls({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    account: params.account,
    calls,
  })
  return { hash }
}

/** Sequential parent buys — same shape as executeGmgnBulkBuy results. */
export async function executeRhParentBulkBuy(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  amountHuman: number
  tokenMints: GmgnBulkBuyItem[]
  slippageBps: number
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const results: GmgnBulkLegResult[] = []
  for (const item of params.tokenMints) {
    try {
      const { hash } = await rhUniv2BuyExactEth({
        publicClient: params.publicClient,
        walletClient: params.walletClient,
        account: params.account,
        token: item.tokenAddress as Address,
        amountEthHuman: params.amountHuman,
        slippageBps: params.slippageBps,
      })
      results.push({
        tokenAddress: item.tokenAddress,
        symbol: item.symbol,
        success: true,
        hash,
        status: 'confirmed',
      })
    } catch (error) {
      results.push({
        tokenAddress: item.tokenAddress,
        symbol: item.symbol,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    success: results.length > 0 && results.every((r) => r.success),
    results,
  }
}

async function executeRhParentBulkSellSequential(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  legs: Array<{ tokenAddress: string; percent: number; symbol?: string }>
  slippageBps: number
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const results: GmgnBulkLegResult[] = []
  for (const leg of params.legs) {
    try {
      const { hash } = await rhUniv2SellTokenPercent({
        publicClient: params.publicClient,
        walletClient: params.walletClient,
        account: params.account,
        token: leg.tokenAddress as Address,
        percent: leg.percent,
        slippageBps: params.slippageBps,
      })
      results.push({
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: true,
        hash,
        status: 'confirmed',
      })
    } catch (error) {
      results.push({
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    success: results.length > 0 && results.every((r) => r.success),
    results,
  }
}

export async function executeRhParentBulkSell(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  legs: Array<{ tokenAddress: string; percent: number; symbol?: string }>
  slippageBps: number
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  if (params.legs.length <= 1) {
    return executeRhParentBulkSellSequential(params)
  }

  const deadlineTs = deadline()
  const prepared: Array<{
    leg: (typeof params.legs)[number]
    calls: RhUniv2TxCall[]
  }> = []
  const prepFailures: GmgnBulkLegResult[] = []

  for (const leg of params.legs) {
    try {
      const calls = await prepareRhUniv2SellLegCalls({
        publicClient: params.publicClient,
        account: params.account,
        token: leg.tokenAddress as Address,
        percent: leg.percent,
        slippageBps: params.slippageBps,
        deadlineTs,
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

  if (prepared.length === 1) {
    const only = prepared[0]!
    try {
      const { hash } = await executeRhWalletCalls({
        publicClient: params.publicClient,
        walletClient: params.walletClient,
        account: params.account,
        calls: only.calls,
      })
      return {
        success: prepFailures.length === 0,
        results: [
          ...prepFailures,
          {
            tokenAddress: only.leg.tokenAddress,
            symbol: only.leg.symbol,
            success: true,
            hash,
            status: 'confirmed',
          },
        ],
      }
    } catch (error) {
      return {
        success: false,
        results: [
          ...prepFailures,
          {
            tokenAddress: only.leg.tokenAddress,
            symbol: only.leg.symbol,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  }

  const flatCalls = prepared.flatMap((p) => p.calls)
  try {
    const { id } = await sendCalls(params.walletClient, {
      account: params.account,
      chain: params.walletClient.chain,
      calls: flatCalls.map((c) => ({
        to: c.to,
        data: c.data,
        value: c.value ?? BigInt(0),
      })),
    })
    const status = await waitForCallsStatus(params.walletClient, { id })
    const ok = status.status === 'success'
    const hash =
      status.receipts?.find((r) => r.transactionHash)?.transactionHash ?? id
    const batchResults: GmgnBulkLegResult[] = prepared.map(({ leg }) =>
      ok
        ? {
            tokenAddress: leg.tokenAddress,
            symbol: leg.symbol,
            success: true,
            hash,
            status: 'confirmed',
          }
        : {
            tokenAddress: leg.tokenAddress,
            symbol: leg.symbol,
            success: false,
            hash,
            error: `Batch status: ${status.status ?? 'unknown'}`,
          },
    )
    const results = [...prepFailures, ...batchResults]
    return {
      success: results.length > 0 && results.every((r) => r.success),
      results,
    }
  } catch (error) {
    if (!shouldFallbackFromSendCalls(error)) {
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
    // Capability / method missing → existing sequential approve+swap per leg
    const seq = await executeRhParentBulkSellSequential({
      ...params,
      legs: prepared.map((p) => p.leg),
    })
    return {
      success:
        prepFailures.length === 0 &&
        seq.results.length > 0 &&
        seq.results.every((r) => r.success),
      results: [...prepFailures, ...seq.results],
    }
  }
}
