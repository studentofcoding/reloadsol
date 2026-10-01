import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchJupiterSwapQuoteDirect } from '@/utils/jupiter-swap-quote'
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
