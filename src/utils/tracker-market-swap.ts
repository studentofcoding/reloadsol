import {
  AUTO_SLIPPAGE_BPS,
  AUTO_SLIPPAGE_CAP_BPS,
  prefetchSlippageBps,
  quoteIsVolatile,
  resolveTradeSlippageBps,
} from '@/utils/auto-slippage'
import {
  getSwapQuoteMaxImpactPct,
  impactToAbsPct,
} from '@/utils/swap-quote-pick'
import {
  executeClientSwap,
  fetchSwapQuote,
  type ExecuteClientSwapParams,
} from '@/utils/swap-executor'
import {
  AUTO_PRIORITY_FEE_MAX_LAMPORTS,
  autoPriorityFeeLamports,
  resolveTrackerPriorityFee,
} from '@/utils/priority-fee'

/** Signals + tracker default: Jupiter/Raptor high, capped at 0.003 SOL. */
export const TRACKER_AUTO_PRIORITY_FEE = autoPriorityFeeLamports({
  level: 'high',
  maxLamports: AUTO_PRIORITY_FEE_MAX_LAMPORTS,
})

/**
 * Balance-check reserve for a tracker swap (0.003 SOL).
 * This is the auto cap, not a static tip.
 */
export const TRACKER_PRIORITY_FEE_LAMPORTS = AUTO_PRIORITY_FEE_MAX_LAMPORTS

export type TrackerMarketSwapParams = Omit<
  ExecuteClientSwapParams,
  'slippageBps'
>

export type TrackerMarketSwapResult = {
  signature: string
  slippageBps: number
  impactPct: number
  volatile: boolean
  outAmount?: string
}

type TrackerMarketSwapDeps = {
  fetchQuote: typeof fetchSwapQuote
  execute: typeof executeClientSwap
}

const defaultDeps: TrackerMarketSwapDeps = {
  fetchQuote: fetchSwapQuote,
  execute: executeClientSwap,
}

/**
 * Manual tracker buy and sell share this path:
 * parallel quote (Raptor + Jupiter Lite + Jupiter Swap) → impact gate →
 * auto-cap slippage → prepare/sign/send.
 *
 * Early Enter Noul and soft-active are not consulted. Signals rows and
 * mcap-tracker rows both call this (signals via `rowMarketSwap`). Callers
 * pass the already-chosen input and output mints (SOL, USDC, or USDT → token,
 * or the reverse on sell).
 */
export async function runTrackerMarketSwap(
  params: TrackerMarketSwapParams,
  onStatus?: (message: string) => void,
  deps: TrackerMarketSwapDeps = defaultDeps,
): Promise<TrackerMarketSwapResult> {
  const amount = Number(params.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Trade amount must be positive')
  }
  if (params.inputMint === params.outputMint) {
    throw new Error('Input and output are the same asset')
  }

  const quote = await deps.fetchQuote(
    params.inputMint,
    params.outputMint,
    amount,
    prefetchSlippageBps(AUTO_SLIPPAGE_BPS),
    params.direct,
  )
  if (!quote) {
    throw new Error(
      `No swap route within ${getSwapQuoteMaxImpactPct()}% price impact`,
    )
  }

  const impactPct = impactToAbsPct(quote.priceImpactPct)
  const slippageBps = resolveTradeSlippageBps(AUTO_SLIPPAGE_BPS, impactPct)
  const volatile = quoteIsVolatile([impactPct])
  onStatus?.(
    volatile
      ? `High price impact (${impactPct.toFixed(2)}%). Auto slippage capped at ${AUTO_SLIPPAGE_CAP_BPS / 100}%. Confirm in your wallet.`
      : `Impact ${impactPct.toFixed(2)}% · auto slippage ${(slippageBps / 100).toFixed(2)}%. Confirm in your wallet.`,
  )

  const sent = await deps.execute({
    ...params,
    amount,
    slippageBps,
    priorityFeeLamports: resolveTrackerPriorityFee(params.priorityFeeLamports),
  })

  return {
    signature: sent.signature,
    slippageBps,
    impactPct,
    volatile,
    outAmount: sent.outAmount,
  }
}
