import { describe, expect, it } from 'vitest'
import { evaluateRugSignalFrom1m, type RugSignalBar } from '@/strategies/rug-signal'

/**
 * The 1m block basis (SPEC-rug-verdict-block T2).
 *
 * Ten one-minute bars is **two** 5m bars, so under the original basis a fresh token is `no_bars` —
 * an unknown, not a low score. The 1m basis is what makes a 10-minute-old token judgeable at all,
 * which is the entire reason the SPEC moves the window.
 *
 * The 5m path must stay byte-identical while the two are compared, so the last test pins it.
 */

const minutes = (n: number): RugSignalBar[] =>
  Array.from({ length: n }, (_, i) => ({
    t: 1_800_000_000 + i * 60,
    o: 100,
    h: 101,
    l: 99,
    c: 100.5,
    v: 10,
  }))

const ctx = { mcap: 100_000, liquidityUsd: 1_000 }

describe('evaluateRugSignalFrom1m — the block basis', () => {
  it('judges ten minutes that the 5m basis cannot judge', () => {
    const five = evaluateRugSignalFrom1m({ bars1m: minutes(10), ...ctx })
    const one = evaluateRugSignalFrom1m({ bars1m: minutes(10), ...ctx }, {}, { basis: '1m' })

    // Ten 1m bars is two 5m bars: below the 5m floor of 5, so the shape is not evaluated at all.
    expect(five.judged).toBe(false)
    // The same ten minutes are a complete block on the 1m pair (window 10, floor 6).
    expect(one.judged).toBe(true)
    expect(one.barsScored).toBe(10)
  })

  it('still refuses a block below the 1m floor', () => {
    const short = evaluateRugSignalFrom1m({ bars1m: minutes(4), ...ctx }, {}, { basis: '1m' })
    expect(short.judged).toBe(false)
    expect(short.barsScored).toBeLessThan(6)
  })

  it('caps the block at the 1m window, not the whole series', () => {
    const long = evaluateRugSignalFrom1m({ bars1m: minutes(120), ...ctx }, {}, { basis: '1m' })
    expect(long.barsScored).toBe(10)
  })

  it('leaves the default path untouched — no basis means 5m, exactly as before', () => {
    const bars = minutes(120)
    expect(evaluateRugSignalFrom1m({ bars1m: bars, ...ctx })).toEqual(
      evaluateRugSignalFrom1m({ bars1m: bars, ...ctx }, {}, { basis: '5m' }),
    )
  })
})
