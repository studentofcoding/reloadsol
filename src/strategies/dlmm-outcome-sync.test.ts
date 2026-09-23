import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/dlmm/db', () => ({
  getAgentConfig: vi.fn(async () => ({ id: 'cfg', dry_run: true })),
}))

vi.mock('@/utils/meteora', () => ({
  fetchMeteoraPool: vi.fn(async () => ({
    token_x: { address: 'Mint111111111111111111111111111111111111', symbol: 'TOK' },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
  })),
}))

vi.mock('@/strategies/strategy-telegram-notify', () => ({
  notifyStrategyClose: vi.fn(),
}))

vi.mock('@/strategies/strategy-episodes', () => ({
  scheduleEpisodeFinalize: vi.fn(),
}))

vi.mock('@/strategies/eval-engine-db', () => ({
  resolvePredictionsForClosedOutcome: vi.fn(async () => 0),
}))

import { query, queryOne } from '@/utils/db'
import { fetchMeteoraPool } from '@/utils/meteora'
import { coerceIsoTimestamp } from '@/utils/datetime'
import { insertStrategyOutcome, loadRegimeTagForDate } from './db'
import {
  resetDlmmOutcomeSyncSkips,
  syncMissingDlmmOutcomesFromPositions,
} from './outcomes'

const POSITION_ID = '11111111-1111-4111-8111-111111111111'
const GMT0700_CREATED = 'Tue Sep 01 2026 10:00:00 GMT+0700 (Indochina Time)'
const GMT0700_CLOSED = 'Wed Sep 02 2026 14:23:45 GMT+0700 (Indochina Time)'

function closedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POSITION_ID,
    pool_address: 'Pool111',
    pool_name: 'TOK-SOL',
    position_pubkey: null,
    token_x_symbol: 'TOK',
    token_y_symbol: 'SOL',
    amount_sol: 1,
    min_bin_id: 1,
    max_bin_id: 2,
    entry_value_usd: 10,
    current_value_usd: 12,
    fees_earned_usd: 0.1,
    pnl_pct: 4.2,
    status: 'closed',
    is_muted: false,
    oor_since: null,
    take_profit_pct: 5,
    stop_loss_pct: -10,
    oor_timeout_min: 16,
    last_decision: 'close',
    last_decision_reason: 'take_profit',
    last_decision_at: null,
    tx_signature: null,
    created_at: new Date('2026-09-01T03:00:00.456Z'),
    updated_at: new Date('2026-09-02T07:23:45.123Z'),
    closed_at: new Date('2026-09-02T07:23:45.123Z'),
    ...overrides,
  }
}

function installDb(opts: {
  positions: Record<string, unknown>[]
  onInsert?: () => never
  exists?: boolean
}) {
  const inserts: unknown[][] = []
  const regimeDates: unknown[] = []
  vi.mocked(query).mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql)
    if (text.includes('FROM dlmm_positions')) {
      const skip = Array.isArray(params?.[1]) ? (params[1] as string[]) : []
      const rows = opts.positions.filter((row) => !skip.includes(String(row.id)))
      return { rows, rowCount: rows.length }
    }
    if (text.includes('INSERT INTO strategy_outcomes')) {
      if (opts.onInsert) opts.onInsert()
      inserts.push(params ?? [])
      return { rows: [{ id: 'out-1' }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  vi.mocked(queryOne).mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql)
    if (text.includes('market_regime_tags')) {
      regimeDates.push(params?.[0])
      return null
    }
    if (text.includes("features->>'position_id'")) {
      return opts.exists ? { id: 'out-1' } : null
    }
    return null
  })
  return { inserts, regimeDates }
}

describe('coerceIsoTimestamp', () => {
  it('turns Date#toString() GMT+0700 into UTC ISO', () => {
    const date = new Date('2026-09-02T07:23:45.123Z')
    expect(String(date)).toMatch(/GMT[+-]\d{4}/)
    expect(date.toString().slice(0, 10)).toBe('Wed Sep 02')
    expect(coerceIsoTimestamp(GMT0700_CLOSED)).toBe('2026-09-02T07:23:45.000Z')
    expect(coerceIsoTimestamp(GMT0700_CREATED)).toBe('2026-09-01T03:00:00.000Z')
    expect(coerceIsoTimestamp(date)).toBe('2026-09-02T07:23:45.123Z')
  })

  it('rejects strings that are not instants', () => {
    // Date.parse("Wed Sep 02") invents year 2001 — must not become a timestamptz.
    expect(Number.isNaN(new Date('Wed Sep 02').getTime())).toBe(false)
    expect(coerceIsoTimestamp('Wed Sep 02')).toBeNull()
    expect(coerceIsoTimestamp('not-a-date')).toBeNull()
    expect(coerceIsoTimestamp(null)).toBeNull()
  })
})

