import { describe, expect, it } from 'vitest'
import { tokenSearchDetailHref } from './token-search-href'

describe('tokenSearchDetailHref', () => {
  it('points at /dev/search-token/detail with address', () => {
    expect(tokenSearchDetailHref('Abc')).toBe(
      '/dev/search-token/detail?address=Abc',
    )
  })

  it('adds view when provided', () => {
    expect(tokenSearchDetailHref('Abc', 'freeview')).toBe(
      '/dev/search-token/detail?address=Abc&view=freeview',
    )
    expect(tokenSearchDetailHref('Abc', 'list')).toBe(
      '/dev/search-token/detail?address=Abc&view=list',
    )
  })
})
