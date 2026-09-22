import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emitSignalsEarlyAlertsFromScoredAsync,
  resetSignalsEarlyAlertsForTests,
} from './signals-early-alerts'
import type { ScoredSignal } from './signals-pipeline'
import * as shadowDb from './early-enter-noul-shadow-db'

vi.mock('./early-enter-noul-shadow-db', () => ({
  insertEarlyEnterNoulShadowRow: vi.fn(async () => undefined),
  isEarlyEnterNoulKillTripped: vi.fn(async () => false),
}))

afterEach(() => {
  resetSignalsEarlyAlertsForTests()
  vi.clearAllMocks()
})

function scored(partial: Partial<ScoredSignal> & { token_address: string }): ScoredSignal {
  return {
    token_symbol: 'TEST',
    first_mcap: 50_000,
    current_mcap: 70_000,
    mcap_growth_percent: 40,
    first_seen_at: '2026-07-09T00:00:00.000Z',
    last_updated_at: '2026-07-09T01:00:00.000Z',
    in_tracking_range: true,
    trend_age_minutes: 10,
    score: 55,
    decision: 'enter',
    rationale: 'Strong momentum and recency',
    ml_closed_loop_score: 0.7,
    ml_closed_loop_version: 'cl-test',
    ...partial,
  }
}

describe('emitSignalsEarlyAlertsFromScoredAsync + Noul shadow', () => {
  const arm = { activeNoulStrategyKeys: ['mcap_enter_first_seen', 'mcap_enter_at_80'] }

  it('shadow mode: Noul suppress still emits when SPEC passes', async () => {
    const recorded = await emitSignalsEarlyAlertsFromScoredAsync(
      [scored({ token_address: 'ShadowKeep' })],
      'sol',
      {
        ...arm,
        mlSoftGateEnabled: true,
        noulShadowEnabled: true,
        noulSoftActive: false,
        callNoul: async () => ({ ok: true, noul: 0.1, model: 'jev' }),
      },
    )
    expect(recorded).toHaveLength(1)
    expect(shadowDb.insertEarlyEnterNoulShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({ band: 'suppress', strategyKey: 'mcap_enter_first_seen' }),
    )
  })

  it('soft-active + Noul suppress → no toast even if SPEC passes', async () => {
    const recorded = await emitSignalsEarlyAlertsFromScoredAsync(
      [scored({ token_address: 'SoftSuppress' })],
      'sol',
      {
        ...arm,
        mlSoftGateEnabled: true,
        noulShadowEnabled: true,
        noulSoftActive: true,
        callNoul: async () => ({ ok: true, noul: 0.05, model: 'jev' }),
      },
    )
    expect(recorded).toHaveLength(0)
  })

  it('no locked arm → no Noul row; SPEC still emits', async () => {
    const recorded = await emitSignalsEarlyAlertsFromScoredAsync(
      [scored({ token_address: 'SignalsOnly' })],
      'sol',
      {
        activeNoulStrategyKeys: ['signals_default'],
        mlSoftGateEnabled: true,
        noulShadowEnabled: true,
        noulSoftActive: false,
        callNoul: async () => ({ ok: true, noul: 0.9, model: 'jev' }),
      },
    )
    expect(recorded).toHaveLength(1)
    expect(shadowDb.insertEarlyEnterNoulShadowRow).not.toHaveBeenCalled()
  })

  it('null cl score + arm → skipped_null row, no toast (SPEC suppress)', async () => {
    const callNoul = vi.fn(async () => ({ ok: true as const, noul: 0.9, model: 'jev' }))
    const recorded = await emitSignalsEarlyAlertsFromScoredAsync(
      [scored({ token_address: 'NullCl', ml_closed_loop_score: null })],
      'sol',
      {
        ...arm,
        mlSoftGateEnabled: true,
        noulShadowEnabled: true,
        noulSoftActive: false,
        callNoul,
      },
    )
    expect(recorded).toHaveLength(0)
    expect(callNoul).not.toHaveBeenCalled()
    expect(shadowDb.insertEarlyEnterNoulShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({ band: 'skipped_null', noulCalled: false }),
    )
  })

  it('growth ≥80 picks at_80 arm', async () => {
    await emitSignalsEarlyAlertsFromScoredAsync(
      [scored({ token_address: 'At80', mcap_growth_percent: 85 })],
      'sol',
      {
        ...arm,
        mlSoftGateEnabled: true,
        noulShadowEnabled: true,
        noulSoftActive: false,
        callNoul: async () => ({ ok: true, noul: 0.9, model: 'jev' }),
      },
    )
    expect(shadowDb.insertEarlyEnterNoulShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({ strategyKey: 'mcap_enter_at_80', band: 'keep' }),
    )
  })
})
