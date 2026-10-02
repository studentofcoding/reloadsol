import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchJupiterSwapQuote, fetchJupiterSwapQuoteDirect } from '@/utils/jupiter-swap-quote'
import { resetJupiterQuoteCachesForTests } from '@/utils/jupiter-swap-quote'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TAKER = '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'

const PARAMS = {
  inputMint: SOL,
  outputMint: USDC,
  amount: '1000000',
  slippageBps: 100,
  taker: TAKER,
}

function stubOrder(payload: Record<string, unknown>, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response)
}

/**
 * A **browser** reaches `/order` through the proxied fetcher (`direct` is false in a tab), so the refusal
 * has to be recognised there too. It was not — a proxied refusal read as a generic failure, the caller fell
 * back to Lite, and Lite built a transaction the wallet could not pay for. Same defect as the direct path,
 * on the path the UI actually uses.
 */
describe('fetchJupiterSwapQuote — the proxied path the UI uses', () => {
  beforeEach(() => {
    resetJupiterQuoteCachesForTests()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('flags a venue refusal carried through the proxy', async () => {
    vi.stubGlobal('fetch', stubOrder({ errorMessage: 'Insufficient funds' }))

    await expect(
      fetchJupiterSwapQuote({
        inputMint: SOL,
        outputMint: USDC,
        amount: '1000000',
        slippageBps: 100,
      }),
    ).rejects.toSatisfy((e: { venueRefused?: boolean }) => e.venueRefused === true)
  })

  it('does not flag a plain payload that merely fails to map', async () => {
    vi.stubGlobal('fetch', stubOrder({ somethingElse: true }))

    await expect(
      fetchJupiterSwapQuote({
        inputMint: SOL,
        outputMint: USDC,
        amount: '1000000',
        slippageBps: 100,
      }),
    ).rejects.toSatisfy((e: { venueRefused?: boolean }) => !e.venueRefused)
  })
})

/**
 * `/order` reports a wallet that cannot pay as HTTP 200 with an empty `transaction` and an
 * `errorMessage`. That is the venue deciding, not a transport fault — and it is the only simulation we
 * have, so `prepareDeskSwap` must abort on it rather than fall through to a lane that cannot simulate.
 */
describe('fetchJupiterSwapQuoteDirect — venue refusal', () => {
  beforeEach(() => {
    process.env.JUPITER_API_KEY = 'test-key'
    resetJupiterQuoteCachesForTests()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    delete process.env.JUPITER_API_KEY
    vi.unstubAllGlobals()
  })

  it('flags the refusal when /order answers 200 with an empty transaction', async () => {
    vi.stubGlobal(
      'fetch',
      stubOrder({
        errorMessage: 'Insufficient funds',
        errorCode: 'InsufficientFunds',
        transaction: '',
        outAmount: '123',
      }),
    )

    await expect(fetchJupiterSwapQuoteDirect(PARAMS)).rejects.toMatchObject({
      name: 'JupiterSwapQuoteError',
      venueRefused: true,
      statusCode: 422,
    })
  })

  it('does not flag a healthy order', async () => {
    vi.stubGlobal(
      'fetch',
      stubOrder({
        outAmount: '123',
        otherAmountThreshold: '120',
        transaction: 'AQAB',
        requestId: 'req-1',
        inputMint: SOL,
        outputMint: USDC,
      }),
    )

    const quote = await fetchJupiterSwapQuoteDirect(PARAMS)
    expect(quote.outAmount).toBe('123')
    expect(quote.transaction).toBe('AQAB')
  })

  it('still surfaces a plain transport failure without the refusal flag', async () => {
    vi.stubGlobal('fetch', stubOrder({ error: 'boom' }, 500))

    await expect(fetchJupiterSwapQuoteDirect(PARAMS)).rejects.toMatchObject({
      statusCode: 500,
    })
    await expect(
      fetchJupiterSwapQuoteDirect(PARAMS).catch((e) => e),
    ).resolves.toSatisfy((e: { venueRefused?: boolean }) => !e.venueRefused)
  })
})
