import { describe, expect, it, vi } from 'vitest'
import type { SLTPPosition } from './sl-tp-tracker'

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

const { simCloseDomainForStrategy, closeSimulatedPositionFromWorker } = await import(
  './sl-tp-sim-close'
)
const { closeReasonForTrigger } = await import('@/strategies/close-strategy-sim-position')
const closers = await import('@/strategies/close-strategy-sim-position')
const swap = await import('@/utils/swap-executor')

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
 * Coverage (S7). Every strategy that has ever opened a paper position, taken from prod. The two
 * nulls are the known, deliberate gaps, not oversights:
 *   att_rh  — resolves no effective_exit at open, so it has no thresholds to stamp.
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
