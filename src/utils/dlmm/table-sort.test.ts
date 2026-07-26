import { describe, expect, it } from 'vitest'
import {
  compareNum,
  compareStr,
  toggleSort,
} from '@/utils/dlmm/table-sort'

describe('toggleSort', () => {
  it('uses desc first for numeric columns', () => {
    expect(
      toggleSort('pair', 'asc', 'tvl', { numericFirstDesc: true }),
    ).toEqual({ key: 'tvl', dir: 'desc' })
  })

  it('uses asc first for string columns', () => {
    expect(
      toggleSort('tvl', 'desc', 'pair', { numericFirstDesc: false }),
    ).toEqual({ key: 'pair', dir: 'asc' })
  })

  it('flips when same key', () => {
    expect(
      toggleSort('tvl', 'desc', 'tvl', { numericFirstDesc: true }),
    ).toEqual({ key: 'tvl', dir: 'asc' })
  })
})

describe('compareNum / compareStr', () => {
  it('sorts numbers with nulls last', () => {
    expect(compareNum(1, 2, 'asc')).toBeLessThan(0)
    expect(compareNum(1, 2, 'desc')).toBeGreaterThan(0)
    expect(compareNum(null, 1, 'desc')).toBe(1)
    expect(compareNum(1, null, 'asc')).toBe(-1)
  })

  it('sorts strings A→Z / Z→A', () => {
    expect(compareStr('alpha', 'beta', 'asc')).toBeLessThan(0)
    expect(compareStr('alpha', 'beta', 'desc')).toBeGreaterThan(0)
    expect(compareStr('', 'x', 'asc')).toBe(1)
  })
})
