import { describe, expect, it, vi } from 'vitest'
import {
  attachClosedLoopScoresToSignals,
  isDecorativeClosedLoopBatch,
} from './signals-early-closed-loop'
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
      entryMcap: 70_000,
      milestone80: false,
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

  it('passes entry mcap and the at_80 arm into the scorer', async () => {
    const loadCombinedScore = vi.fn(async () => ({
      mlScore: 0.8,
      modelVersion: 'cl-arm',
    }))
    await attachClosedLoopScoresToSignals(
      [scored({ token_address: 'M', current_mcap: 120_000, mcap_growth_percent: 90 })],
      { loadCombinedScore: loadCombinedScore as never, closedLoopEnabled: true },
    )
    expect(loadCombinedScore).toHaveBeenCalledWith({
      address: 'M',
      chain: 'sol',
      hours: 24,
      entryMcap: 120_000,
      milestone80: true,
    })
  })

  it('nulls a flat ~0.32 batch across different entry mcaps', async () => {
    const loadCombinedScore = vi.fn(async () => ({
      mlScore: 0.3201,
      modelVersion: 'cl-flat',
    }))
    const out = await attachClosedLoopScoresToSignals(
      [
        scored({ token_address: 'A', current_mcap: 40_000, mcap_growth_percent: 20 }),
        scored({ token_address: 'B', current_mcap: 180_000, mcap_growth_percent: 30 }),
        scored({ token_address: 'C', current_mcap: 900_000, mcap_growth_percent: 40 }),
      ],
      { loadCombinedScore: loadCombinedScore as never, closedLoopEnabled: true },
    )
    expect(out.map((row) => row.ml_closed_loop_score)).toEqual([null, null, null])
    expect(out.every((row) => row.ml_closed_loop_version === 'cl-flat')).toBe(true)
  })

  it('keeps scores that separate mints', async () => {
    const loadCombinedScore = vi.fn(
      async ({ entryMcap }: { entryMcap?: number }) => ({
        mlScore: (entryMcap ?? 0) < 100_000 ? 0.22 : 0.71,
        modelVersion: 'cl-real',
      }),
    )
    const out = await attachClosedLoopScoresToSignals(
      [
        scored({ token_address: 'A', current_mcap: 40_000, mcap_growth_percent: 20 }),
        scored({ token_address: 'B', current_mcap: 800_000, mcap_growth_percent: 40 }),
      ],
      { loadCombinedScore: loadCombinedScore as never, closedLoopEnabled: true },
    )
    expect(out[0].ml_closed_loop_score).toBe(0.22)
    expect(out[1].ml_closed_loop_score).toBe(0.71)
  })
})

describe('isDecorativeClosedLoopBatch', () => {
  it('flags the production 0.32 cluster when bands differ', () => {
    expect(
      isDecorativeClosedLoopBatch([
        { mlScore: 0.3146, entryMcap: 30_000, milestone80: false },
        { mlScore: 0.3207, entryMcap: 2_000_000, milestone80: true },
      ]),
    ).toBe(true)
  })

  it('leaves a real spread alone', () => {
    expect(
      isDecorativeClosedLoopBatch([
        { mlScore: 0.22, entryMcap: 30_000, milestone80: false },
        { mlScore: 0.71, entryMcap: 2_000_000, milestone80: true },
      ]),
    ).toBe(false)
  })
})
