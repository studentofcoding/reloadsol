import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/solanatracker-raptor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/solanatracker-raptor')>()
  return { ...actual, fetchRaptorQuote: vi.fn(), fetchRaptorQuoteDirect: vi.fn() }
})
vi.mock('@/utils/swap-quote-parallel', () => ({ pickParallelSwapQuote: vi.fn() }))
vi.mock('@/utils/swap-executor', () => ({ prepareSwapTransaction: vi.fn() }))
vi.mock('@/utils/jupiter-rps', () => ({ throttleJupiterRps: vi.fn(async () => {}) }))
// The mint-account read is a real RPC call; stub it so estimates stay offline and fast.
vi.mock('@/utils/token-transfer-fee', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/token-transfer-fee')>()
  return { ...actual, getMintDecimals: vi.fn(async () => 6) }
})

import { fetchRaptorQuoteDirect } from '@/utils/solanatracker-raptor'
import { pickParallelSwapQuote } from '@/utils/swap-quote-parallel'
import { prepareSwapTransaction } from '@/utils/swap-executor'
import { throttleJupiterRps } from '@/utils/jupiter-rps'
import {
  QUOTE_ESTIMATE_TTL_MS_DEFAULT,
  QuoteEngineError,
  peekQuote,
  quoteKey,
  requestQuote,
  resetQuoteCacheForTests,
  resolveEstimateTtlMs,
  type SolanaQuoteRequest,
} from '@/utils/quote-engine'

const SOL = 'So11111111111111111111111111111111111111112'
const DEW = 'DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP'
const TAKER = '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'

const estimate: SolanaQuoteRequest = {
  inputMint: DEW,
  outputMint: SOL,
  amount: '15000000',
  slippageBps: 100,
  purpose: 'estimate',
}
const execute: SolanaQuoteRequest = { ...estimate, purpose: 'execute', userPublicKey: TAKER }

const raptorQuote = (amountOut: string, priceImpact = 0.001) => ({
  inputMint: DEW,
  outputMint: SOL,
  amountIn: '15000000',
  amountOut,
  minAmountOut: amountOut,
  priceImpact,
  slippageBps: 100,
})

beforeEach(() => {
  resetQuoteCacheForTests()
  vi.clearAllMocks()
  delete process.env.QUOTE_ESTIMATE_TTL_MS
  process.env.RPC_URL = 'https://rpc.invalid'
})

describe('quoteKey', () => {
  it('separates estimate from execute, and includes every input that changes the answer', () => {
    expect(quoteKey(estimate)).not.toBe(quoteKey(execute))
    expect(quoteKey(estimate)).not.toBe(quoteKey({ ...estimate, amount: '1' }))
    expect(quoteKey(estimate)).not.toBe(quoteKey({ ...estimate, slippageBps: 200 }))
    expect(quoteKey(estimate)).not.toBe(quoteKey({ ...estimate, outputMint: SOL + 'x' }))
  })

  it('ignores execute-only fields for an estimate, so display surfaces share one entry', () => {
    expect(quoteKey(estimate)).toBe(quoteKey({ ...estimate, userPublicKey: TAKER }))
  })

  it('distinguishes executions by taker and fee', () => {
    expect(quoteKey(execute)).not.toBe(quoteKey({ ...execute, userPublicKey: 'other' }))
    expect(quoteKey(execute)).not.toBe(quoteKey({ ...execute, feeBps: 25 }))
  })

  it('resolves the Auto sentinel before keying', () => {
    expect(quoteKey({ ...estimate, slippageBps: -1 })).toBe(
      quoteKey({ ...estimate, slippageBps: 20 }),
    )
  })
})

describe('resolveEstimateTtlMs', () => {
  it('defaults and reads env', () => {
    expect(resolveEstimateTtlMs({})).toBe(QUOTE_ESTIMATE_TTL_MS_DEFAULT)
    expect(resolveEstimateTtlMs({ QUOTE_ESTIMATE_TTL_MS: '2500' })).toBe(2500)
    expect(resolveEstimateTtlMs({ QUOTE_ESTIMATE_TTL_MS: 'junk' })).toBe(
      QUOTE_ESTIMATE_TTL_MS_DEFAULT,
    )
  })
})

