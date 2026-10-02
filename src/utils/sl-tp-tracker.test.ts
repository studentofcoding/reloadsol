import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSLTPTriggers, getExitMaxInputAgeSec, isSimulatedPosition } from './sl-tp-tracker'
import type { SLTPPosition } from './sl-tp-tracker'

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

/** A fully-contracted paper row: what the worker reads off `sl_tp_positions`. */
function row(over: Partial<SLTPPosition> = {}): SLTPPosition {
  return {
    id: 'p1',
    wallet_address: 'gmgn-sim',
    token_address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    token_symbol: 'TEST',
    position_size: 0.02,
    entry_price: 1,
    current_price: 1,
    stop_loss_price: 0.7,
    take_profit_price: 3,
    stop_loss_percentage: -30,
    take_profit_percentage: 200,
    position_type: 'bot',
    strategy_id: 'gmgn_sm_kol_combined',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    is_active: true,
    is_simulation: true,
    chain: 'sol',
    reference_kind: 'price',
    reference_value: 1,
    exit_basis: 'price',
    ...over,
  } as SLTPPosition
}

/**
 * G-e recorded "the manual branch is unexercised, because the worker only ever sees Manual: 0".
 *
 * That premise is wrong, and this is where it is corrected. There is no manual branch to exercise:
 * `evaluateExit` replaced the `position_type` branching, so the adapter passes the same thresholds
 * through either way and the split is now purely a LABEL on the row. What is genuinely unexercised in
 * production is the LIVE branch (`!isSimulation`), which is a different thing and is guarded by the
 * isolation test in `sl-tp-sim-close.test.ts`.
 */
describe('the manual/bot split is a label, not a branch', () => {
  it('decides identically for a manual and a bot row with identical thresholds', () => {
    const bot = checkSLTPTriggers(row({ position_type: 'bot' }), 3.1)
    const manual = checkSLTPTriggers(row({ position_type: 'manual' }), 3.1)

    expect(manual).toEqual(bot)
    expect(bot.trigger_type).toBe('take_profit_1')
  })

  it('holds for a stop and for a stale input too, not just the one case', () => {
    for (const price of [0.5, 1, 3.1]) {
      expect(checkSLTPTriggers(row({ position_type: 'manual' }), price)).toEqual(
        checkSLTPTriggers(row({ position_type: 'bot' }), price),
      )
    }
    expect(checkSLTPTriggers(row({ position_type: 'manual' }), 0, { stale: true }).reason).toBe(
      checkSLTPTriggers(row({ position_type: 'bot' }), 0, { stale: true }).reason,
    )
  })

  it('reads the backstop off the row — the wiring that was silently dropped', () => {
    // `max_hold_hours` is what 59-sl-tp-max-hold.sql added. Without it in the adapter the evaluator
    // got no `maxHoldHours` and `max_hold` could not fire, which is why a position that never crossed
    // its stop or target stayed open forever.
    const held = row({
      created_at: new Date(Date.now() - 50 * 3_600_000).toISOString(),
      max_hold_hours: 48,
      // Out of reach of both, so only the backstop can fire.
      stop_loss_percentage: -90,
      take_profit_percentage: 900,
    })

    expect(checkSLTPTriggers(held, 1).trigger_type).toBe('max_hold_time')

    // And a row with no backstop does NOT time out, which is the state the 160 backfilled rows were
    // in before Item 1 stamped them.
    expect(checkSLTPTriggers({ ...held, max_hold_hours: null }, 1).triggered).toBe(false)
  })
})
