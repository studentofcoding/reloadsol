/**
 * Parent-wallet (Rabby) token swaps on Robinhood via UniV2.
 * Bound wallet keeps GMGN server-sign — see GMGN_PARENT_FROM_SUPPORTED.
 */

import {
  encodeFunctionData,
  parseEther,
  parseUnits,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import type { GmgnBulkBuyItem, GmgnBulkLegResult } from '@/utils/gmgn-bulk-trade'
import {
  executeRhWalletCalls,
  type RhTxCall,
} from '@/utils/dlmm/rh-send-calls'
import {
  RH_USDG,
  RH_USDG_DECIMALS,
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
/** Buy-from / sell-to quote currency on RH UniV2. */
export type RhSwapQuote = 'ETH' | 'USDG'

function quoteAddress(quote: RhSwapQuote): Address {
  return quote === 'USDG' ? RH_USDG : RH_WETH
}

async function requireQuotePair(
  publicClient: PublicClient,
  token: Address,
  quote: RhSwapQuote,
): Promise<void> {
  const q = quoteAddress(quote)
  const pair = await publicClient.readContract({
    address: RH_V2_FACTORY,
    abi: univ2FactoryAbi,
    functionName: 'getPair',
    args: [q, token],
  })
  if (!pair || normalizeAddress(pair) === ZERO) {
    throw new Error(
      `No UniV2 ${quote} pair for token — cannot parent-swap`,
    )
  }
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
}

function parseQuoteAmount(amountHuman: number, quote: RhSwapQuote): bigint {
  if (!(amountHuman > 0)) throw new Error(`${quote} amount must be > 0`)
  return quote === 'USDG'
    ? parseUnits(String(amountHuman), RH_USDG_DECIMALS)
    : parseEther(String(amountHuman))
}

/** Pure encode: approve (if needed) + sell into ETH or USDG. */
export function buildRhUniv2SellCalls(params: {
  token: Address
  account: Address
  amountIn: bigint
  minOut: bigint
  allowance: bigint
  deadlineTs: bigint
  quote?: RhSwapQuote
}): RhUniv2TxCall[] {
  const {
    token,
    account,
    amountIn,
    minOut,
    allowance,
    deadlineTs,
    quote = 'ETH',
  } = params
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
  if (quote === 'ETH') {
    const path = [token, RH_WETH] as Address[]
    calls.push({
      to: RH_V2_ROUTER,
      data: encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'swapExactTokensForETH',
        args: [amountIn, minOut, path, account, deadlineTs],
      }),
    })
  } else {
    const path = [token, RH_USDG] as Address[]
    calls.push({
      to: RH_V2_ROUTER,
      data: encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [amountIn, minOut, path, account, deadlineTs],
      }),
    })
  }
  return calls
}

/** Pure encode: ETH payable swap or USDG token swap (approve handled separately for batches). */
export function buildRhUniv2BuyCalls(params: {
  token: Address
  account: Address
  amountIn: bigint
  minOut: bigint
  deadlineTs: bigint
  quote?: RhSwapQuote
}): RhUniv2TxCall[] {
  const {
    token,
    account,
    amountIn,
    minOut,
    deadlineTs,
    quote = 'ETH',
  } = params
  if (quote === 'ETH') {
    const path = [RH_WETH, token] as Address[]
    return [
      {
        to: RH_V2_ROUTER,
        data: encodeFunctionData({
          abi: univ2RouterAbi,
          functionName: 'swapExactETHForTokens',
          args: [minOut, path, account, deadlineTs],
        }),
        value: amountIn,
      },
    ]
  }
  const path = [RH_USDG, token] as Address[]
  return [
    {
      to: RH_V2_ROUTER,
      data: encodeFunctionData({
        abi: univ2RouterAbi,
        functionName: 'swapExactTokensForTokens',
        args: [amountIn, minOut, path, account, deadlineTs],
      }),
    },
  ]
}

/** Reads balance / quote / allowance, then builds approve+swap calldata. */
export async function prepareRhUniv2SellLegCalls(params: {
  publicClient: PublicClient
  account: Address
  token: Address
  percent: number
  slippageBps: number
  deadlineTs?: bigint
  quote?: RhSwapQuote
}): Promise<RhUniv2TxCall[]> {
  const { publicClient, account, token, slippageBps, quote = 'ETH' } = params
  const pct = params.percent
  if (!(pct > 0) || pct > 100) throw new Error('Sell % must be 1–100')
  await requireQuotePair(publicClient, token, quote)
  const balance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })
  const amountIn = (balance * BigInt(Math.floor(pct * 100))) / BigInt(10_000)
  if (amountIn <= BigInt(0)) throw new Error('No token balance to sell')
  const path = [token, quoteAddress(quote)] as Address[]
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
    quote,
  })
}

