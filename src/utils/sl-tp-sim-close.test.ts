import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SLTPPosition } from './sl-tp-tracker'

// Calls are cleared between tests; implementations are not (`clearAllMocks`, not `resetAllMocks`),
// so the module mocks below keep working and only the call history resets. Without this, a
// `not.toHaveBeenCalled()` assertion passes or fails depending on test order.
beforeEach(() => {
  vi.clearAllMocks()
})

// The real swap path. If a paper close ever reaches it, that is a real trade on a paper trigger —
// the one failure this whole design exists to make impossible.
vi.mock('@/utils/swap-executor', () => ({
  prepareSwapTransaction: vi.fn(),
  submitSignedSwap: vi.fn(),
  confirmSwapSignature: vi.fn(),
}))

vi.mock('@/strategies/close-strategy-sim-position', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/strategies/close-strategy-sim-position')>()
  return {
    ...actual,
    closePriceStrategySimPosition: vi.fn(async () => 5),
    closeMcapStrategySimPositions: vi.fn(async () => ({ closed: 1, failed: [] })),
  }
})

// The idempotency guard reads `strategy_outcomes`. Mocked by default to "not closed" so the existing
// cases keep exercising the close path; the guard's own tests override it.
// `query` is the per-position close claim (INSERT ... RETURNING): a returned row means "claimed".
vi.mock('@/utils/db', () => ({
  query: vi.fn(async () => ({ rows: [{ job_name: 'sltp_close:p1' }] })),
  queryOne: vi.fn(async () => null),
}))

const { simCloseDomainForStrategy, closeSimulatedPositionFromWorker } = await import(
  './sl-tp-sim-close'
)
const { closeReasonForTrigger } = await import('@/strategies/close-strategy-sim-position')
const closers = await import('@/strategies/close-strategy-sim-position')
const swap = await import('@/utils/swap-executor')
const db = await import('@/utils/db')

function paperPosition(over: Partial<SLTPPosition> = {}): SLTPPosition {
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    is_active: true,
    is_simulation: true,
    chain: 'sol',
    ...over,
  }
}

describe('simCloseDomainForStrategy', () => {
  it('routes each family to the closer that owns it', () => {
    expect(simCloseDomainForStrategy('search_mcap_first_seen_sl_30_tp200_h48')).toBe('mcap')
    expect(simCloseDomainForStrategy('mcap_enter_at_80')).toBe('mcap')
    expect(simCloseDomainForStrategy('gmgn_sm_kol_combined')).toBe('gmgn')
    expect(simCloseDomainForStrategy('gmgn_kol_momentum')).toBe('gmgn')
    expect(simCloseDomainForStrategy('social_only_fomo_gt7')).toBe('social')
    expect(simCloseDomainForStrategy('search_signals_signals_score40_g0_default')).toBe('signals')
  })

  it('returns null for an unknown family rather than guessing a close path', () => {
    // Writing an outcome under the wrong domain is worse than leaving the row for its own closer.
    expect(simCloseDomainForStrategy('att_rh')).toBeNull()
    expect(simCloseDomainForStrategy('scalper')).toBeNull()
    expect(simCloseDomainForStrategy('')).toBeNull()
  })
})

/**
 * Coverage (S7). Every strategy that has ever opened a paper position, taken from prod.
 *
 * The nulls here are deliberate, but they are NOT the same kind of thing:
 *
 *   att_rh  — **SHADOW.** It now registers its exit contract at open and the worker evaluates its
 *             triggers every pass, but no closer owns the family, so nothing is acted on. That is
 *             how its own `decideRhTrendingExit` ladder gets compared against `evaluateExit` before
 *             anything enforces the comparison. It reads as `null` here on purpose; giving it a
 *             domain is the enforce step, and that waits for the comparison.
 *   scalper — never opened a position (0 closes in 3d), so it has no exit contract to assert.
 */
