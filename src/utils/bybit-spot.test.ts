import { describe, expect, it } from 'vitest'
import { parseBybitTickerLast } from './bybit-spot'

describe('parseBybitTickerLast', () => {
  it('reads lastPrice from v5 ticker list', () => {
    expect(
      parseBybitTickerLast({
        retCode: 0,
        result: { list: [{ symbol: 'ETHUSDT', lastPrice: '4123.45' }] },
      }),
    ).toBe(4123.45)
  })

  it('returns 0 for empty or invalid payloads', () => {
    expect(parseBybitTickerLast({})).toBe(0)
    expect(parseBybitTickerLast({ result: { list: [] } })).toBe(0)
    expect(parseBybitTickerLast({ result: { list: [{ lastPrice: 'nope' }] } })).toBe(0)
  })
})
