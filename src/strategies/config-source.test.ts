import { describe, it, expect } from 'vitest'
import { diffSource } from './config-source'

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
