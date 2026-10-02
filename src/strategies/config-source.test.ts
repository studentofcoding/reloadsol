import { describe, it, expect } from 'vitest'
import { diffSource, storedConfigById } from './config-source'

describe('diffSource', () => {
  it('marks an unchanged value as coming from the default', () => {
    expect(diffSource({ a: 1 }, { a: 1 })).toEqual({ a: 'defaults' })
  })

  it('marks a changed value as stored', () => {
    expect(diffSource({ a: 2 }, { a: 1 })).toEqual({ a: 'stored' })
  })

  it('treats a key only the default declares as the default in force', () => {
    // The stored config simply does not mention it, so the fallback is what the system uses.
    expect(diffSource({}, { a: 1 })).toEqual({ a: 'defaults' })
  })

  it('treats a key only the effective config carries as stored', () => {
    expect(diffSource({ b: 1 }, { a: 1 })).toEqual({ a: 'defaults', b: 'stored' })
  })

  it('labels nested fields parent.child, which is how the page renders them', () => {
    expect(diffSource({ f: { min: 5, max: 9 } }, { f: { min: 5, max: 8 } })).toEqual({
      'f.min': 'defaults',
      'f.max': 'stored',
    })
  })

  it('does not care about key order — only about the values', () => {
    expect(diffSource({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({ a: 'defaults', b: 'defaults' })
  })

  it('compares arrays by content', () => {
    expect(diffSource({ xs: [1, 2] }, { xs: [1, 2] })).toEqual({ xs: 'defaults' })
    expect(diffSource({ xs: [2, 1] }, { xs: [1, 2] })).toEqual({ xs: 'stored' })
  })

  it('reports false against a missing default as stored, not as unchanged', () => {
    // The realistic shape of this trap: a boolean whose default is undefined.
    expect(diffSource({ dry: false }, {})).toEqual({ dry: 'stored' })
  })

  it('is total — a null on either side is a comparison, not a crash', () => {
    expect(diffSource({ a: null }, { a: null })).toEqual({ a: 'defaults' })
    expect(diffSource({ a: null }, { a: 1 })).toEqual({ a: 'stored' })
    expect(diffSource(null, { a: 1 })).toEqual({ a: 'defaults' })
  })
})

describe('diffSource — provenance by key presence in the stored config', () => {
  it('reports a stored value that equals the default as stored (value equality said defaults)', () => {
    expect(diffSource({ a: 1 }, { a: 1 }, { a: 1 })).toEqual({ a: 'stored' })
  })

  it('reports a key absent from the stored config as defaults even if effective differs', () => {
    // e.g. the value was derived by the merge, not set by anyone
    expect(diffSource({ a: 2 }, { a: 1 }, {})).toEqual({ a: 'defaults' })
  })

  it('treats "nothing stored" (null / {}) as all defaults, not as a crash or an empty result', () => {
    expect(diffSource({ a: 1, b: 2 }, { a: 1, b: 2 }, null)).toEqual({ a: 'defaults', b: 'defaults' })
    expect(diffSource({ a: 1, b: 2 }, { a: 1, b: 2 }, {})).toEqual({ a: 'defaults', b: 'defaults' })
  })

  it('counts a stored null / false / 0 as stored', () => {
    expect(
      diffSource({ n: null, f: false, z: 0 }, { n: 5, f: true, z: 9 }, { n: null, f: false, z: 0 }),
    ).toEqual({ n: 'stored', f: 'stored', z: 'stored' })
  })

  it('recurses nested objects and checks presence at the nested path', () => {
    const eff = { f: { min: 5, max: 9 } }
    const def = { f: { min: 5, max: 8 } }
    // min pinned to its default value, max overridden
    expect(diffSource(eff, def, { f: { min: 5, max: 9 } })).toEqual({
      'f.min': 'stored',
      'f.max': 'stored',
    })
    // only max stored: min is the default in force
    expect(diffSource(eff, def, { f: { max: 9 } })).toEqual({
      'f.min': 'defaults',
      'f.max': 'stored',
    })
    // the parent key exists but is not an object: nothing under it is stored
    expect(diffSource(eff, def, { f: null })).toEqual({ 'f.min': 'defaults', 'f.max': 'defaults' })
  })

  it('walks a registry keyed by strategy id', () => {
    const def = { att: { stop: -20, tp: 50 }, att2: { stop: -20, tp: 50 } }
    const eff = { att: { stop: -20, tp: 50 }, att2: { stop: -20, tp: 50 } }
    expect(diffSource(eff, def, { att: { stop: -20 } })).toEqual({
      'att.stop': 'stored',
      'att.tp': 'defaults',
      'att2.stop': 'defaults',
      'att2.tp': 'defaults',
    })
  })

  it('a key only the effective config carries is stored only if the stored config has it', () => {
    expect(diffSource({ b: 1 }, {}, { b: 1 })).toEqual({ b: 'stored' })
    expect(diffSource({ b: 1 }, {}, {})).toEqual({ b: 'defaults' })
  })

  it('a key the default has and the effective lacks stays defaults regardless of stored', () => {
    expect(diffSource({}, { a: 1 }, { a: 1 })).toEqual({ a: 'defaults' })
  })

  it('keeps the value-equality fallback when no stored config is passed', () => {
    expect(diffSource({ a: 1 }, { a: 1 })).toEqual({ a: 'defaults' })
    expect(diffSource({ a: 2 }, { a: 1 })).toEqual({ a: 'stored' })
  })
})

describe('storedConfigById', () => {
  const rows = [
    {
      id: 'att',
      domain: 'trending_bot',
      chain: 'sol',
      name: 'ATT',
      description: null,
      config: { stop_loss_percentage: -20 },
      is_active: false,
      execution_mode: 'sim_only',
    },
    { id: 'att_rh', domain: 'trending_bot', chain: 'robinhood', name: '', config: {}, is_active: true },
    { id: 'sig', domain: 'signals', chain: 'sol', config: null, is_active: true },
  ]

  it('returns the raw config plus the row columns the merge applies', () => {
    expect(storedConfigById(rows, 'trending_bot', 'sol')).toEqual({
      att: {
        stop_loss_percentage: -20,
        name: 'ATT',
        execution_mode: 'sim_only',
        is_active: false,
      },
    })
  })

  it('filters by domain and by chain, and tolerates a non-object config', () => {
    expect(Object.keys(storedConfigById(rows, 'trending_bot', 'robinhood'))).toEqual(['att_rh'])
    expect(storedConfigById(rows, 'signals', 'sol')).toEqual({ sig: { is_active: true } })
    expect(storedConfigById(rows, 'gmgn', 'sol')).toEqual({})
  })

  it('nests the config under `config` for the shape that keeps thresholds there (DLMM)', () => {
    const dlmm = [
      { id: 'dlmm_default', domain: 'dlmm', config: { min_tvl: 50000 }, is_active: true },
    ]
    expect(storedConfigById(dlmm, 'dlmm', undefined, { nestConfig: true })).toEqual({
      dlmm_default: { config: { min_tvl: 50000 }, is_active: true },
    })
  })

  it('end to end: a pinned-to-default value is stored, an untouched one is not', () => {
    const def = { att: { stop_loss_percentage: -20, max_hold_hours: 24, is_active: true } }
    const eff = { att: { stop_loss_percentage: -20, max_hold_hours: 24, is_active: false } }
    const stored = storedConfigById(rows, 'trending_bot', 'sol')
    expect(diffSource(eff, def, stored)).toEqual({
      'att.stop_loss_percentage': 'stored',
      'att.max_hold_hours': 'defaults',
      'att.is_active': 'stored',
    })
  })
})
