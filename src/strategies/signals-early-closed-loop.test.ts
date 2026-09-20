import { describe, expect, it, vi } from 'vitest'
import { attachClosedLoopScoresToSignals } from './signals-early-closed-loop'
import type { ScoredSignal } from './signals-pipeline'

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
    ...partial,
  }
}

describe('attachClosedLoopScoresToSignals', () => {
  it('loads closed-loop score via loadCombinedScore for Stage-1 candidates', async () => {
    const loadCombinedScore = vi.fn(async ({ address }: { address: string }) => ({
      mlScore: address === 'A' ? 0.62 : 0.4,
      modelVersion: 'cl-test-1',
    }))

    const out = await attachClosedLoopScoresToSignals(
      [
        scored({ token_address: 'A' }),
        scored({ token_address: 'B', decision: 'hold' }),
        scored({ token_address: 'C', mcap_growth_percent: 150 }),
      ],
      { loadCombinedScore: loadCombinedScore as never, closedLoopEnabled: true },
    )

    expect(loadCombinedScore).toHaveBeenCalledTimes(1)
    expect(loadCombinedScore).toHaveBeenCalledWith({
      address: 'A',
      chain: 'sol',
      hours: 24,
    })
    expect(out[0].ml_closed_loop_score).toBe(0.62)
    expect(out[0].ml_closed_loop_version).toBe('cl-test-1')
    expect(out[1].ml_closed_loop_score).toBeUndefined()
    expect(out[2].ml_closed_loop_score).toBeUndefined()
  })

  it('attaches null when ML_CLOSED_LOOP is off (no infer I/O)', async () => {
    const loadCombinedScore = vi.fn()
    const out = await attachClosedLoopScoresToSignals(
      [scored({ token_address: 'A' })],
      { loadCombinedScore: loadCombinedScore as never, closedLoopEnabled: false },
    )
    expect(loadCombinedScore).not.toHaveBeenCalled()
    expect(out[0].ml_closed_loop_score).toBeNull()
    expect(out[0].ml_closed_loop_version).toBeNull()
  })

  it('fail-softs infer throw to null (unavailable)', async () => {
    const loadCombinedScore = vi.fn(async () => {
      throw new Error('model boom')
    })
    const out = await attachClosedLoopScoresToSignals(
      [scored({ token_address: 'Boom' })],
      { loadCombinedScore: loadCombinedScore as never, closedLoopEnabled: true },
    )
    expect(out[0].ml_closed_loop_score).toBeNull()
    expect(out[0].ml_closed_loop_version).toBeNull()
  })
})
