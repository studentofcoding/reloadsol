import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

import { query } from '@/utils/db'
import { resetWalletRecordsCacheForTests } from '@/utils/wallet-records-cache'
import {
  buildOpenMcapSimReportPositions,
  fetchTradingRecordsForWallet,
  loadPaperCapital,
} from './db'

const mockQuery = vi.mocked(query)

describe('fetchTradingRecordsForWallet bounds', () => {
  beforeEach(() => {
    // `fetchTradingRecordsForWallet` memoises per (wallet, opts) for 60s, and the key does not include
    // the floor. A test that re-reads a wallet an earlier test (or an earlier read in the same test)
    // already read gets the cached [] and never reaches `query` — `mock.calls[0]` is then undefined.
    resetWalletRecordsCacheForTests()
    // Hermetic: the default floor (4 days) is what these tests pin, so they must not inherit
    // TRADING_RECORDS_MAX_AGE_DAYS from the runner's shell or .env (the VPS sets it to 0).
    vi.stubEnv('TRADING_RECORDS_MAX_AGE_DAYS', undefined)
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('stays unbounded by WINDOW when no opts are given, but floored by max age', async () => {
    await fetchTradingRecordsForWallet('wallet-1')
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(String(sql)).toContain('WHERE wallet_address = $1')
    expect(String(sql)).not.toContain('bot_strategy')
    // The hard floor added 2026-10-03 IS applied here — an unbounded wallet read of
    // `trending-bot-sim-rh` is 155,054 of the table's 164,382 rows and saturates the pool.
    expect(String(sql)).toContain('make_interval')
    // Still ascending: openPositionsFor and computeOpenSimCycles both walk by time.
    expect(String(sql)).toContain('ORDER BY timestamp ASC')
    expect(params).toEqual(['wallet-1', 4])
  })

  it('bounds by strategy and window when asked', async () => {
    await fetchTradingRecordsForWallet('trending-bot-sim-rh', {
      strategies: ['att_rh'],
      sinceDays: 14,
    })
    const [sql, params] = mockQuery.mock.calls[0]!
    const text = String(sql)
    expect(text).toContain(`data->>'bot_strategy' = ANY($2::text[])`)
    expect(text).toContain('timestamp >= NOW() - make_interval(days => $3::int)')
    // The floor rides along as $4 — `sinceDays` can TIGHTEN it, never remove it.
    expect(params).toEqual(['trending-bot-sim-rh', ['att_rh'], 14, 4])
  })

  it('a non-positive window does not remove the floor', async () => {
    // `sinceDays: 0` used to mean "no window at all"; the floor is separate and still applies.
    await fetchTradingRecordsForWallet('w', { sinceDays: 0 })
    expect(String(mockQuery.mock.calls[0]![0])).toContain('make_interval')
    expect(mockQuery.mock.calls[0]![1]).toEqual(['w', 4])
  })

  it('sinceLastClose bounds per (strategy, mint), not per mint', async () => {
    await fetchTradingRecordsForWallet('trending-bot-sim-rh', {
      strategies: ['att_rh'],
      sinceLastClose: true,
    })
    const [sql, params] = mockQuery.mock.calls[0]!
    const text = String(sql)
    // The last-close CTE, the join that applies it, and no window on a NEVER-CLOSED key.
    expect(text).toContain('last_close AS')
    // Extracted in `scoped` and filtered as a column — same predicate, hashable form.
    expect(text).toContain(`t.data->>'close_position' AS closed`)
    expect(text).toContain(`closed = 'true'`)
    expect(text).toContain(`op = 'sell'`)
    // The invariant, still pinned: a (strategy, mint) with no recorded close keeps every row, so a
    // still-open position cannot read as closed. The max-age floor is applied ONLY in the OTHER arm
    // of the CASE — a key that has closed — so this branch is still unbounded for never-closed keys.
    expect(text).toContain('WHEN lc.ts IS NOT NULL THEN greatest(lc.ts,')
    expect(text).toContain('ELSE coalesce(lc.ts, to_timestamp(0))')
    expect(text).toContain('ORDER BY s.timestamp ASC')
    // Keyed on the strategy as well: a close by ONE strategy must not truncate another
    // strategy's still-open cycle on the same mint. The per-mint key did exactly that and
    // changed the reconstructed open set for 4 of the 7 active mcap strategies.
    expect(text).toContain(`t.data->>'bot_strategy' AS strategy`)
    expect(text).toContain('GROUP BY 1, 2')
    // The join must be on the COLUMNS extracted in `scoped`, never on the JSONB expressions:
    // joining on the expressions is unhashable, so the planner picked a Nested Loop over a
    // Materialize and re-read the CTE once per trading row — 110,031,740 join-filter rejections
    // and 120,096ms for 1,360 rows on the 155k-row wallet. Pinning the hashable form is the
    // whole point of this test.
    expect(text).toContain('WITH scoped AS')
    expect(text).toContain('lc.strategy = s.strategy')
    expect(text).toContain('lc.mint = s.mint')
    expect(text).not.toContain(`lc.strategy = t.data->>'bot_strategy'`)
    expect(text).not.toContain(`ON lc.mint = t.data->`)
    expect(params).toEqual(['trending-bot-sim-rh', ['att_rh']])
  })
})

describe('buildOpenMcapSimReportPositions record window', () => {
  it('reads the bounded sim history, keyed per (strategy, mint)', async () => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await buildOpenMcapSimReportPositions()
    const reads = mockQuery.mock.calls
      .map(([sql]) => String(sql))
      .filter((s) => s.includes('FROM trading_records'))
    expect(reads).toHaveLength(1)
    expect(reads[0]).toContain('last_close AS')
    expect(reads[0]).toContain('lc.strategy = s.strategy')
  })
})

/** Routes the four loadPaperCapital queries to fixtures by a distinctive fragment. */
function installCapitalDb(fixtures: {
  flow: Array<{ day: string; buys: number; deployed: number }>
  peak: Array<{ day: string; peak_open: number }>
  clip: number
  pnl: Array<Record<string, unknown>>
}) {
  mockQuery.mockImplementation(async (sql: string) => {
    const text = String(sql)
    if (text.includes('count(*)::int AS buys')) {
      return { rows: fixtures.flow, rowCount: fixtures.flow.length } as never
    }
    if (text.includes('max(open_now)::int AS peak_open')) {
      return { rows: fixtures.peak, rowCount: fixtures.peak.length } as never
    }
    if (text.includes(`ORDER BY (data->>'solAmount')`)) {
      return { rows: [{ clip: String(fixtures.clip) }], rowCount: 1 } as never
    }
    if (text.includes('FROM strategy_outcomes')) {
      return { rows: fixtures.pnl, rowCount: fixtures.pnl.length } as never
    }
    return { rows: [], rowCount: 0 } as never
  })
}

describe('loadPaperCapital', () => {
  beforeEach(() => mockQuery.mockReset())

  it('reproduces the measured 2026-09-29 SOL shape', async () => {
    installCapitalDb({
      flow: [{ day: '2026-09-29', buys: 317, deployed: 0.3772 }],
      peak: [{ day: '2026-09-29', peak_open: 122 }],
      clip: 0.00104,
      pnl: [
        {
          day: '2026-09-29',
          trades: 435,
          wins: 235,
          losses: 149,
          // Self-consistent: avg is exactly sum / count, so the day and window R:R agree.
          sum_wins: '51000',
          sum_losses: '-6832',
          expectation: '105.7',
          median: '4.83',
          avg_win: String(51000 / 235),
          avg_loss: String(-6832 / 149),
        },
      ],
    })

    const out = await loadPaperCapital({ chain: 'sol', days: 3 })
    expect(out.currency).toBe('SOL')
    const day = out.days[0]!
    expect(day.buys).toBe(317)
    expect(day.deployed).toBeCloseTo(0.3772, 4)
    expect(day.peak_open).toBe(122)
    expect(day.peak_capital).toBeCloseTo(122 * 0.00104, 6)
    expect(day.profit_factor).toBeCloseTo(51000 / 6832, 3)
    expect(day.rr_ratio).toBeCloseTo(51000 / 235 / (6832 / 149), 3)
    expect(day.win_rate).toBeCloseTo(235 / 435, 4)
    // Totals mirror the single day.
    expect(out.totals.peak_capital).toBeCloseTo(122 * 0.00104, 6)
    expect(out.totals.profit_factor).toBeCloseTo(51000 / 6832, 3)
    expect(out.totals.rr_ratio).toBeCloseTo(day.rr_ratio!, 3)
    expect(out.observed_clip).toBeCloseTo(0.00104, 6)
  })

  it('labels robinhood in ETH and keeps its numbers separate', async () => {
    installCapitalDb({
      flow: [{ day: '2026-09-29', buys: 297, deployed: 0.4455 }],
      peak: [{ day: '2026-09-29', peak_open: 6 }],
      clip: 0.0015,
      pnl: [
        {
          day: '2026-09-29',
          trades: 40,
          wins: 18,
          losses: 22,
          sum_wins: '9500',
          sum_losses: '-1900',
          expectation: '190',
          median: '-0.14',
          avg_win: '527',
          avg_loss: '-86',
        },
      ],
    })
    const out = await loadPaperCapital({ chain: 'robinhood', days: 3 })
    expect(out.currency).toBe('ETH')
    expect(out.totals.deployed).toBeCloseTo(0.4455, 4)
    expect(out.totals.profit_factor).toBeCloseTo(9500 / 1900, 3)
  })

  it('reports no profit factor when there are no losses or no trades', async () => {
    installCapitalDb({
      flow: [],
      peak: [],
      clip: 0,
      pnl: [
        {
          day: '2026-09-29',
          trades: 3,
          wins: 3,
          losses: 0,
          sum_wins: '30',
          sum_losses: null,
          expectation: '10',
          median: '10',
          avg_win: '10',
          avg_loss: null,
        },
      ],
    })
    const out = await loadPaperCapital({ chain: 'sol' })
    expect(out.days[0]!.profit_factor).toBeNull()
    expect(out.days[0]!.rr_ratio).toBeNull()
    expect(out.days[0]!.peak_capital).toBe(0)
  })

  it('merges days that only appear on one side (flow without closes, or vice versa)', async () => {
    installCapitalDb({
      flow: [
        { day: '2026-09-28', buys: 5, deployed: 0.05 },
        { day: '2026-09-29', buys: 1, deployed: 0.01 },
      ],
      peak: [{ day: '2026-09-28', peak_open: 3 }],
      clip: 0.001,
      pnl: [
        {
          day: '2026-09-29',
          trades: 2,
          wins: 1,
          losses: 1,
          sum_wins: '10',
          sum_losses: '-5',
          expectation: '2.5',
          median: '2.5',
          avg_win: '10',
          avg_loss: '-5',
        },
      ],
    })
    const out = await loadPaperCapital({ chain: 'sol' })
    expect(out.days.map((d) => d.day)).toEqual(['2026-09-28', '2026-09-29'])
    expect(out.days[0]!.trades).toBe(0)
    expect(out.days[1]!.buys).toBe(1)
    expect(out.totals.deployed).toBeCloseTo(0.06, 4)
  })
})
