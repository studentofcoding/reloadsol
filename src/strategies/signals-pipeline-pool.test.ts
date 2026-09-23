import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/unified-logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/utils/rug-list/db', () => ({
  getRugAddressSet: vi.fn(async () => new Set<string>()),
}))

vi.mock('@/strategies/social/db', () => ({
  fetchSocialRollupsMap: vi.fn(async () => new Map()),
}))

import { query } from '@/utils/db'
import { fetchAndScoreSignals } from './signals-pipeline'
import { buildSignalsListStrategyConfig } from './signals-strategy-list'

const config = buildSignalsListStrategyConfig('default', {
  limit: 1,
  recencyMinutes: 240,
  minGrowth: 0,
  includeStuck: false,
  maxAgeMinutes: 2880,
})

function row(address: string, growth: number) {
  const now = new Date().toISOString()
  return {
    token_address: address,
    token_symbol: address.slice(0, 4),
    first_mcap: 100_000,
    current_mcap: 100_000 * (1 + growth / 100),
    mcap_growth_percent: growth,
    first_seen_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    last_updated_at: now,
    when_reach_80pct: null,
    label: null,
    is_tracking_stuck: false,
    organic_score: null,
    top_holders_pct: null,
  }
}

describe('fetchAndScoreSignals pool cap', () => {
  beforeEach(() => {
    vi.mocked(query).mockResolvedValue({
      rows: [row('mint-a', 40), row('mint-b', 30), row('mint-c', 20)],
      rowCount: 3,
    })
  })

  it('keeps the SQL pool when membership will apply limit', async () => {
    const pool = await fetchAndScoreSignals(config, {
      chain: 'sol',
      skipRugValidation: true,
      keepCandidatePool: true,
    })
    expect(pool).toHaveLength(3)
  })

  it('still slices to limit for other callers', async () => {
    const sliced = await fetchAndScoreSignals(config, {
      chain: 'sol',
      skipRugValidation: true,
    })
    expect(sliced).toHaveLength(1)
    expect(sliced[0]?.token_address).toBe('mint-a')
  })
})
