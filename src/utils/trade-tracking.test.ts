import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/solana', () => ({
  getSolPriceUSD: vi.fn(async () => 100),
}))
vi.mock('@/utils/trading-tracker', () => ({
  fetchTokenPricesForTracking: vi.fn(async () => ({ Mint1: 0.2 })),
}))

import { publishLiveSwap } from './trade-tracking'

describe('publishLiveSwap', () => {
  it('writes a live buy record', async () => {
    const seen: Array<Record<string, unknown>> = []
    await publishLiveSwap(async (op) => {
      seen.push(op as unknown as Record<string, unknown>)
    }, {
      side: 'buy',
      walletAddress: 'wallet',
      signature: 'sig',
      tokenMint: 'Mint1',
      tokenSymbol: 'TOK',
      tokenUiAmount: 10,
      quoteAmount: 0.05,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.operationType).toBe('buy')
    expect(seen[0]?.is_simulation).toBe(false)
    expect(seen[0]?.signatures).toEqual(['sig'])
  })
})
