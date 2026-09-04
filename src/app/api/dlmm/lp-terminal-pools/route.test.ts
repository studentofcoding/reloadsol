import { describe, expect, it } from 'vitest'
import {
  buildSubgraphPairsWhere,
  parseLpIndexerBody,
} from './route'

describe('parseLpIndexerBody', () => {
  it('parses valid JSON bodies', () => {
    expect(parseLpIndexerBody('{"pools":[]}')).toEqual({ pools: [] })
  })

  it('returns null for empty / whitespace-only bodies', () => {
    expect(parseLpIndexerBody('')).toBeNull()
    expect(parseLpIndexerBody('   ')).toBeNull()
  })

  it('throws on an HTML page (retired indexer) so callers fall back', () => {
    expect(() =>
      parseLpIndexerBody('<!DOCTYPE html><html><body>bad gateway</body></html>'),
    ).toThrow(/non-JSON/)
  })

  it('throws on malformed (non-HTML) JSON', () => {
    expect(() => parseLpIndexerBody('{"pools":')).toThrow(/invalid JSON/)
  })
})

describe('buildSubgraphPairsWhere', () => {
  it('returns empty clause when no filters', () => {
    expect(buildSubgraphPairsWhere({})).toBe('')
  })

  it('adds reserveUSD_gte when minTvl is a positive number', () => {
    const clause = buildSubgraphPairsWhere({ minTvl: '1000' })
    expect(clause).toContain('reserveUSD_gte: "1000"')
  })

  it('matches pool id (address lookup) and both tokens under OR', () => {
    const clause = buildSubgraphPairsWhere({ q: '0xAbC123' })
    // Pool-address search must resolve via the pair id, not only tokens.
    expect(clause).toContain('id_contains: "0xabc123"')
    expect(clause).toContain('token0_')
    expect(clause).toContain('token1_')
    expect(clause).toContain('symbol_contains_nocase')
  })

  it('escapes quotes in the q filter (and lowercases the query)', () => {
    const clause = buildSubgraphPairsWhere({ q: 'A"B' })
    expect(clause).toContain('"a\\"b"')
  })
})