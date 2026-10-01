/**
 * One Solana quote engine. Every trade surface asks this, and nothing rolls its own fetch, cache or
 * timer.
 *
 * The decision this module exists to make explicit is `purpose`:
 *
 *   estimate — a number somebody is looking at. Cheapest available source, and **none of the scarce
 *              Jupiter trade budget**. Raptor is keyless, ungated and answers a whole batch in well
 *              under a second; it is asked first, and the Jupiter picker is consulted only when Raptor
 *              errors or its own impact fails the gate (the guardrail SWAP_AND_CLOSE_FLOW.md documents
 *              for the sell surface, lifted here so buy, signals and PnL inherit it too).
 *
 *   execute  — a transaction about to be signed. `/order?taker=`, trade lane, **never cached**, built
 *              fresh at click through `prepareSwapTransaction` (which owns the transfer-fee slippage
 *              floor and the venue-refusal abort).
 *
 * Why this matters: a taker-scoped prepare draws from the same 0.5 rps bucket an execution needs, and
 * three surfaces were spending it to render a display number.
 *
 * Solana only. The Robinhood/0x path is a different venue with a different shape and deliberately does
 * not route through here.
 */
import {
  getSwapQuoteMaxImpactPct,
  impactToAbsPct,
  passesImpactGate,
  type SwapQuoteProvider,
} from '@/utils/swap-quote-pick'
import { pickParallelSwapQuote } from '@/utils/swap-quote-parallel'
import {
  fetchRaptorQuote,
  fetchRaptorQuoteDirect,
  type RaptorQuoteResponse,
} from '@/utils/solanatracker-raptor'
import { prepareSwapTransaction, type PreparedSwap } from '@/utils/swap-executor'
import { resolveRaptorHops } from '@/utils/raptor-hops'
import { prefetchSlippageBps } from '@/utils/auto-slippage'
import type { Connection } from '@solana/web3.js'

export type QuotePurpose = 'estimate' | 'execute'

/** The three Solana sources a quote can come from, in display terms. */
export type SolanaQuoteProvider = 'solanatracker' | 'jupiter' | 'jupiter_lite'

/** One shape for every quote, estimate or execute. */
export type SolanaQuote = {
  provider: SolanaQuoteProvider
  inputMint: string
  outputMint: string
  amount: string
  outAmount: string
  /** Absolute percent, same convention as the rest of the swap path. */
  priceImpact: number
  timestamp: number
  route?: unknown
  fee?: number
  /** `execute` only — the unsigned transaction and the id `/execute` requires. */
  swapTransaction?: string
  requestId?: string
  lastValidBlockHeight?: number
}

export type SolanaQuoteRequest = {
  inputMint: string
  outputMint: string
  amount: string | number
  /** A concrete figure, or the Auto sentinel (-1) which this module resolves itself. */
  slippageBps: number
  purpose: QuotePurpose
  /** Required for `execute`; ignored for `estimate`. */
  userPublicKey?: string
  priorityFeeLamports?: number
  feeAccount?: string
  feeBps?: number
  connection?: Connection
  /** Override the client/server split (tests, and callers that already know). */
  direct?: boolean
}

export class QuoteEngineError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message)
    this.name = 'QuoteEngineError'
  }
}

export const QUOTE_ESTIMATE_TTL_MS_DEFAULT = 10_000

/** React-query key root every quote consumer shares, so dedupe works across surfaces. */
export const QUOTE_ENGINE_KEY_ROOT = 'sol-quote' as const

/**
 * The one slow-refresh figure for a stable selection, inside the venue's ~30 s quote validity so the
 * displayed estimate never blanks between refreshes. A quote is not a live ticker — surfaces that
 * genuinely want this ask for it, everyone else refreshes on change.
 */
export const QUOTE_ESTIMATE_REFRESH_MS_DEFAULT = 25_000

export function resolveEstimateTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.QUOTE_ESTIMATE_TTL_MS)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : QUOTE_ESTIMATE_TTL_MS_DEFAULT
}

/**
 * Every input that can change the answer. `purpose` is part of the key so an estimate can never be
 * mistaken for an execution transaction, and the taker/fee fields are blanked for estimates so two
 * display surfaces asking the same question share one entry.
 */
export function quoteKey(req: SolanaQuoteRequest): string {
  const slippageBps = prefetchSlippageBps(req.slippageBps)
  const execute = req.purpose === 'execute'
  return [
    req.purpose,
    req.inputMint,
    req.outputMint,
    String(req.amount),
    slippageBps,
    execute ? req.userPublicKey ?? '' : '',
    execute ? req.priorityFeeLamports ?? '' : '',
    execute ? req.feeAccount ?? '' : '',
    execute ? req.feeBps ?? '' : '',
  ].join('|')
}

function toSolanaProvider(provider: SwapQuoteProvider): SolanaQuoteProvider {
  if (provider === 'raptor') return 'solanatracker'
  if (provider === 'jupiter_lite') return 'jupiter_lite'
  return 'jupiter'
}

function isDirect(req: SolanaQuoteRequest): boolean {
  return req.direct ?? typeof window === 'undefined'
}

/** Raptor is a display source here; a failure is never fatal, it just escalates. */
async function settle<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    console.warn('[quote] estimate source failed:', error instanceof Error ? error.message : error)
    return null
  }
}

function quoteFromRaptor(raw: RaptorQuoteResponse, req: SolanaQuoteRequest): SolanaQuote {
  return {
    provider: 'solanatracker',
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: String(req.amount),
    outAmount: String(raw.amountOut),
    priceImpact: impactToAbsPct(raw.priceImpact),
    timestamp: Date.now(),
    route: raw.routePlan,
    fee: raw.feeAmount != null ? Number(raw.feeAmount) : undefined,
  }
}