describe('estimate', () => {
  it('asks Raptor first and never draws the Jupiter gate', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(raptorQuote('5000000'))

    const quote = await requestQuote(estimate)

    expect(quote.provider).toBe('solanatracker')
    expect(quote.outAmount).toBe('5000000')
    // display-ready: the raw amount arrives with the scale a surface needs to render it
    expect(quote.outDecimals).toBe(6)
    expect(pickParallelSwapQuote).not.toHaveBeenCalled()
    // The whole point of `purpose`: a display number must not spend the execution budget.
    expect(throttleJupiterRps).not.toHaveBeenCalled()
  })

  it('escalates to the Jupiter picker when Raptor fails', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockRejectedValue(new Error('raptor down'))
    vi.mocked(pickParallelSwapQuote).mockResolvedValue({
      provider: 'jupiter_swap',
      outAmount: '4900000',
      impactPct: 0.2,
      quote: { inputMint: DEW, outputMint: SOL, inAmount: '15000000', outAmount: '4900000', otherAmountThreshold: '1', swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0.2', routePlan: [] },
    } as never)

    const quote = await requestQuote(estimate)
    expect(quote.provider).toBe('jupiter')
    expect(quote.outAmount).toBe('4900000')
    expect(pickParallelSwapQuote).toHaveBeenCalledTimes(1)
  })

  it('escalates when Raptor answers but its impact fails the gate', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(raptorQuote('900', 50))
    vi.mocked(pickParallelSwapQuote).mockResolvedValue({
      provider: 'jupiter_lite',
      outAmount: '800',
      impactPct: 2,
      quote: { inputMint: DEW, outputMint: SOL, inAmount: '15000000', outAmount: '800', otherAmountThreshold: '1', swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '2', routePlan: [] },
    } as never)

    const quote = await requestQuote(estimate)
    expect(quote.provider).toBe('jupiter_lite')
    expect(pickParallelSwapQuote).toHaveBeenCalled()
  })

  it('serves a repeat from cache without a second upstream call', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(raptorQuote('5000000'))
    await requestQuote(estimate)
    const calls = vi.mocked(fetchRaptorQuoteDirect).mock.calls.length

    const again = await requestQuote(estimate)
    expect(again.outAmount).toBe('5000000')
    expect(vi.mocked(fetchRaptorQuoteDirect).mock.calls.length).toBe(calls)
    expect(peekQuote(quoteKey(estimate))?.outAmount).toBe('5000000')
  })

  it('coalesces identical in-flight requests into one upstream call', async () => {
    let release: (v: unknown) => void = () => {}
    vi.mocked(fetchRaptorQuoteDirect).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }) as never,
    )

    const a = requestQuote(estimate)
    const b = requestQuote(estimate)
    release(raptorQuote('5000000'))
    const [qa, qb] = await Promise.all([a, b])

    expect(vi.mocked(fetchRaptorQuoteDirect)).toHaveBeenCalledTimes(1)
    expect(qa.outAmount).toBe(qb.outAmount)
  })

  it('throws a typed error when nothing can route', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(raptorQuote('1', 90))
    vi.mocked(pickParallelSwapQuote).mockResolvedValue(null)

    await expect(requestQuote(estimate)).rejects.toBeInstanceOf(QuoteEngineError)
  })
})

describe('execute', () => {
  it('is never served from cache, even immediately after an identical one', async () => {
    vi.mocked(prepareSwapTransaction).mockResolvedValue({
      provider: 'jupiter_swap',
      swapTransaction: 'AQAB',
      outAmount: '5000000',
      requestId: 'req-1',
    } as never)

    await requestQuote(execute)
    await requestQuote(execute)

    expect(vi.mocked(prepareSwapTransaction)).toHaveBeenCalledTimes(2)
    expect(peekQuote(quoteKey(execute))).toBeNull()
  })

  it('carries the transaction and requestId the executor needs', async () => {
    vi.mocked(prepareSwapTransaction).mockResolvedValue({
      provider: 'jupiter_swap',
      swapTransaction: 'AQAB',
      outAmount: '5000000',
      requestId: 'req-1',
      lastValidBlockHeight: 123,
    } as never)

    const quote = await requestQuote(execute)
    expect(quote.swapTransaction).toBe('AQAB')
    expect(quote.requestId).toBe('req-1')
    expect(quote.lastValidBlockHeight).toBe(123)
  })

  it('requires a taker', async () => {
    await expect(requestQuote({ ...execute, userPublicKey: undefined })).rejects.toBeInstanceOf(
      QuoteEngineError,
    )
    expect(prepareSwapTransaction).not.toHaveBeenCalled()
  })
})

/**
 * Prod 2026-10-01: at maxHops=1 a token→token Raptor quote returns
 * `500 "No direct route found and maxHops=1"`. That failure used to escalate straight to the Jupiter
 * picker and spend the 0.5 rps execution budget. The engine must therefore ask Raptor correctly the
 * **first** time — 3 hops for token→token, 1 for a leg touching SOL/USDC/USDT.
 */
describe('Raptor hop policy at the call site', () => {
  const BPX = 'BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy'
  const before = process.env.RAPTOR_MAX_HOPS

  beforeEach(() => {
    process.env.RAPTOR_MAX_HOPS = '1'
  })
  afterAll(() => {
    if (before === undefined) delete process.env.RAPTOR_MAX_HOPS
    else process.env.RAPTOR_MAX_HOPS = before
  })

  it('asks a token→token pair at the wider ceiling on the first call', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(raptorQuote('4100000'))

    const quote = await requestQuote({ ...estimate, inputMint: DEW, outputMint: BPX })

    expect(quote.outAmount).toBe('4100000')
    // exactly one call, at 3 hops — no wasted first attempt at 1
    expect(vi.mocked(fetchRaptorQuoteDirect).mock.calls.map((c) => c[4])).toEqual([3])
  })

  it('asks a verified-mint route at 1 hop', async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(raptorQuote('5000000'))

    await requestQuote(estimate) // DEW→SOL

    expect(vi.mocked(fetchRaptorQuoteDirect).mock.calls.map((c) => c[4])).toEqual([1])
  })
})
