import { describe, expect, it } from 'vitest'
import {
  applyBuySpendParam,
  buySpendQueryKey,
  readBuySpendAmount,
} from './buy-spend-query'

describe('buySpendQueryKey', () => {
  it('uses eth on robinhood and sol otherwise', () => {
    expect(buySpendQueryKey('robinhood')).toBe('eth')
    expect(buySpendQueryKey('sol')).toBe('sol')
  })
})

describe('readBuySpendAmount', () => {
  it('reads eth on robinhood and falls back to legacy sol', () => {
    expect(
      readBuySpendAmount(new URLSearchParams('eth=0.001'), 'robinhood'),
    ).toBe('0.001')
    expect(
      readBuySpendAmount(new URLSearchParams('sol=0.002'), 'robinhood'),
    ).toBe('0.002')
  })

  it('reads sol on solana', () => {
    expect(readBuySpendAmount(new URLSearchParams('sol=0.1'), 'sol')).toBe('0.1')
    expect(readBuySpendAmount(new URLSearchParams('eth=0.001'), 'sol')).toBeNull()
  })
})

describe('applyBuySpendParam', () => {
  it('writes eth and strips sol on robinhood', () => {
    const params = new URLSearchParams('sol=0.1&mints=0xabc')
    applyBuySpendParam(params, 'robinhood', '0.001')
    expect(params.get('eth')).toBe('0.001')
    expect(params.get('sol')).toBeNull()
    expect(params.get('mints')).toBe('0xabc')
  })
})