/**
 * Ask the venue that executes first, keep its answer only while it passes the impact gate, otherwise
 * escalate to the Jupiter picker. An ungated Raptor answer is not an estimate worth showing: at
 * `RAPTOR_MAX_HOPS=1` a two-pool token quotes a single-hop route far above the gate.
 */
async function loadEstimate(req: SolanaQuoteRequest, slippageBps: number): Promise<SolanaQuote> {
  const direct = isDirect(req)
  const maxImpactPct = getSwapQuoteMaxImpactPct()

  // Hop policy is per-pair: a token↔token leg has no direct pool, so asking Raptor at 1 hop fails with
  // "No direct route found" — and that failure used to escalate straight to the Jupiter picker, spending
  // the 0.5 rps execution budget on a question Raptor could answer. A route touching SOL/USDC/USDT keeps
  // the single hop it was tuned for. Asking correctly the first time is the whole fix; a retry would only
  // climb from the floor the resolver already applied.
  const hops = resolveRaptorHops(req.inputMint, req.outputMint)
  const raptor = await settle(() =>
    direct
      ? fetchRaptorQuoteDirect(req.inputMint, req.outputMint, String(req.amount), slippageBps, hops)
      : fetchRaptorQuote(req.inputMint, req.outputMint, String(req.amount), slippageBps, hops),
  )

  if (raptor?.amountOut) {
    const quote = quoteFromRaptor(raptor, req)
    if (passesImpactGate(quote.priceImpact, maxImpactPct)) return quote
    console.warn(
      `[quote] raptor estimate gated: impact ${quote.priceImpact.toFixed(2)}% > ${maxImpactPct}% — escalating`,
    )
  }

  const picked = await pickParallelSwapQuote({
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: String(req.amount),
    slippageBps,
    direct,
  })
  if (!picked) {
    throw new QuoteEngineError('No route for this pair right now', 502)
  }
  return {
    provider: toSolanaProvider(picked.provider),
    inputMint: picked.quote.inputMint,
    outputMint: picked.quote.outputMint,
    amount: String(req.amount),
    outAmount: picked.outAmount,
    priceImpact: picked.impactPct,
    timestamp: Date.now(),
    route: picked.quote.routePlan,
  }
}

/**
 * Build the swap the user is about to sign. Delegates to `prepareSwapTransaction`, which owns the
 * desk/arb dispatch, the Token-2022 transfer-fee slippage floor and the venue-refusal abort — this
 * module must not re-implement any of that.
 */
async function loadExecute(req: SolanaQuoteRequest, slippageBps: number): Promise<SolanaQuote> {
  if (!req.userPublicKey) {
    throw new QuoteEngineError('userPublicKey is required for an execute quote', 400)
  }
  const prepared: PreparedSwap = await prepareSwapTransaction({
    userPublicKey: req.userPublicKey,
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: String(req.amount),
    slippageBps,
    priorityFeeLamports: req.priorityFeeLamports ?? 0,
    feeAccount: req.feeAccount,
    feeBps: req.feeBps,
    connection: req.connection,
    direct: req.direct,
  })

  return {
    provider: toSolanaProvider(prepared.provider),
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: String(req.amount),
    outAmount: prepared.outAmount ?? '',
    priceImpact: impactToAbsPct(prepared.priceImpact),
    timestamp: Date.now(),
    swapTransaction: prepared.swapTransaction,
    requestId: prepared.requestId,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  }
}

const estimateCache = new Map<string, { at: number; quote: SolanaQuote }>()
const inFlight = new Map<string, Promise<SolanaQuote>>()
const listeners = new Map<string, Set<(quote: SolanaQuote) => void>>()

export function resetQuoteCacheForTests(): void {
  estimateCache.clear()
  inFlight.clear()
  listeners.clear()
}

/** A still-fresh estimate, or null. Never returns an execute — those are not cached at all. */
export function peekQuote(key: string): SolanaQuote | null {
  const hit = estimateCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > resolveEstimateTtlMs()) {
    estimateCache.delete(key)
    return null
  }
  return hit.quote
}

/** Fan-out: N surfaces watching the same key are served by one upstream request. */
export function subscribeQuote(key: string, cb: (quote: SolanaQuote) => void): () => void {
  const set = listeners.get(key) ?? new Set()
  set.add(cb)
  listeners.set(key, set)
  return () => {
    set.delete(cb)
    if (set.size === 0) listeners.delete(key)
  }
}

function emit(key: string, quote: SolanaQuote): void {
  for (const cb of listeners.get(key) ?? []) cb(quote)
}

/**
 * The one entry point. Coalesces identical in-flight work; caches estimates for their TTL; **never**
 * caches an execution.
 */
export async function requestQuote(req: SolanaQuoteRequest): Promise<SolanaQuote> {
  const slippageBps = prefetchSlippageBps(req.slippageBps)
  const normalized: SolanaQuoteRequest = { ...req, slippageBps }
  const key = quoteKey(normalized)

  if (normalized.purpose === 'estimate') {
    const hit = peekQuote(key)
    if (hit) return hit
  }

  const pending = inFlight.get(key)
  if (pending) return pending

  const load =
    normalized.purpose === 'execute'
      ? loadExecute(normalized, slippageBps)
      : loadEstimate(normalized, slippageBps)

  const promise = load
    .then((quote) => {
      if (normalized.purpose === 'estimate') {
        estimateCache.set(key, { at: Date.now(), quote })
        emit(key, quote)
      }
      return quote
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}
