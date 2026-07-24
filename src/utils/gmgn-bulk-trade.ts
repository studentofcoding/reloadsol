import type { GmgnTradeChain } from './gmgn-currencies'
import {
  GMGN_CHAIN_CURRENCIES,
  gmgnNativeToken,
  gmgnTokenDecimals,
  slippageBpsToGmgnPercent,
  toGmgnRawAmount,
} from './gmgn-currencies'

export type GmgnBulkBuyItem = {
  tokenAddress: string
  symbol?: string
}

export type GmgnBulkLegResult = {
  tokenAddress: string
  symbol?: string
  success: boolean
  orderId?: string
  hash?: string
  status?: string
  error?: string
  estOut?: string
}

export type GmgnBulkBuyParams = {
  chain: GmgnTradeChain
  from: string
  /** Human units of native (SOL/ETH) or USDC when inputToken is USDC. */
  amountHuman: number
  inputToken?: string
  tokenMints: GmgnBulkBuyItem[]
  slippageBps: number
  /** Injected for tests / browser — defaults to fetch against same origin. */
  quoteFn?: (body: Record<string, unknown>) => Promise<{
    output_amount?: string
    min_output_amount?: string
  }>
  swapFn?: (body: Record<string, unknown>) => Promise<{
    order_id?: string
    hash?: string
    status?: string
  }>
  orderFn?: (
    chain: string,
    orderId: string,
  ) => Promise<{ status?: string; hash?: string }>
}

const TERMINAL = new Set(['confirmed', 'successful', 'success', 'failed', 'expired'])

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function defaultQuote(body: Record<string, unknown>) {
  const res = await fetch('/api/gmgn/trade/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as {
    success?: boolean
    error?: string
    quote?: { output_amount?: string; min_output_amount?: string }
  }
  if (!res.ok || !data.success) throw new Error(data.error || 'quote failed')
  return data.quote ?? {}
}

async function defaultSwap(body: Record<string, unknown>) {
  const res = await fetch('/api/gmgn/trade/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, confirmed: true }),
  })
  const data = (await res.json()) as {
    success?: boolean
    error?: string
    result?: { order_id?: string; hash?: string; status?: string }
  }
  if (!res.ok || !data.success) throw new Error(data.error || 'swap failed')
  return data.result ?? {}
}

async function defaultOrder(chain: string, orderId: string) {
  const res = await fetch(
    `/api/gmgn/trade/order?chain=${encodeURIComponent(chain)}&orderId=${encodeURIComponent(orderId)}`,
  )
  const data = (await res.json()) as {
    success?: boolean
    error?: string
    order?: { status?: string; hash?: string }
  }
  if (!res.ok || !data.success) throw new Error(data.error || 'order poll failed')
  return data.order ?? {}
}

async function pollOrder(
  chain: string,
  orderId: string,
  orderFn: NonNullable<GmgnBulkBuyParams['orderFn']>,
): Promise<{ status?: string; hash?: string }> {
  let last: { status?: string; hash?: string } = {}
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(5_000)
    last = await orderFn(chain, orderId)
    const st = String(last.status ?? '').toLowerCase()
    if (TERMINAL.has(st)) return last
  }
  return last
}

