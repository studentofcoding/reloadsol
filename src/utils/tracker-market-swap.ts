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
  passesImpactGate,
} from '@/utils/swap-quote-pick'
import {
  executeClientSwap,
  peekFreshPreparedSwap,
  prepareSwapTransaction,
  putPreparedSwapCache,
  type ExecuteClientSwapParams,
  type PrepareSwapParams,
  type PreparedSwap,
} from '@/utils/swap-executor'
import {
  AUTO_PRIORITY_FEE_MAX_LAMPORTS,
  autoPriorityFeeLamports,
  resolveTrackerPriorityFee,
} from '@/utils/priority-fee'
import { resolveSolSignerMode } from '@/utils/sol-desk-signer'
import { beginTradeInFlight } from '@/utils/trade-inflight'

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
  prepare: typeof prepareSwapTransaction
  peek: typeof peekFreshPreparedSwap
  put: typeof putPreparedSwapCache
  execute: typeof executeClientSwap
}

const defaultDeps: TrackerMarketSwapDeps = {
  prepare: prepareSwapTransaction,
  peek: peekFreshPreparedSwap,
  put: putPreparedSwapCache,
  execute: executeClientSwap,
}

function trackerPrepareBase(
  params: TrackerMarketSwapParams,
): Omit<PrepareSwapParams, 'slippageBps'> & TrackerMarketSwapParams {
  return {
    ...params,
    amount: Number(params.amount),
    priorityFeeLamports: resolveTrackerPriorityFee(params.priorityFeeLamports),
  }
}

async function buildTrackerSwap(
  params: TrackerMarketSwapParams,
  deps: TrackerMarketSwapDeps,
): Promise<{
  execParams: TrackerMarketSwapParams & { slippageBps: number }
  impactPct: number
  slippageBps: number
  volatile: boolean
}> {
  const base = trackerPrepareBase(params)
  const seedBps = prefetchSlippageBps(AUTO_SLIPPAGE_BPS)
  const seedParams = { ...base, slippageBps: seedBps }
  let seeded = deps.peek(seedParams)
  if (!seeded) {
    seeded = await deps.prepare(seedParams)
    deps.put(seedParams, seeded)
  }
  const impactPct = impactToAbsPct(seeded.priceImpact)
  if (!passesImpactGate(impactPct)) {
    throw new Error(
      `No swap route within ${getSwapQuoteMaxImpactPct()}% price impact`,
    )
  }
  const slippageBps = resolveTradeSlippageBps(AUTO_SLIPPAGE_BPS, impactPct)
  const execParams = { ...base, slippageBps }
  if (slippageBps !== seedBps && !deps.peek(execParams)) {
    const built = await deps.prepare(execParams)
    const cached: PreparedSwap = {
      ...built,
      priceImpact: built.priceImpact ?? seeded.priceImpact,
    }
    deps.put(execParams, cached)
  }
  return {
    execParams,
    impactPct,
    slippageBps,
    volatile: quoteIsVolatile([impactPct]),
  }
}

/** Fill the prepare cache before the click so confirm does not quote twice. */
export async function warmTrackerMarketSwap(
  params: TrackerMarketSwapParams,
  deps: TrackerMarketSwapDeps = defaultDeps,
): Promise<void> {
  await buildTrackerSwap(params, deps)
}

/**
 * Manual tracker buy and sell share this path:
 * Jupiter V2 quote (Lite only if V2 fails) → impact gate →
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

  const flight = beginTradeInFlight()
  try {
    const signerModePromise = resolveSolSignerMode(params.userPublicKey)
    const built = await buildTrackerSwap({ ...params, amount }, deps)
    const signerMode = await signerModePromise
    const confirmLine =
      signerMode === 'server' ? 'Signing on server.' : 'Confirm in your wallet.'
    onStatus?.(
      built.volatile
        ? `High price impact (${built.impactPct.toFixed(2)}%). Auto slippage capped at ${AUTO_SLIPPAGE_CAP_BPS / 100}%. ${confirmLine}`
        : `Impact ${built.impactPct.toFixed(2)}% · auto slippage ${(built.slippageBps / 100).toFixed(2)}%. ${confirmLine}`,
    )

    const sent = await deps.execute(built.execParams)

    flight.succeed()
    return {
      signature: sent.signature,
      slippageBps: built.slippageBps,
      impactPct: built.impactPct,
      volatile: built.volatile,
      outAmount: sent.outAmount,
    }
  } catch (error) {
    flight.fail(error instanceof Error ? error.message : 'Trade failed')
    throw error
  }
}
