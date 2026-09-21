import { describe, expect, it } from 'vitest'
import {
  buildJupiterSwapQuoteUrl,
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
      'Failed to get quotes from Raptor. Please try again.',
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
