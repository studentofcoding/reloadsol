import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOpenPositionPrices = vi.fn()

function posRow(i: number) {
  return {
    id: `p${i}`,
    wallet_address: 'gmgn-sim',
    token_address: `Mint${i}`.padEnd(40, 'A'),
    token_symbol: `T${i}`,
    position_size: 0.02,
    entry_price: 1,
    current_price: 1,
    stop_loss_price: 0.7,
    take_profit_price: 3,
    stop_loss_percentage: -30,
    take_profit_percentage: 200,
    position_type: 'bot',
    strategy_id: 'gmgn_sm_kol_combined',
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    is_active: true,
    is_simulation: true,
    chain: 'sol',
    reference_kind: 'price',
    reference_value: 1,
    exit_basis: 'price',
  }
}
const POSITIONS = Array.from({ length: 6 }, (_, i) => posRow(i))

vi.mock('@/utils/db', () => ({
  query: vi.fn(async (sql: string) => {
    if (String(sql).includes('SELECT * FROM sl_tp_positions WHERE is_active = true')) {
      return { rows: POSITIONS, rowCount: POSITIONS.length }
    }
    return { rows: [], rowCount: 0 }
  }),
  queryOne: vi.fn(async () => null),
}))
vi.mock('@/utils/shyft-wallet-cache', () => ({
  fetchShyftAllTokensCached: vi.fn(async () => ({ tokens: [] })),
}))
vi.mock('@/utils/shyft-wallet', () => ({ mapShyftTokensToUserTokens: vi.fn(() => []) }))
vi.mock('@/utils/open-position-prices', () => ({
  getOpenPositionPrices: (...args: unknown[]) => getOpenPositionPrices(...args),
}))

const { runSLTPMonitorAndSummarize } = await import('@/utils/sl-tp-tracker')
const { SltpPassUnhealthyError } = await import('@/utils/sl-tp-pass-health')

describe('SL/TP pass fails loudly on a price outage (was: swallowed → 200 → success)', () => {
  beforeEach(() => {
    getOpenPositionPrices.mockReset()
  })

  it('rejects when the price fetch throws', async () => {
    getOpenPositionPrices.mockRejectedValue(new Error('jupiter down'))
    await expect(runSLTPMonitorAndSummarize()).rejects.toBeInstanceOf(SltpPassUnhealthyError)
    await expect(runSLTPMonitorAndSummarize()).rejects.toThrow(/price fetch failed for chain\(s\) sol/)
  })

  it('rejects when the stale ratio is high (fetch "succeeds" but prices nothing)', async () => {
    getOpenPositionPrices.mockResolvedValue({})
    await expect(runSLTPMonitorAndSummarize()).rejects.toThrow(/6\/6 positions unpriced/)
  })

  it('does not reject when the book is priced', async () => {
    const prices = Object.fromEntries(POSITIONS.map((p) => [p.token_address, 1]))
    getOpenPositionPrices.mockResolvedValue(prices)
    await expect(runSLTPMonitorAndSummarize()).resolves.toBeDefined()
  })
})
