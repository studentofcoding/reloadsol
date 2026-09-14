import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
}))

import { query } from '@/utils/db'
import {
  BUYBULK_DATAPUBLIC_SCOUT_ID,
  RHTAPE_DATAPUBLIC_SCOUT_ID,
} from '@/utils/data-public-scout'
import {
  insertBuybulkPaperNotch,
  listBuybulkPaperNotches,
  paperNotchFromDbRow,
} from './buybulk-datapublic-scout-notches'

const candidate = {
  chain: 'robinhood' as const,
  mint: '0xABC',
  symbol: 'ABC',
  name: 'Abc',
  kind: 'vetted',
  decision: 'surfaced',
  score: 70,
}

describe('insertBuybulkPaperNotch climate gate (server)', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never)
  })

  it('refuses Not safe / Unknown before touching a durable row', async () => {
    await expect(
      insertBuybulkPaperNotch({ candidate, climateLabel: 'Not safe' }),
    ).resolves.toEqual({ ok: false, reason: 'climate_not_safe' })
    await expect(
      insertBuybulkPaperNotch({ candidate, climateLabel: 'Unknown' }),
    ).resolves.toEqual({ ok: false, reason: 'climate_not_safe' })
    const writes = vi
      .mocked(query)
      .mock.calls.filter((c) => String(c[0]).includes('INSERT'))
    expect(writes).toHaveLength(0)
  })

  it('refuses rhtape-datapublic-scout and any other strategy id', async () => {
    await expect(
      insertBuybulkPaperNotch({
        candidate,
        climateLabel: 'Safe',
        strategyId: RHTAPE_DATAPUBLIC_SCOUT_ID,
      }),
    ).resolves.toEqual({ ok: false, reason: 'wrong_strategy' })
    await expect(
      insertBuybulkPaperNotch({
        candidate,
        climateLabel: 'Safe',
        strategyId: 'someone-else',
      }),
    ).resolves.toEqual({ ok: false, reason: 'wrong_strategy' })
  })

  it('inserts a Safe paper note stamped with buybulk-datapublic-scout', async () => {
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (String(sql).includes('INSERT')) {
        return {
          rows: [
            {
              id: 'uuid-1',
              strategy_id: BUYBULK_DATAPUBLIC_SCOUT_ID,
              chain: 'robinhood',
              mint: '0xABC',
              mint_key: 'robinhood:0xabc',
              symbol: 'ABC',
              name: 'Abc',
              kind: 'vetted',
              decision: 'surfaced',
              score: 70,
              climate_label: 'Safe',
              climate_state: 'Range',
              climate_at_emit_label: 'Safe',
              features: {},
              created_at: '2026-09-14T00:00:00.000Z',
            },
          ],
          rowCount: 1,
        } as never
      }
      return { rows: [], rowCount: 0 } as never
    })

    const result = await insertBuybulkPaperNotch({
      candidate,
      climateLabel: 'Safe',
      climateState: 'Range',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    expect(result.notch.strategyId).toBe(BUYBULK_DATAPUBLIC_SCOUT_ID)
    expect(result.notch.climateLabel).toBe('Safe')
    const insertCall = vi
      .mocked(query)
      .mock.calls.find((c) => String(c[0]).includes('INSERT'))
    expect(insertCall?.[1]?.[0]).toBe(BUYBULK_DATAPUBLIC_SCOUT_ID)
    expect(JSON.stringify(insertCall)).not.toMatch(/executeBulkBuy/)
  })
})

describe('listBuybulkPaperNotches', () => {
  it('only selects buybulk-datapublic-scout rows', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await listBuybulkPaperNotches()
    const select = vi
      .mocked(query)
      .mock.calls.find((c) => String(c[0]).includes('FROM strategy_paper_notches'))
    expect(select?.[1]).toEqual([BUYBULK_DATAPUBLIC_SCOUT_ID])
  })
})

describe('paperNotchFromDbRow', () => {
  it('maps a DB row to the UI notch with strategy id stamped', () => {
    const notch = paperNotchFromDbRow({
      id: '1',
      strategy_id: BUYBULK_DATAPUBLIC_SCOUT_ID,
      chain: 'solana',
      mint: 'SoMint',
      mint_key: 'solana:somint',
      symbol: 'SOLG',
      name: 'Sol Good',
      kind: 'vetted',
      decision: 'surfaced',
      score: 60,
      climate_label: 'Safe',
      climate_state: 'Hype',
      climate_at_emit_label: 'Safe',
      features: {},
      created_at: '2026-09-14T12:00:00.000Z',
    })
    expect(notch.strategyId).toBe('buybulk-datapublic-scout')
    expect(notch.chain).toBe('solana')
    expect(notch.source).toBe(BUYBULK_DATAPUBLIC_SCOUT_ID)
  })
})
