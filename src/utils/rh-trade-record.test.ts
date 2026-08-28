import { describe, expect, it } from 'vitest'
import { buildRhTokenToTokenSwap } from './rh-trade-record'

describe('buildRhTokenToTokenSwap', () => {
  it('records both legs and uses received USD notional as usdValue', () => {
    const out = buildRhTokenToTokenSwap({
      from: { mintAddress: '0xfrom', symbol: 'AAA', amount: 1000, priceUsd: 1.5 },
      to: { mintAddress: '0xto', symbol: 'BBB', amount: 250, priceUsd: 5.0 },
      fromUsd: 1500,
      toUsd: 1250,
    })
    expect(out.tokens).toHaveLength(2)
    expect(out.tokens[0]).toMatchObject({
      mintAddress: '0xfrom',
      symbol: 'AAA',
      tokenAmount: 1000,
    })
    expect(out.tokens[1]).toMatchObject({
      mintAddress: '0xto',
      symbol: 'BBB',
      tokenAmount: 250,
    })
    // Received-side USD notional preferred
    expect(out.usdValue).toBe(1250)
  })

  it('falls back to sold-side USD when received is missing', () => {
    const out = buildRhTokenToTokenSwap({
      from: { mintAddress: '0xfrom', symbol: 'AAA', amount: 1000, priceUsd: 2.0 },
      to: { mintAddress: '0xto', symbol: 'BBB' },
      fromUsd: 2000,
      toUsd: null,
    })
    expect(out.tokens[1].tokenAmount).toBeUndefined()
    expect(out.usdValue).toBe(2000)
  })

  it('returns zero usdValue when no USD info is available', () => {
    const out = buildRhTokenToTokenSwap({
      from: { mintAddress: '0xfrom' },
      to: { mintAddress: '0xto' },
    })
    expect(out.usdValue).toBe(0)
    expect(out.tokens[0].tokenAmount).toBeUndefined()
    expect(out.tokens[1].tokenAmount).toBeUndefined()
  })
})