describe('coverage across the real strategy set', () => {
  const ROUTED: Record<string, string> = {
    search_mcap_first_seen_sl_30_tp150_h48: 'mcap',
    search_mcap_first_seen_sl_30_tp200_h48: 'mcap',
    search_mcap_first_seen_sl_30_tp300_h48: 'mcap',
    mcap_enter_at_80: 'mcap',
    mcap_enter_first_seen: 'mcap',
    gmgn_sm_kol_combined: 'gmgn',
    gmgn_kol_momentum: 'gmgn',
    gmgn_roster_concurrence: 'gmgn',
    social_only_fomo_gt7: 'social',
    search_signals_signals_score40_g0_default: 'signals',
    signals_default_rh: 'signals',
    signals_sell_over_100: 'signals',
  }
  const DELIBERATE_GAPS = ['att_rh', 'scalper']

  it('routes every strategy that opens, and leaves only the named gaps', () => {
    for (const [id, domain] of Object.entries(ROUTED)) {
      expect(simCloseDomainForStrategy(id), `${id} should route to ${domain}`).toBe(domain)
    }
    for (const id of DELIBERATE_GAPS) {
      expect(simCloseDomainForStrategy(id), `${id} is a documented gap`).toBeNull()
    }
    expect(Object.keys(ROUTED)).toHaveLength(12)
  })
})

describe('closeSimulatedPositionFromWorker — the isolation invariant', () => {
  it('closes a paper position WITHOUT ever reaching the real swap path', async () => {
    const result = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'gmgn_sm_kol_combined' }),
      triggerType: 'take_profit_1',
      currentPrice: 3.1,
    })

    expect(result).toMatchObject({ closed: true, domain: 'gmgn' })
    expect(closers.closePriceStrategySimPosition).toHaveBeenCalled()
    // THE assertion: a paper trigger must not be able to spend money.
    expect(swap.prepareSwapTransaction).not.toHaveBeenCalled()
    expect(swap.submitSignedSwap).not.toHaveBeenCalled()
    expect(swap.confirmSwapSignature).not.toHaveBeenCalled()
  })

  it('scopes an mcap close to the one mint, not the whole strategy', async () => {
    await closeSimulatedPositionFromWorker({
      position: paperPosition({
        strategy_id: 'mcap_enter_at_80',
        token_address: 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
      triggerType: 'stop_loss',
      currentPrice: 0.6,
    })
    expect(closers.closeMcapStrategySimPositions).toHaveBeenCalledWith(
      'mcap_enter_at_80',
      'sol',
      expect.objectContaining({
        mintAddress: 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        closeReason: 'stop_loss',
      }),
    )
    expect(swap.submitSignedSwap).not.toHaveBeenCalled()
  })

  it('reports rather than throws when an unknown family cannot be routed', async () => {
    const result = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'att_rh', chain: 'robinhood' }),
      triggerType: 'stop_loss',
      currentPrice: 0.6,
    })
    expect(result).toEqual({ closed: false, domain: null })
  })
})

describe('closeReasonForTrigger', () => {
  it('maps the worker trigger vocabulary onto the outcome vocabulary', () => {
    expect(closeReasonForTrigger('stop_loss')).toBe('stop_loss')
    expect(closeReasonForTrigger('take_profit_1')).toBe('take_profit')
    expect(closeReasonForTrigger('take_profit_2')).toBe('take_profit')
    expect(closeReasonForTrigger('take_profit_3')).toBe('take_profit')
    expect(closeReasonForTrigger('max_hold_time')).toBe('max_hold')
    expect(closeReasonForTrigger('max_age')).toBe('max_age')
    expect(closeReasonForTrigger('label_rugged')).toBe('label_rugged')
  })

  it('falls back to deactivation for an unrecognised trigger', () => {
    expect(closeReasonForTrigger('something_new')).toBe('strategy_deactivated')
  })
})

/**
 * The re-close guard. The worker retires the mirror LAST, so a pass killed between the outcome write
 * and the mirror update leaves a row that is still active with its outcome already written — and the
 * next tick would close it a second time, inventing a trade in the sim's ledger.
 */
