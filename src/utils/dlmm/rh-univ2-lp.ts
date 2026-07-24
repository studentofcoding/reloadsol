/**
 * Parent UniV2 (DAMM) zap-add / remove — calldata + sendCalls batching.
 */

import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { executeRhWalletCalls, type RhTxCall } from '@/utils/dlmm/rh-send-calls'
import {
  RH_V2_ROUTER,
  RH_WETH,
  applySlippageMinOut,
  erc20Abi,
  univ2PairAbi,
  univ2RouterAbi,
  wethAbi,
  zapSplitQuote,
} from '@/utils/dlmm/rh-univ2'

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
}

async function readAllowance(
  publicClient: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
}

function approveCall(token: Address, spender: Address, amount: bigint): RhTxCall {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    }),
  }
}

/** Pure: wrap? + approve quote + swap + approve base/quote + addLiquidity. */
export function buildRhUniv2ZapAddCalls(params: {
  account: Address
  quoteAddress: Address
  baseAddress: Address
  quoteAmount: bigint
  wrapEthAmount: bigint
  swapAmount: bigint
  remainAmount: bigint
  expectedBase: bigint
  minSwapOut: bigint
  amountAMin: bigint
  amountBMin: bigint
  quoteAllowance: bigint
  baseAllowance: bigint
  deadlineTs: bigint
}): RhTxCall[] {
  const {
    account,
    quoteAddress,
    baseAddress,
    quoteAmount,
    wrapEthAmount,
    swapAmount,
    remainAmount,
    expectedBase,
    minSwapOut,
    amountAMin,
    amountBMin,
    quoteAllowance,
    baseAllowance,
    deadlineTs,
  } = params
  const calls: RhTxCall[] = []

  if (wrapEthAmount > BigInt(0)) {
    calls.push({
      to: RH_WETH,
      data: encodeFunctionData({
        abi: wethAbi,
        functionName: 'deposit',
      }),
      value: wrapEthAmount,
    })
  }

  // One max approve for full quote (covers swap + remain add)
  if (quoteAllowance < quoteAmount) {
    calls.push(approveCall(quoteAddress, RH_V2_ROUTER, maxUint256))
  }

  calls.push({
    to: RH_V2_ROUTER,
    data: encodeFunctionData({
      abi: univ2RouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [
        swapAmount,
        minSwapOut,
        [quoteAddress, baseAddress],
        account,
        deadlineTs,
      ],
    }),
  })

  if (baseAllowance < expectedBase) {
    calls.push(approveCall(baseAddress, RH_V2_ROUTER, maxUint256))
  }

  // Quote approve already max'd above when needed; skip second approve
  calls.push({
    to: RH_V2_ROUTER,
    data: encodeFunctionData({
      abi: univ2RouterAbi,
      functionName: 'addLiquidity',
      args: [
        quoteAddress,
        baseAddress,
        remainAmount,
        expectedBase,
        amountAMin,
        amountBMin,
        account,
        deadlineTs,
      ],
    }),
  })

  return calls
}

/** Pure: approve LP (if needed) + removeLiquidity. */
export function buildRhUniv2RemoveCalls(params: {
  account: Address
  lp: Address
  token0: Address
  token1: Address
  lpBal: bigint
  lpAllowance: bigint
  deadlineTs: bigint
}): RhTxCall[] {
  const { account, lp, token0, token1, lpBal, lpAllowance, deadlineTs } = params
  const calls: RhTxCall[] = []
  if (lpAllowance < lpBal) {
    calls.push(approveCall(lp, RH_V2_ROUTER, maxUint256))
  }
  calls.push({
    to: RH_V2_ROUTER,
    data: encodeFunctionData({
      abi: univ2RouterAbi,
      functionName: 'removeLiquidity',
      args: [token0, token1, lpBal, BigInt(0), BigInt(0), account, deadlineTs],
    }),
  })
  return calls
}

export async function executeRhUniv2ZapAdd(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  quoteAddress: Address
  baseAddress: Address
  quoteAmount: bigint
  slippageBps: number
}): Promise<{ hash: string }> {
  const {
    publicClient,
    walletClient,
    account,
    quoteAddress,
    baseAddress,
    quoteAmount,
    slippageBps,
  } = params

  let wrapEthAmount = BigInt(0)
  if (quoteAddress.toLowerCase() === RH_WETH.toLowerCase()) {
    const wethBal = await publicClient.readContract({
      address: RH_WETH,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    })
    if (wethBal < quoteAmount) {
      wrapEthAmount = quoteAmount - wethBal
      const ethBal = await publicClient.getBalance({ address: account })
      if (ethBal < wrapEthAmount) {
        throw new Error('Insufficient ETH/WETH for deposit')
      }
    }
  }

  const { swapAmount, remainAmount } = zapSplitQuote(quoteAmount)
  if (swapAmount <= BigInt(0) || remainAmount <= BigInt(0)) {
    throw new Error('Amount too small to zap (need both swap + remain legs)')
  }

  const amountsOut = await publicClient.readContract({
    address: RH_V2_ROUTER,
    abi: univ2RouterAbi,
    functionName: 'getAmountsOut',
    args: [swapAmount, [quoteAddress, baseAddress]],
  })
  const expectedBase = amountsOut[1] ?? BigInt(0)
  if (expectedBase <= BigInt(0)) {
    throw new Error('Router returned 0 base out — check pool liquidity')
  }
  const minSwapOut = applySlippageMinOut(expectedBase, slippageBps)
  const amountAMin = applySlippageMinOut(remainAmount, slippageBps)
  const amountBMin = applySlippageMinOut(expectedBase, slippageBps)

  const [quoteAllowance, baseAllowance] = await Promise.all([
    readAllowance(publicClient, quoteAddress, account, RH_V2_ROUTER),
    readAllowance(publicClient, baseAddress, account, RH_V2_ROUTER),
  ])

  const calls = buildRhUniv2ZapAddCalls({
    account,
    quoteAddress,
    baseAddress,
    quoteAmount,
    wrapEthAmount,
    swapAmount,
    remainAmount,
    expectedBase,
    minSwapOut,
    amountAMin,
    amountBMin,
    quoteAllowance,
    baseAllowance,
    deadlineTs: deadline(),
  })

  const { hash } = await executeRhWalletCalls({
    publicClient,
    walletClient,
    account,
    calls,
  })
  return { hash }
}

export async function executeRhUniv2RemoveLp(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  lp: Address
}): Promise<{ hash: string }> {
  const { publicClient, walletClient, account, lp } = params
  const lpBal = await publicClient.readContract({
    address: lp,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })
  if (lpBal <= BigInt(0)) throw new Error('No LP tokens in wallet')

  const [token0, token1, lpAllowance] = await Promise.all([
    publicClient.readContract({
      address: lp,
      abi: univ2PairAbi,
      functionName: 'token0',
    }),
    publicClient.readContract({
      address: lp,
      abi: univ2PairAbi,
      functionName: 'token1',
    }),
    readAllowance(publicClient, lp, account, RH_V2_ROUTER),
  ])

  const calls = buildRhUniv2RemoveCalls({
    account,
    lp,
    token0,
    token1,
    lpBal,
    lpAllowance,
    deadlineTs: deadline(),
  })

  const { hash } = await executeRhWalletCalls({
    publicClient,
    walletClient,
    account,
    calls,
  })
  return { hash }
}
