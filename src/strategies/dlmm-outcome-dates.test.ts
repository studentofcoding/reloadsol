import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('@/utils/dlmm/db', () => ({
  getAgentConfig: vi.fn(async () => ({ dry_run: true })),
}))

vi.mock('@/utils/meteora', () => ({
  fetchMeteoraPool: vi.fn(async () => ({
    token_x: { address: 'Mint111', symbol: 'TOK' },
    token_y: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
  })),
}))

vi.mock('./strategy-telegram-notify', () => ({
  notifyStrategyClose: vi.fn(),
}))

import { query, queryOne } from '@/utils/db'
import { fetchMeteoraPool } from '@/utils/meteora'
import { insertStrategyOutcome, loadRegimeTagForDate } from './db'
import {
  clearDlmmOutcomeBackfillSkips,
  syncMissingDlmmOutcomesFromPositions,
} from './outcomes'

const CLOSED_AT = 'Wed Sep 02 2026 14:23:45 GMT+0700 (Indochina Time)'
const CREATED_AT = 'Wed Sep 02 2026 10:00:00 GMT+0700 (Indochina Time)'
const EXIT_ISO = '2026-09-02T07:23:45.000Z'
const ENTRY_ISO = '2026-09-02T03:00:00.000Z'

function closedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pos-1',
    pool_address: 'pool',
    pool_name: 'TOK-SOL',
    position_pubkey: null,
    token_x_symbol: 'TOK',
    token_y_symbol: 'SOL',
    amount_sol: 1,
    min_bin_id: 1,
    max_bin_id: 2,
    entry_value_usd: 10,
    current_value_usd: 12,
    fees_earned_usd: 0,
    pnl_pct: 12,
    status: 'closed',
    is_muted: false,
    oor_since: null,
    take_profit_pct: 10,
    stop_loss_pct: 5,
    oor_timeout_min: 30,
    last_decision: 'close',
    last_decision_reason: 'tp',
    last_decision_at: null,
    tx_signature: null,
    created_at: CREATED_AT,
    updated_at: CLOSED_AT,
    closed_at: CLOSED_AT,
    ...over,
  }
}

function insertCalls(): unknown[][] {
  return vi
    .mocked(query)
    .mock.calls.filter((call) => String(call[0]).includes('INSERT INTO strategy_outcomes'))
    .map((call) => (call[1] as unknown[]) ?? [])
}

beforeEach(() => {
  clearDlmmOutcomeBackfillSkips()
  vi.mocked(query).mockReset()
  vi.mocked(queryOne).mockReset()
  vi.mocked(fetchMeteoraPool).mockClear()
  vi.mocked(query).mockImplementation(async (sql: string) => {
    if (String(sql).includes('INSERT INTO strategy_outcomes')) {
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  vi.mocked(queryOne).mockResolvedValue(null)
})

describe('loadRegimeTagForDate', () => {
  it('ignores a non-YYYY-MM-DD day without querying', async () => {
    await expect(loadRegimeTagForDate('Wed Sep 02')).resolves.toBeNull()
    expect(queryOne).not.toHaveBeenCalled()
  })

  it('loads a calendar day', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ regime_tag: 'chop' })
    await expect(loadRegimeTagForDate('2026-09-02')).resolves.toBe('chop')
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('market_regime_tags'),
      ['2026-09-02'],
    )
  })
})

describe('insertStrategyOutcome', () => {
  it('stores ISO timestamps and looks up the regime by YYYY-MM-DD', async () => {
    const wrote = await insertStrategyOutcome({
      strategy_id: 'dlmm_default',
      domain: 'dlmm',
      token_address: 'Mint111',
      entry_at: CREATED_AT,
      exit_at: CLOSED_AT,
      pnl_pct: 12,
      status: 'won',
      is_simulated: true,
      features: { position_id: 'pos-1' },
    })

    expect(wrote).toBe(true)
    const params = insertCalls()[0]
    expect(params?.[3]).toBe(ENTRY_ISO)
    expect(params?.[4]).toBe(EXIT_ISO)
    expect(JSON.parse(String(params?.[8])).position_id).toBe('pos-1')
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('market_regime_tags'),
      ['2026-09-02'],
    )
  })

  it('does not insert or query the regime for an unparseable exit', async () => {
    const wrote = await insertStrategyOutcome({
      strategy_id: 'dlmm_default',
      domain: 'dlmm',
      token_address: 'Mint111',
      entry_at: ENTRY_ISO,
      exit_at: 'Wed Sep 02',
      features: { position_id: 'pos-1' },
    })
    expect(wrote).toBe(false)
    expect(insertCalls()).toHaveLength(0)
    expect(queryOne).not.toHaveBeenCalled()
  })
})

describe('syncMissingDlmmOutcomesFromPositions', () => {
  it('backfills a Date#toString() closed_at as ISO and does not insert twice', async () => {
    let exists = false
    vi.mocked(query).mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM dlmm_positions')) {
        return { rows: [closedRow()], rowCount: 1 }
      }
      if (text.includes('INSERT INTO strategy_outcomes')) {
        exists = true
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    vi.mocked(queryOne).mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('position_id')) {
        return exists ? { id: 'outcome-1' } : null
      }
      return null
    })

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(1)
    expect(insertCalls()[0]?.[3]).toBe(ENTRY_ISO)
    expect(insertCalls()[0]?.[4]).toBe(EXIT_ISO)
    expect(JSON.parse(String(insertCalls()[0]?.[8])).position_id).toBe('pos-1')

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(0)
    expect(insertCalls()).toHaveLength(1)
    expect(fetchMeteoraPool).toHaveBeenCalledTimes(1)
  })

  it('coerces a pg Date closed_at instead of Date#toString()', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM dlmm_positions')) {
        return {
          rows: [
            closedRow({
              id: 'pos-date',
              created_at: new Date(ENTRY_ISO),
              closed_at: new Date(EXIT_ISO),
            }),
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(1)
    expect(insertCalls()[0]?.[3]).toBe(ENTRY_ISO)
    expect(insertCalls()[0]?.[4]).toBe(EXIT_ISO)
  })

  it('does not retry a row after the coerced insert still fails', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      const text = String(sql)
      if (text.includes('FROM dlmm_positions')) {
        return { rows: [closedRow({ id: 'pos-fail' })], rowCount: 1 }
      }
      if (text.includes('INSERT INTO strategy_outcomes')) {
        throw new Error('time zone "gmt+0700" not recognized')
      }
      return { rows: [], rowCount: 0 }
    })

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(0)
    expect(insertCalls()).toHaveLength(1)
    expect(fetchMeteoraPool).toHaveBeenCalledTimes(1)

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(0)
    expect(insertCalls()).toHaveLength(1)
    expect(fetchMeteoraPool).toHaveBeenCalledTimes(1)
  })

  it('does not retry a closed_at that cannot be coerced', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM dlmm_positions')) {
        return {
          rows: [closedRow({ id: 'pos-bad', closed_at: 'not-a-timestamp' })],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(0)
    expect(insertCalls()).toHaveLength(0)
    expect(fetchMeteoraPool).not.toHaveBeenCalled()

    expect(await syncMissingDlmmOutcomesFromPositions()).toBe(0)
    expect(fetchMeteoraPool).not.toHaveBeenCalled()
  })
})
