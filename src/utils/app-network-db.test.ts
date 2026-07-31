import { describe, expect, it } from 'vitest'
import {
  chainFromStrategyId,
  filterRecordsByChain,
  parseDbChain,
} from './app-network-db'

describe('parseDbChain', () => {
  it('accepts robinhood', () => {
    expect(parseDbChain('robinhood')).toBe('robinhood')
  })

  it('defaults to sol', () => {
    expect(parseDbChain(null)).toBe('sol')
    expect(parseDbChain('eth')).toBe('sol')
  })
})

describe('chainFromStrategyId', () => {
  it('maps _rh suffix to robinhood', () => {
    expect(chainFromStrategyId('mcap_enter_at_80_rh')).toBe('robinhood')
    expect(chainFromStrategyId('mcap_enter_at_80')).toBe('sol')
  })
})

describe('filterRecordsByChain', () => {
  it('excludes opposite chain and treats missing as sol', () => {
    const rows = [
      { id: '1', chain: 'sol' },
      { id: '2', chain: 'robinhood' },
      { id: '3' },
    ]
    expect(filterRecordsByChain(rows, 'sol').map((r) => r.id)).toEqual([
      '1',
      '3',
    ])
    expect(filterRecordsByChain(rows, 'robinhood').map((r) => r.id)).toEqual([
      '2',
    ])
  })
})