/** Quote + encode one buy leg (no USDG approve — batch adds one for total). */
export async function prepareRhUniv2BuyLegCalls(params: {
  publicClient: PublicClient
  account: Address
  token: Address
  amountHuman: number
  slippageBps: number
  deadlineTs?: bigint
  quote?: RhSwapQuote
}): Promise<{ calls: RhUniv2TxCall[]; amountIn: bigint }> {
  const {
    publicClient,
    account,
    token,
    amountHuman,
    slippageBps,
    quote = 'ETH',
  } = params
  await requireQuotePair(publicClient, token, quote)
  const amountIn = parseQuoteAmount(amountHuman, quote)
  const path =
    quote === 'ETH'
      ? ([RH_WETH, token] as Address[])
      : ([RH_USDG, token] as Address[])
  const amounts = await publicClient.readContract({
    address: RH_V2_ROUTER,
    abi: univ2RouterAbi,
    functionName: 'getAmountsOut',
    args: [amountIn, path],
  })
  const expected = amounts[amounts.length - 1]!
  const minOut = applySlippageMinOut(expected, slippageBps)
  const calls = buildRhUniv2BuyCalls({
    token,
    account,
    amountIn,
    minOut,
    deadlineTs: params.deadlineTs ?? deadline(),
    quote,
  })
  return { calls, amountIn }
}

/** Buy token with ETH (native) or USDG ERC20. */
export async function rhUniv2BuyExact(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  token: Address
  amountHuman: number
  slippageBps: number
  quote?: RhSwapQuote
}): Promise<{ hash: string }> {
  const quote = params.quote ?? 'ETH'
  const { calls, amountIn } = await prepareRhUniv2BuyLegCalls({
    publicClient: params.publicClient,
    account: params.account,
    token: params.token,
    amountHuman: params.amountHuman,
    slippageBps: params.slippageBps,
    quote,
  })
  const allCalls: RhUniv2TxCall[] = []
  if (quote === 'USDG') {
    const allowance = await params.publicClient.readContract({
      address: RH_USDG,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [params.account, RH_V2_ROUTER],
    })
    if (allowance < amountIn) {
      allCalls.push({
        to: RH_USDG,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [RH_V2_ROUTER, amountIn],
        }),
      })
    }
  }
  allCalls.push(...calls)
  const { hash } = await executeRhWalletCalls({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    account: params.account,
    calls: allCalls,
  })
  return { hash }
}

/** @deprecated Use rhUniv2BuyExact({ quote: 'ETH', ... }) */
export async function rhUniv2BuyExactEth(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  token: Address
  amountEthHuman: number
  slippageBps: number
}): Promise<{ hash: string }> {
  return rhUniv2BuyExact({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    account: params.account,
    token: params.token,
    amountHuman: params.amountEthHuman,
    slippageBps: params.slippageBps,
    quote: 'ETH',
  })
}

export async function rhUniv2SellTokenPercent(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  token: Address
  percent: number
  slippageBps: number
  quote?: RhSwapQuote
}): Promise<{ hash: string }> {
  const calls = await prepareRhUniv2SellLegCalls({
    publicClient: params.publicClient,
    account: params.account,
    token: params.token,
    percent: params.percent,
    slippageBps: params.slippageBps,
    quote: params.quote,
  })
  const { hash } = await executeRhWalletCalls({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    account: params.account,
    calls,
  })
  return { hash }
}

/** Parent bulk buy — amountHuman is per-token (caller splits). Batches via sendCalls. */
export async function executeRhParentBulkBuy(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  amountHuman: number
  tokenMints: GmgnBulkBuyItem[]
  slippageBps: number
  quote?: RhSwapQuote
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const quote = params.quote ?? 'ETH'
  if (params.tokenMints.length === 0) {
    return { success: false, results: [] }
  }

  const deadlineTs = deadline()
  const prepared: Array<{
    item: GmgnBulkBuyItem
    calls: RhUniv2TxCall[]
    amountIn: bigint
  }> = []
  const prepFailures: GmgnBulkLegResult[] = []

  for (const item of params.tokenMints) {
    try {
      const { calls, amountIn } = await prepareRhUniv2BuyLegCalls({
        publicClient: params.publicClient,
        account: params.account,
        token: item.tokenAddress as Address,
        amountHuman: params.amountHuman,
        slippageBps: params.slippageBps,
        deadlineTs,
        quote,
      })
      prepared.push({ item, calls, amountIn })
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

  const flatCalls: RhUniv2TxCall[] = []
  if (quote === 'USDG') {
    const totalIn = prepared.reduce((s, p) => s + p.amountIn, BigInt(0))
    const allowance = await params.publicClient.readContract({
      address: RH_USDG,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [params.account, RH_V2_ROUTER],
    })
    if (allowance < totalIn) {
      flatCalls.push({
        to: RH_USDG,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [RH_V2_ROUTER, totalIn],
        }),
      })
    }
  }
  for (const p of prepared) flatCalls.push(...p.calls)

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

/** Parent bulk sell — flatten legs → executeRhWalletCalls (batch or sequential). */
export async function executeRhParentBulkSell(params: {
  publicClient: PublicClient
  walletClient: WalletClient
  account: Address
  legs: Array<{ tokenAddress: string; percent: number; symbol?: string }>
  slippageBps: number
  quote?: RhSwapQuote
}): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const quote = params.quote ?? 'ETH'
  if (params.legs.length === 0) {
    return { success: false, results: [] }
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
        quote,
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