describe('loadRegimeTagForDate', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
    vi.mocked(queryOne).mockReset()
  })

  it('ignores non-YYYY-MM-DD without querying', async () => {
    vi.mocked(queryOne).mockRejectedValue(new Error('should not query'))
    await expect(loadRegimeTagForDate('Wed Sep 02')).resolves.toBeNull()
    await expect(loadRegimeTagForDate(GMT0700_CLOSED.slice(0, 10))).resolves.toBeNull()
    expect(queryOne).not.toHaveBeenCalled()
  })

  it('loads a calendar date', async () => {
    vi.mocked(queryOne).mockResolvedValue({ regime_tag: 'chop' })
    await expect(loadRegimeTagForDate('2026-09-02')).resolves.toBe('chop')
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('market_regime_tags'), [
      '2026-09-02',
    ])
  })
})

describe('DLMM outcome sync timestamps', () => {
  beforeEach(() => {
    resetDlmmOutcomeSyncSkips()
    vi.mocked(query).mockReset()
    vi.mocked(queryOne).mockReset()
    vi.mocked(fetchMeteoraPool).mockClear()
  })

  it('inserts ISO timestamps when closed_at is a pg Date', async () => {
    const { inserts, regimeDates } = installDb({ positions: [closedRow()] })
    await expect(syncMissingDlmmOutcomesFromPositions()).resolves.toBe(1)
    expect(inserts[0]?.[3]).toBe('2026-09-01T03:00:00.456Z')
    expect(inserts[0]?.[4]).toBe('2026-09-02T07:23:45.123Z')
    expect(String(inserts[0]?.[3])).not.toMatch(/GMT/i)
    expect(String(inserts[0]?.[4])).not.toMatch(/GMT/i)
    expect(regimeDates).toEqual(['2026-09-02'])
  })

  it('coerces Date#toString() closed_at before regime lookup and INSERT', async () => {
    const { inserts, regimeDates } = installDb({
      positions: [
        closedRow({
          created_at: GMT0700_CREATED,
          updated_at: GMT0700_CLOSED,
          closed_at: GMT0700_CLOSED,
        }),
      ],
    })
    await expect(syncMissingDlmmOutcomesFromPositions()).resolves.toBe(1)
    expect(inserts[0]?.[3]).toBe('2026-09-01T03:00:00.000Z')
    expect(inserts[0]?.[4]).toBe('2026-09-02T07:23:45.000Z')
    expect(regimeDates).toEqual(['2026-09-02'])
  })

  it('does not insert an unparseable exit_at', async () => {
    vi.mocked(query).mockRejectedValue(new Error('should not query'))
    vi.mocked(queryOne).mockRejectedValue(new Error('should not query'))
    await expect(
      insertStrategyOutcome({
        strategy_id: 'dlmm_default',
        domain: 'dlmm',
        token_address: 'pool',
        entry_at: GMT0700_CREATED,
        exit_at: 'Wed Sep 02',
        pnl_pct: 1,
      }),
    ).resolves.toBe(false)
    expect(query).not.toHaveBeenCalled()
    expect(queryOne).not.toHaveBeenCalled()
  })

  it('skips a row that still fails after coerce instead of retrying it', async () => {
    const db = installDb({
      positions: [
        closedRow({
          created_at: GMT0700_CREATED,
          closed_at: GMT0700_CLOSED,
        }),
      ],
      onInsert: () => {
        throw new Error('insert failed after coerce')
      },
    })
    await expect(syncMissingDlmmOutcomesFromPositions()).resolves.toBe(0)
    expect(fetchMeteoraPool).toHaveBeenCalledTimes(1)
    expect(db.inserts).toHaveLength(0)

    await expect(syncMissingDlmmOutcomesFromPositions()).resolves.toBe(0)
    expect(fetchMeteoraPool).toHaveBeenCalledTimes(1)
    const positionSql = vi
      .mocked(query)
      .mock.calls.map((call) => String(call[0]))
      .filter((sql) => sql.includes('FROM dlmm_positions'))
    expect(positionSql.length).toBeGreaterThanOrEqual(2)
    const secondSkip = vi.mocked(query).mock.calls.filter((call) =>
      String(call[0]).includes('FROM dlmm_positions'),
    )[1]?.[1] as unknown[]
    expect(secondSkip?.[1]).toEqual([POSITION_ID])
  })

  it('does not fetch the pool again for an unparseable closed_at', async () => {
    installDb({
      positions: [closedRow({ closed_at: 'not-a-date', created_at: 'also-bad' })],
    })
    await expect(syncMissingDlmmOutcomesFromPositions()).resolves.toBe(0)
    await expect(syncMissingDlmmOutcomesFromPositions()).resolves.toBe(0)
    expect(fetchMeteoraPool).not.toHaveBeenCalled()
  })
})
