import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectCachedManualMints } from './filtering'

const SOURCE = readFileSync(join(__dirname, 'filtering.ts'), 'utf8')
// Strip comments: the doc block above the function quotes the old unbounded query on purpose.
const CODE = SOURCE.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

describe('selectCachedManualMints', () => {
  const cache = {
    at: 1_000,
    queried: new Set(['mintA', 'mintB']),
    mints: new Set(['mintB']),
  }

  it('returns the intersection of the cached answer and the mints asked about', () => {
    const got = selectCachedManualMints(cache, ['mintA', 'mintB'], 600_000, 1_500)
    expect([...(got ?? [])]).toEqual(['mintB'])
  })

  it('refuses the cache when it never covered a mint being asked about', () => {
    // mintC was not in the earlier query, so "not in mints" proves nothing about it.
    expect(selectCachedManualMints(cache, ['mintA', 'mintC'], 600_000, 1_500)).toBeNull()
  })

  it('expires', () => {
    expect(selectCachedManualMints(cache, ['mintB'], 600_000, 1_000 + 600_001)).toBeNull()
  })

  it('has nothing to say without a cache', () => {
    expect(selectCachedManualMints(null, ['mintA'], 600_000, 1_500)).toBeNull()
  })

  it('handles a mint that is manual but was not asked about', () => {
    const wide = { at: 0, queried: new Set(['a', 'b', 'c']), mints: new Set(['a', 'c']) }
    const got = selectCachedManualMints(wide, ['b'], 600_000, 1)
    expect([...(got ?? [])]).toEqual([])
  })
})

describe('checkManualTradingHistoryBatch query shape', () => {
  // Pins the regression: this used to select the whole `data` column for every non-bot row —
  // measured 161,931 rows / 162 MB on prod, per 5-minute cycle, to answer about ~40 mints.
  it('asks the database only for the mints it was given', () => {
    expect(SOURCE).toContain("t->>'mintAddress' = ANY($1::text[])")
    expect(SOURCE).toContain('jsonb_typeof(data->\'tokens\')')
  })

  it('never selects the whole data column from trading_records again', () => {
    expect(CODE).not.toMatch(/SELECT\s+data\s+FROM\s+trading_records/i)
  })

  it('guards against a non-array tokens field', () => {
    // jsonb_array_elements throws on a non-array, which would take the whole cycle down.
    expect(SOURCE).toContain("ELSE '[]'::jsonb")
  })
})
