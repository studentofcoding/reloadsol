import { describe, expect, it } from 'vitest'
import { presenceMintKey } from './useTokenPresence'

describe('presenceMintKey', () => {
  it('is order independent so a rebuilt array does not refetch', () => {
    const a = 'So11111111111111111111111111111111111111112'
    const b = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    expect(presenceMintKey([a, b])).toBe(presenceMintKey([b, a]))
  })

  it('dedupes and trims', () => {
    const a = 'So11111111111111111111111111111111111111112'
    expect(presenceMintKey([a, ` ${a} `, a])).toBe(a)
  })

  it('drops empty entries', () => {
    const a = 'So11111111111111111111111111111111111111112'
    expect(presenceMintKey(['', '   ', a])).toBe(a)
    expect(presenceMintKey([])).toBe('')
  })
})
