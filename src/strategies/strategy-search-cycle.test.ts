import { describe, expect, it } from 'vitest'
import type { StrategyOutcomeRow } from './types'
import {
  candidateFromSearchRow,
  canonicalSimId,
  meanPBad,
  passesPBadPrior,
  rankAndFilterCandidates,
  shouldReplaceCanonical,
  spawnRank,
} from './strategy-search-cycle'
import { DEFAULT_FITNESS, computeStrategyFitness } from './strategy-fitness'

function outcome(partial: Partial<StrategyOutcomeRow>): StrategyOutcomeRow {
  return {
    id: partial.id ?? '1',
    strategy_id: partial.strategy_id ?? 's',
    domain: partial.domain ?? 'gmgn',
    token_address: 'mint',
    entry_at: '2026-06-01T00:00:00.000Z',
    exit_at: '2026-06-02T00:00:00.000Z',
    pnl_pct: partial.pnl_pct ?? 10,
    status: 'won',
    is_simulated: true,
    features: partial.features ?? {},
    created_at: '2026-06-02T00:00:00.000Z',
    chain: 'sol',
  }
}

describe('spawn prior', () => {
  it('meanPBad ignores missing scores', () => {
    expect(meanPBad([outcome({ features: {} })]).n).toBe(0)
    expect(meanPBad([outcome({ features: { ml_gate_p_bad: 0.2 } }), outcome({ features: { ml_gate_p_bad: 0.4 } })]).mean).toBeCloseTo(0.3)
  })

  it('spawnRank discounts PnL by pBad', () => {
    expect(spawnRank(10, null)).toBe(10)
    expect(spawnRank(10, 1)).toBe(5)
  })

  it('passesPBadPrior only drops when n≥10 and mean above max', () => {
    expect(passesPBadPrior(0.9, 5, 0.65, 10)).toBe(true)
    expect(passesPBadPrior(0.9, 10, 0.65, 10)).toBe(false)
    expect(passesPBadPrior(0.2, 10, 0.65, 10)).toBe(true)
  })
})

describe('canonical replace', () => {
  it('requires the search fitness to pass and beat canonical expectancy', () => {
    const now = new Date('2026-06-28T00:00:00.000Z')
    const wins = Array.from({ length: 20 }, (_, i) =>
      outcome({
        pnl_pct: 5,
        exit_at: `2026-06-${String(Math.min(27, 1 + i)).padStart(2, '0')}T00:00:00.000Z`,
      }),
    )
    const search = computeStrategyFitness(wins, DEFAULT_FITNESS, now)
    expect(search.passes).toBe(true)
    const worse = computeStrategyFitness(
      wins.map((w) => ({ ...w, pnl_pct: 1 })),
      DEFAULT_FITNESS,
      now,
    )
    expect(shouldReplaceCanonical(search, worse)).toBe(true)
    expect(shouldReplaceCanonical(search, search)).toBe(false)
  })

  it('maps canonical sim ids', () => {
    expect(canonicalSimId('signals', { id: 'x', config: {} })).toBe('signals_default')
    expect(canonicalSimId('gmgn', { id: 'x', config: {} })).toBe('gmgn_smartmoney_default')
    expect(canonicalSimId('mcap_tracker', { id: 'x', config: { entryTemplate: 'milestone_80' } })).toBe(
      'mcap_enter_at_80',
    )
    expect(canonicalSimId('social', { id: 'x', config: {} })).toBeNull()
  })
})

describe('candidateFromSearchRow + rankAndFilter', () => {
  it('unwraps mcap and gmgn configs', () => {
    const mcap = candidateFromSearchRow({
      domain: 'mcap_tracker',
      configId: 'first_seen_sl-20',
      config: {
        id: 'first_seen_sl-20',
        entry: { mcapMin: 1, mcapMax: 2, entryTemplate: 'first_seen' },
        exit: { stopLossPct: -20, takeProfitPct: 40, maxHoldHours: 12 },
      },
    })
    expect(mcap.config.entryTemplate).toBe('first_seen')
    const gmgn = candidateFromSearchRow({
      domain: 'gmgn',
      configId: 'gmgn_a',
      config: { params: { security: { minSmartWallets: 3 }, exit: { stopLossPct: -20 } } },
    })
    expect(gmgn.config.security).toEqual({ minSmartWallets: 3 })
  })

  it('drops high-pBad grids when enough scores exist', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      outcome({
        id: String(i),
        features: { ml_gate_p_bad: 0.9, smart_wallets: 5, top_10_holder_rate: 0.1 },
      }),
    )
    const kept = rankAndFilterCandidates({
      domain: 'gmgn',
      rows,
      beatBaseline: [
        {
          configId: 'toxic',
          config: { params: { security: { minSmartWallets: 2 } } },
          holdout: { avgPnlPct: 40 },
        },
      ],
    })
    expect(kept).toHaveLength(0)
  })
})
