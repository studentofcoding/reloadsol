/**
 * Parent-wallet (Rabby) token swaps on Robinhood via UniV2.
 * Bound wallet keeps GMGN server-sign — see GMGN_PARENT_FROM_SUPPORTED.
 */

import { parseEther, type Address, type PublicClient, type WalletClient } from 'viem'
import type { GmgnBulkBuyItem, GmgnBulkLegResult } from '@/utils/gmgn-bulk-trade'
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
  const { publicClient, walletClient, account, token, slippageBps } = params
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
  if (allowance < amountIn) {
    const approveHash = await walletClient.writeContract({
      account,
      chain: walletClient.chain,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [RH_V2_ROUTER, amountIn],
    })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
  }
  const hash = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: RH_V2_ROUTER,
    abi: univ2RouterAbi,
    functionName: 'swapExactTokensForETH',
    args: [amountIn, minOut, path, account, deadline()],
  })
  await publicClient.waitForTransactionReceipt({ hash })
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

export async function executeRhParentBulkSell(params: {
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
