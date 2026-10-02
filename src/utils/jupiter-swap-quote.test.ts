import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildJupiterSwapQuoteUrl,
  jupiterExecuteOutcome,
  jupiterExecuteSignature,
  JupiterSwapQuoteError,
  mapJupiterOrderToDisplay,
  mapJupiterSwapDisplayToSwapQuote,
} from '@/utils/jupiter-swap-quote'
import {
  mintsNeedingJupiterQuote,
  sellAmountRaw,
  sellQuoteAllFailedBanner,
} from '@/utils/sell-quote-fallback'

const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

describe('buildJupiterSwapQuoteUrl', () => {
  it('omits taker from the quote-only order URL', () => {
    const url = buildJupiterSwapQuoteUrl({
      inputMint: USDC,
      outputMint: SOL,
      amount: '2000221',
      slippageBps: 200,
    })
    expect(url.startsWith('https://api.jup.ag/swap/v2/order?')).toBe(true)
    expect(url).not.toContain('taker')
    expect(url).toContain('inputMint=')
    expect(url).toContain('amount=2000221')
  })

  it('includes taker when building a swap-tx order', () => {
    const url = buildJupiterSwapQuoteUrl({
      inputMint: USDC,
      outputMint: SOL,
      amount: '2000221',
      slippageBps: 200,
      taker: 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV',
    })
    expect(url).toContain('taker=BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV')
  })

  it('caps auto priority on V2 with maxCap at 0.003 SOL', () => {
    const url = buildJupiterSwapQuoteUrl({
      inputMint: USDC,
      outputMint: SOL,
      amount: '2000221',
      slippageBps: 200,
      taker: 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV',
      priorityFeeLamports: 3_000_000,
      broadcastFeeType: 'maxCap',
    })
    expect(url).toContain('priorityFeeLamports=3000000')
    expect(url).toContain('broadcastFeeType=maxCap')
  })
})

describe('jupiterExecuteSignature', () => {
  it('returns the signature on Success', () => {
    expect(
      jupiterExecuteSignature({ status: 'Success', signature: 'sig-1', code: 0 }),
    ).toBe('sig-1')
  })

  it('keeps the filled output amount from a confirmed execute', () => {
    expect(
      jupiterExecuteOutcome({
        status: 'Success',
        signature: 'sig-1',
        code: 0,
        outputAmountResult: '42',
      }),
    ).toEqual({ signature: 'sig-1', outputAmountResult: '42' })
  })

  it('throws when execute failed so the caller can fall back', () => {
    expect(() =>
      jupiterExecuteSignature({
        status: 'Failed',
        code: -1000,
        error: 'Failed to land',
      }),
    ).toThrow(JupiterSwapQuoteError)
  })
})

describe('mapJupiterOrderToDisplay', () => {
  it('maps outAmount from a sample /order JSON', () => {
    const mapped = mapJupiterOrderToDisplay(
      {
        inputMint: USDC,
        outputMint: SOL,
        inAmount: '2000221',
        outAmount: '19673060',
        otherAmountThreshold: '19580613',
        priceImpactPct: -0.00026,
        slippageBps: 50,
      },
      '2000221',
      50,
    )
    expect(mapped?.outAmount).toBe('19673060')
    expect(mapped?.minAmountOut).toBe('19580613')
    expect(mapped?.priceImpact).toBeCloseTo(-0.00026)
    expect(mapped?.transaction).toBeNull()
  })

  it('keeps transaction + requestId when taker order includes a tx', () => {
    const mapped = mapJupiterOrderToDisplay(
      {
        inputMint: USDC,
        outputMint: SOL,
        outAmount: '19673060',
        transaction: 'AQID',
        requestId: 'req-1',
        lastValidBlockHeight: '12345',
        routePlan: [{ swapInfo: {} }],
      },
      '2000221',
      50,
    )
    expect(mapped?.transaction).toBe('AQID')
    expect(mapped?.requestId).toBe('req-1')
    expect(mapped?.lastValidBlockHeight).toBe(12345)
    expect(mapJupiterSwapDisplayToSwapQuote(mapped!).outAmount).toBe('19673060')
    expect(mapJupiterSwapDisplayToSwapQuote(mapped!).routePlan).toHaveLength(1)
  })

  it('returns null without outAmount', () => {
    expect(mapJupiterOrderToDisplay({ error: 'no route' }, '1', 50)).toBeNull()
  })
})

describe('sell quote fallback banner', () => {
  it('does not banner when some Jupiter hits exist', () => {
    expect(sellQuoteAllFailedBanner(2)).toBeNull()
  })

  it('banners only when every mint failed both sources', () => {
    expect(sellQuoteAllFailedBanner(0)).toBe(
      'Failed to get swap quotes. Please try again.',
    )
  })
})

describe('mintsNeedingJupiterQuote', () => {
  it('skips Raptor hits and still-valid quotes', () => {
    const now = 1_000_000
    const need = mintsNeedingJupiterQuote(
      ['a', 'b', 'c'],
      new Set(['a']),
      { b: { timestamp: now - 5_000 } },
      now,
    )
    expect(need).toEqual(['c'])
  })
})

describe('sellAmountRaw', () => {
  it('emits integer smallest units', () => {
    expect(sellAmountRaw(1_234_567_890)).toBe('1234567890')
    expect(sellAmountRaw(12.9)).toBe('12')
  })
})

import {
  jupiterOrderKey,
  withJupiterOrderQuote,
  resetJupiterQuoteCachesForTests,
} from './jupiter-swap-quote'

describe('jupiter order coalescing + quote cache', () => {
  const base = { inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'Mint', amount: '1000000', slippageBps: 20 }
  const value = { inputMint: base.inputMint, outputMint: base.outputMint, inAmount: base.amount, outAmount: '42' } as never

  beforeEach(() => resetJupiterQuoteCachesForTests())

  it('joins identical in-flight requests into one upstream call', async () => {
    let calls = 0
    const load = async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 10))
      return value
    }
    await Promise.all([
      withJupiterOrderQuote(base, load),
      withJupiterOrderQuote(base, load),
      withJupiterOrderQuote(base, load),
    ])
    expect(calls).toBe(1)
  })

  it('reuses a plain quote inside the cache window', async () => {
    let calls = 0
    const load = async () => {
      calls += 1
      return value
    }
    await withJupiterOrderQuote(base, load)
    await withJupiterOrderQuote(base, load)
    expect(calls).toBe(1)
  })

  it('never caches or coalesces the execution prepare — a taker always fetches fresh', async () => {
    const taker = { ...base, taker: 'Wallet1111111111111111111111111111111111111' }
    let calls = 0
    const load = async () => {
      calls += 1
      return value
    }
    await withJupiterOrderQuote(taker, load)
    await withJupiterOrderQuote(taker, load)
    expect(calls).toBe(2)
  })

  it('keys on every input, so a different amount is a different request', () => {
    expect(jupiterOrderKey(base)).not.toBe(jupiterOrderKey({ ...base, amount: '2000000' }))
    expect(jupiterOrderKey(base)).not.toBe(jupiterOrderKey({ ...base, slippageBps: 50 }))
    expect(jupiterOrderKey(base)).not.toBe(jupiterOrderKey({ ...base, taker: 'Other' }))
  })
})
