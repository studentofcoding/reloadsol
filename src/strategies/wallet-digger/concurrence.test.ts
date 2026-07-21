import { describe, expect, it } from 'vitest'
import { findConcurrenceClusters } from './concurrence'

describe('findConcurrenceClusters', () => {
  const roster = new Set(['w1', 'w2', 'w3', 'w4', 'w5'])

  it('fires when 4 distinct roster wallets buy same mint within 15m', () => {
    const base = 1_700_000_000
    const events = [
      { maker: 'w1', tokenAddress: 'mintA', tradeAtSec: base },
      { maker: 'w2', tokenAddress: 'mintA', tradeAtSec: base + 60 },
      { maker: 'w3', tokenAddress: 'mintA', tradeAtSec: base + 120 },
      { maker: 'w4', tokenAddress: 'mintA', tradeAtSec: base + 200 },
    ]
    const clusters = findConcurrenceClusters({
      events,
      roster,
      windowSec: 15 * 60,
      minWallets: 4,
    })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.tokenAddress).toBe('mintA')
    expect(clusters[0]!.makers).toEqual(['w1', 'w2', 'w3', 'w4'])
  })

  it('ignores non-roster makers', () => {
    const base = 1_700_000_000
    const events = [
      { maker: 'w1', tokenAddress: 'mintA', tradeAtSec: base },
      { maker: 'outsider', tokenAddress: 'mintA', tradeAtSec: base + 10 },
      { maker: 'w2', tokenAddress: 'mintA', tradeAtSec: base + 20 },
      { maker: 'w3', tokenAddress: 'mintA', tradeAtSec: base + 30 },
    ]
    const clusters = findConcurrenceClusters({
      events,
      roster,
      windowSec: 15 * 60,
      minWallets: 4,
    })
    expect(clusters).toHaveLength(0)
  })

  it('does not fire when buys span beyond window', () => {
    const base = 1_700_000_000
    const events = [
      { maker: 'w1', tokenAddress: 'mintA', tradeAtSec: base },
      { maker: 'w2', tokenAddress: 'mintA', tradeAtSec: base + 60 },
      { maker: 'w3', tokenAddress: 'mintA', tradeAtSec: base + 120 },
      { maker: 'w4', tokenAddress: 'mintA', tradeAtSec: base + 15 * 60 + 1 },
    ]
    const clusters = findConcurrenceClusters({
      events,
      roster,
      windowSec: 15 * 60,
      minWallets: 4,
    })
    expect(clusters).toHaveLength(0)
  })
})