/** Sequential quote→swap→poll per token. No auto-retry of failed swaps. */
export async function executeGmgnBulkBuy(
  params: GmgnBulkBuyParams,
): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const inputToken = params.inputToken ?? gmgnNativeToken(params.chain)
  const decimals = gmgnTokenDecimals(params.chain, inputToken)
  const amountRaw = toGmgnRawAmount(params.amountHuman, decimals)
  const slippage = slippageBpsToGmgnPercent(params.slippageBps)
  const quoteFn = params.quoteFn ?? defaultQuote
  const swapFn = params.swapFn ?? defaultSwap
  const orderFn = params.orderFn ?? defaultOrder

  const results: GmgnBulkLegResult[] = []
  for (const item of params.tokenMints) {
    const tokenAddress = item.tokenAddress
    try {
      const quote = await quoteFn({
        chain: params.chain,
        from: params.from,
        inputToken,
        outputToken: tokenAddress,
        amount: amountRaw,
        slippage,
      })
      const swap = await swapFn({
        chain: params.chain,
        from: params.from,
        inputToken,
        outputToken: tokenAddress,
        amount: amountRaw,
        slippage,
      })
      let status = swap.status
      let hash = swap.hash
      if (swap.order_id && !TERMINAL.has(String(status ?? '').toLowerCase())) {
        const polled = await pollOrder(params.chain, swap.order_id, orderFn)
        status = polled.status ?? status
        hash = polled.hash ?? hash
      }
      const st = String(status ?? '').toLowerCase()
      const ok = !st || TERMINAL.has(st)
        ? st === '' || st === 'confirmed' || st === 'successful' || st === 'success'
        : false
      results.push({
        tokenAddress,
        symbol: item.symbol,
        success: ok,
        orderId: swap.order_id,
        hash,
        status,
        estOut: quote.output_amount,
        error: ok ? undefined : `order status: ${status ?? 'unknown'}`,
      })
    } catch (error) {
      results.push({
        tokenAddress,
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

export type GmgnBulkSellParams = {
  chain: GmgnTradeChain
  from: string
  outputToken?: string
  /** percent 1–100 per token */
  legs: Array<{ tokenAddress: string; percent: number; symbol?: string }>
  slippageBps: number
  quoteFn?: GmgnBulkBuyParams['quoteFn']
  swapFn?: GmgnBulkBuyParams['swapFn']
  orderFn?: GmgnBulkBuyParams['orderFn']
}

/** Sell % of each token → native. Uses percent (no raw amount). */
export async function executeGmgnBulkSell(
  params: GmgnBulkSellParams,
): Promise<{ success: boolean; results: GmgnBulkLegResult[] }> {
  const outputToken = params.outputToken ?? gmgnNativeToken(params.chain)
  const slippage = slippageBpsToGmgnPercent(params.slippageBps)
  const swapFn = params.swapFn ?? defaultSwap
  const orderFn = params.orderFn ?? defaultOrder

  const results: GmgnBulkLegResult[] = []
  for (const leg of params.legs) {
    try {
      const swap = await swapFn({
        chain: params.chain,
        from: params.from,
        inputToken: leg.tokenAddress,
        outputToken,
        amount: '0',
        percent: leg.percent,
        slippage,
      })
      let status = swap.status
      let hash = swap.hash
      if (swap.order_id && !TERMINAL.has(String(status ?? '').toLowerCase())) {
        const polled = await pollOrder(params.chain, swap.order_id, orderFn)
        status = polled.status ?? status
        hash = polled.hash ?? hash
      }
      const st = String(status ?? '').toLowerCase()
      const ok =
        st === '' ||
        st === 'confirmed' ||
        st === 'successful' ||
        st === 'success'
      results.push({
        tokenAddress: leg.tokenAddress,
        symbol: leg.symbol,
        success: ok,
        orderId: swap.order_id,
        hash,
        status,
        error: ok ? undefined : `order status: ${status ?? 'unknown'}`,
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

/** Build quote request shape used by buy legs (for self-check / confirm UI). */
export function buildGmgnBuyQuoteRequest(params: {
  chain: GmgnTradeChain
  from: string
  tokenAddress: string
  amountHuman: number
  slippageBps: number
  inputToken?: string
}): {
  chain: GmgnTradeChain
  from: string
  inputToken: string
  outputToken: string
  amount: string
  slippage: number
} {
  const meta = GMGN_CHAIN_CURRENCIES[params.chain]
  const inputToken = params.inputToken ?? meta.native
  const decimals = gmgnTokenDecimals(params.chain, inputToken)
  return {
    chain: params.chain,
    from: params.from,
    inputToken,
    outputToken: params.tokenAddress,
    amount: toGmgnRawAmount(params.amountHuman, decimals),
    slippage: slippageBpsToGmgnPercent(params.slippageBps),
  }
}