describe('a trade that already closed cannot close twice', () => {
  it('writes NOTHING and reports alreadyClosed, so the caller retires the mirror', async () => {
    const { queryOne } = await import('@/utils/db')
    vi.mocked(queryOne).mockResolvedValueOnce({ id: 'outcome-1' } as never)

    const result = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'gmgn_sm_kol_combined' }),
      triggerType: 'take_profit_1',
      currentPrice: 3.1,
    })

    // `closed: true` so the caller retires the mirror — that IS the repair. But the closer was never
    // reached, so there is no second sell record.
    expect(result).toMatchObject({ closed: true, domain: 'gmgn', alreadyClosed: true })
    expect(closers.closePriceStrategySimPosition).not.toHaveBeenCalled()
  })

  it('closes normally when the outcome does not exist', async () => {
    const result = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'gmgn_sm_kol_combined' }),
      triggerType: 'take_profit_1',
      currentPrice: 3.1,
    })

    expect(result).toMatchObject({ closed: true, domain: 'gmgn' })
    expect(result.alreadyClosed).toBeUndefined()
    expect(closers.closePriceStrategySimPosition).toHaveBeenCalled()
  })

  it('keys on the FULL identity, not the mint alone', async () => {
    // The same mint traded twice is two different trades — att_rh has one mint at 1,610 closes. A
    // mint-keyed check would silently skip every re-entry, which is a missed exit, not a saved one.
    const { queryOne } = await import('@/utils/db')
    vi.mocked(queryOne).mockResolvedValueOnce(null as never)

    const position = paperPosition({ strategy_id: 'gmgn_sm_kol_combined' })
    await closeSimulatedPositionFromWorker({ position, triggerType: 'take_profit_1', currentPrice: 3.1 })

    const [sql, params] = vi.mocked(queryOne).mock.calls.at(-1)!
    expect(String(sql)).toContain('chain = $1')
    expect(String(sql)).toContain('strategy_id = $2')
    expect(String(sql)).toContain('token_address = $3')
    expect(String(sql)).toContain('entry_at = $4')
    expect(params).toEqual([
      'sol',
      'gmgn_sm_kol_combined',
      position.token_address,
      position.created_at,
    ])
  })

  it('FAILS OPEN — a broken check must never be why a position stays open', async () => {
    const { queryOne } = await import('@/utils/db')
    vi.mocked(queryOne).mockRejectedValueOnce(new Error('db unavailable'))

    const result = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'gmgn_sm_kol_combined' }),
      triggerType: 'stop_loss',
      currentPrice: 0.6,
    })

    expect(result.closed).toBe(true)
    expect(result.alreadyClosed).toBeUndefined()
    expect(closers.closePriceStrategySimPosition).toHaveBeenCalled()
  })

  it('writes NOTHING when another pass already holds the claim on this position', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [] } as never)
    const out = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'gmgn_smartmoney_default' }),
      triggerType: 'stop_loss',
      currentPrice: 0.5,
    })
    expect(out).toMatchObject({ closed: false, claimedElsewhere: true })
    expect(closers.closePriceStrategySimPosition).not.toHaveBeenCalled()
    expect(closers.closeMcapStrategySimPositions).not.toHaveBeenCalled()
  })

  it('releases its claim when the close fails, so the next tick can retry', async () => {
    vi.mocked(closers.closePriceStrategySimPosition).mockRejectedValueOnce(new Error('boom'))
    const out = await closeSimulatedPositionFromWorker({
      position: paperPosition({ strategy_id: 'gmgn_smartmoney_default' }),
      triggerType: 'stop_loss',
      currentPrice: 0.5,
    })
    expect(out.closed).toBe(false)
    const sqls = vi.mocked(db.query).mock.calls.map((c) => String(c[0]))
    expect(sqls.some((q) => q.includes('DELETE FROM bot_job_locks'))).toBe(true)
  })
})
