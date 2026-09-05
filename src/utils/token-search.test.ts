import { describe, expect, it } from 'vitest'
import { mergeSearchResults, type UniversalSearchToken } from './token-search'

const a: UniversalSearchToken = {
  id: '1',
  address: 'So11111111111111111111111111111111111111112',
  name: 'A',
  symbol: 'UBIK',
  chain: 'sol',
}
const b: UniversalSearchToken = { ...a, name: 'dup' }
const c: UniversalSearchToken = {
  id: '2',
  address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  name: 'B',
  symbol: 'OTHER',
  chain: 'robinhood',
}

describe('mergeSearchResults', () => {
  it('dedupes by address and prefers primary order', () => {
    expect(mergeSearchResults([a], [b, c], 10).map((t) => t.symbol)).toEqual([
      'UBIK',
      'OTHER',
    ])
  })
})
