import { describe, expect, it, vi, beforeEach } from 'vitest'
import { BLACK_COBRA_ALERT_EXAMPLE } from './parse-telegram-alert'

vi.mock('@/strategies/social/crosscheck-db', () => ({
  findTelegramSignalChannelByChatId: vi.fn(),
  insertSignalPriceCrosscheck: vi.fn(async (params) => ({
    id: 'test-id',
    ...params,
    jupiter_price_usd: params.jupiter_price_usd ?? null,
    pct_diff: params.pct_diff ?? null,
    strategy_id: params.strategy_id ?? null,
    sim_opened: false,
    created_at: new Date().toISOString(),
  })),
  updateCrosscheckSimOpened: vi.fn(),
}))

vi.mock('@/utils/jupiter-api', () => ({
  fetchTokenPricesBatch: vi.fn(),
}))

vi.mock('@/strategies/load-signals', () => ({
  getSignalsStrategy: vi.fn(async () => ({
    config: {
      template: 'default',
      execution: { simBuySol: 0.01, maxOpenPositions: 10 },
    },
  })),
}))

vi.mock('@/strategies/db', () => ({
  upsertStrategyDefinition: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/strategies/telegram-alpha-sim', () => ({
  openSignalsSimPosition: vi.fn(async () => {}),
}))

vi.mock('@/utils/mcap-tracker', () => ({
  trackTokenMcap: vi.fn(async () => ({})),
}))

vi.mock('@/utils/telegram', () => ({
  sendTelegramAlert: vi.fn(async () => true),
}))

import { fetchTokenPricesBatch } from '@/utils/jupiter-api'
import { runSignalCrosscheck } from './run-crosscheck'

describe('runSignalCrosscheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires manual channel_name on paste path', async () => {
    const result = await runSignalCrosscheck({
      raw_message: BLACK_COBRA_ALERT_EXAMPLE,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('channel_name')
  })

  it('passes when Jupiter within tolerance', async () => {
    vi.mocked(fetchTokenPricesBatch).mockResolvedValue({
      oVDNWQ6ZPQEPp9hcP6WheeacZncyy7ubHrwnKGDpump: {
        price: 0.000068,
        source: 'v3',
      },
    })

    const result = await runSignalCrosscheck({
      raw_message: BLACK_COBRA_ALERT_EXAMPLE,
      channel_name: 'GMGN Alpha',
      skip_sim: true,
    })

    expect(result.ok).toBe(true)
    expect(result.row?.status).toBe('passed')
    expect(result.strategyId).toBe('pumpswap_cluster_gmgn-alpha')
  })

  it('fails when Jupiter diff exceeds tolerance', async () => {
    vi.mocked(fetchTokenPricesBatch).mockResolvedValue({
      oVDNWQ6ZPQEPp9hcP6WheeacZncyy7ubHrwnKGDpump: {
        price: 0.0001,
        source: 'v3',
      },
    })

    const result = await runSignalCrosscheck({
      raw_message: BLACK_COBRA_ALERT_EXAMPLE,
      channel_name: 'GMGN Alpha',
      tolerance_pct: 3,
      skip_sim: true,
    })

    expect(result.ok).toBe(true)
    expect(result.row?.status).toBe('failed')
  })
})
