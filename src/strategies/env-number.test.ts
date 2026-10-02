import { afterEach, describe, expect, it, vi } from 'vitest'
import { envNumber } from './registry'

/**
 * The helper behind every RH lever. These pin the two properties that matter for a knob: an unset or
 * unusable value falls back to the code default (so the default is canonical and deleting the env var
 * is how you return to it), and a legitimate value is adopted exactly — including `0`, which naive
 * `||` parsing silently discards.
 */
describe('envNumber', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back when unset, blank or unusable', () => {
    vi.stubEnv('WATCH_TEST_KNOB', '')
    expect(envNumber('WATCH_TEST_KNOB', 42)).toBe(42)

    vi.stubEnv('WATCH_TEST_KNOB', 'not-a-number')
    expect(envNumber('WATCH_TEST_KNOB', 42)).toBe(42)

    delete process.env.WATCH_TEST_KNOB
    expect(envNumber('WATCH_TEST_KNOB', 42)).toBe(42)
  })

  it('adopts a real value, including 0 and negatives', () => {
    // `0` is how several of these levers are disabled, so it must survive. `Number('0') || fallback`
    // would throw the disable away and quietly re-enable the limit.
    vi.stubEnv('WATCH_TEST_KNOB', '0')
    expect(envNumber('WATCH_TEST_KNOB', 42)).toBe(0)

    vi.stubEnv('WATCH_TEST_KNOB', '-30')
    expect(envNumber('WATCH_TEST_KNOB', 42)).toBe(-30)

    vi.stubEnv('WATCH_TEST_KNOB', '25000')
    expect(envNumber('WATCH_TEST_KNOB', 300_000)).toBe(25000)
  })

  it('ignores whitespace rather than reading it as a value', () => {
    vi.stubEnv('WATCH_TEST_KNOB', '   ')
    expect(envNumber('WATCH_TEST_KNOB', 7)).toBe(7)
  })
})
