import { afterEach, describe, expect, it, vi } from 'vitest'
import { getExitMaxInputAgeSec, isSimulatedPosition } from './sl-tp-tracker'

/**
 * The safety invariant. `executeSellOrder` runs a REAL swap (it hardcodes isSimulated: false), and
 * `reconcileClosedPositions` prunes any position whose wallet balance reads zero — which is every
 * paper position, since paper tokens never exist on-chain. Both paths must ask this first, so a
 * simulated stop-loss can neither spend real money nor vanish on the first reconcile pass.
 */
describe('isSimulatedPosition', () => {
  it('is true only for an explicit simulated flag', () => {
    expect(isSimulatedPosition({ is_simulation: true })).toBe(true)
  })

  it('is false for live positions and for the flag being absent', () => {
    expect(isSimulatedPosition({ is_simulation: false })).toBe(false)
    expect(isSimulatedPosition({})).toBe(false)
    expect(isSimulatedPosition({ is_simulation: null })).toBe(false)
    expect(isSimulatedPosition({ is_simulation: undefined })).toBe(false)
  })

  it('defaults to the SAFE side for a missing position', () => {
    // Called with nothing, the guard must not claim "simulated" and skip a real sell.
    expect(isSimulatedPosition(null)).toBe(false)
    expect(isSimulatedPosition(undefined)).toBe(false)
  })
})

/**
 * The SPEC's env table documented `EXIT_MAX_INPUT_AGE_SEC` for months while no code read it, so the
 * key was decorative. These pin the defaults the table states.
 */
describe('exit env knobs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults the max input age to 180s and honours the env key', () => {
    vi.stubEnv('EXIT_MAX_INPUT_AGE_SEC', '')
    expect(getExitMaxInputAgeSec()).toBe(180)

    vi.stubEnv('EXIT_MAX_INPUT_AGE_SEC', '30')
    expect(getExitMaxInputAgeSec()).toBe(30)
  })

  it('falls back on a nonsense value rather than adopting it', () => {
    // A non-numeric or negative bound must not silently disable the guard it configures.
    vi.stubEnv('EXIT_MAX_INPUT_AGE_SEC', 'not-a-number')
    expect(getExitMaxInputAgeSec()).toBe(180)

    vi.stubEnv('EXIT_MAX_INPUT_AGE_SEC', '-5')
    expect(getExitMaxInputAgeSec()).toBe(180)

    vi.stubEnv('EXIT_MAX_INPUT_AGE_SEC', '0')
    expect(getExitMaxInputAgeSec()).toBe(180)
  })
})
