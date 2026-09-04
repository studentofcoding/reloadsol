import { describe, expect, it } from 'vitest'
import { fomoFillToSocialEvent, normalizeFomoFill, sourceFillId } from './fomo-fills'

const sample = {
  id: 42,
  ts: 1_725_000_000,
  tx: '0xabc',
  side: 'buy',
  usd: 12.5,
  wallet: '0x9ce0cb4a00000000000000000000000000000001',
  token: '0x42afa21200000000000000000000000000000002',
  handle: 'PoorGoat_',
  priced: 'cash_leg',
  is_stock: 0,
}

describe('normalizeFomoFill', () => {
  it('extracts the monotonic source_fill_id', () => {
    expect(sourceFillId(sample)).toBe(42)
    const n = normalizeFomoFill(sample)
    expect(n?.source_fill_id).toBe(42)
    expect(n?.side).toBe('buy')
    expect(n?.wallet_address).toBe(sample.wallet)
  })

  it('drops fills without a positive integer id (dedupe key)', () => {
    expect(normalizeFomoFill({ ...sample, id: 0 })).toBeNull()
    expect(normalizeFomoFill({ ...sample, id: 'nope' })).toBeNull()
    expect(normalizeFomoFill({ ...sample, tx: '' })).toBeNull()
  })
})

describe('fomoFillToSocialEvent', () => {
  const fill = normalizeFomoFill(sample)!

  it('fans cash_leg buys into fomo_family wallet_buy', () => {
    const e = fomoFillToSocialEvent(fill, new Set())
    expect(e?.source).toBe('fomo_family')
    expect(e?.event_type).toBe('wallet_buy')
    expect(e?.chain).toBe('robinhood')
    expect(e?.external_message_id).toBe('42')
    expect(e?.wallet_address).toBe(sample.wallet.toLowerCase())
  })

  it('drops estimate, sells, and roster wallets', () => {
    expect(
      fomoFillToSocialEvent({ ...fill, priced: 'estimate' }, new Set()),
    ).toBeNull()
    expect(fomoFillToSocialEvent({ ...fill, side: 'sell' }, new Set())).toBeNull()
    expect(
      fomoFillToSocialEvent(fill, new Set([sample.wallet.toLowerCase()])),
    ).toBeNull()
  })
})
