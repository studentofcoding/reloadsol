import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  rows: vi.fn(async () => [] as unknown[]),
}))

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, connection: async () => undefined }
})
vi.mock('@/utils/dlmm/config', () => ({ defaultAgentConfig: () => ({}) }))
vi.mock('@/utils/dlmm/db', () => ({ getAgentConfig: async () => ({}) }))
vi.mock('@/strategies/db', () => ({ loadStrategyDefinitionRows: m.rows }))
vi.mock('@/strategies/canonical-params', () => ({ mapRegistryToCanonical: () => ({}) }))
vi.mock('@/strategies/registry', () => ({
  TRENDING_BOT_STRATEGIES: { att: { stop_loss_percentage: -20, max_hold_hours: 24 } },
  SIGNALS_STRATEGIES: {},
  MCAP_TRACKER_STRATEGIES: {},
  GMGN_STRATEGIES: {},
  SOCIAL_STRATEGIES: {},
  DLMM_STRATEGY_DEFAULTS: { id: 'dlmm_default', config: { min_tvl: 50000, min_holders: 100 } },
}))
vi.mock('@/strategies/load-strategy', () => ({
  // Effective = stored over defaults. The stored value equals the default, so only key presence can
  // tell it apart from an untouched field.
  getMergedTrendingBotRegistry: async () => ({
    att: { stop_loss_percentage: -20, max_hold_hours: 24 },
  }),
  getActiveStrategiesWithState: async () => ({ strategies: [], allocation: {} }),
  getStrategyStatusSummary: async () => ({}),
}))
vi.mock('@/strategies/load-signals', () => ({ getMergedSignalsRegistry: async () => ({}) }))
vi.mock('@/strategies/load-mcap-tracker', () => ({ getMergedMcapTrackerRegistry: async () => ({}) }))
vi.mock('@/strategies/load-gmgn', () => ({ getMergedGmgnRegistry: async () => ({}) }))
vi.mock('@/strategies/load-social', () => ({ getMergedSocialRegistry: async () => ({}) }))
vi.mock('@/strategies/load-dlmm', () => ({
  getMergedDlmmStrategy: async () => ({
    id: 'dlmm_default',
    config: { min_tvl: 50000, min_holders: 100 },
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from './route'

async function sources() {
  const res = await GET(new NextRequest('http://localhost/api/strategies?chain=sol'))
  const body = await res.json()
  expect(body.success).toBe(true)
  return body.sources as Record<string, Record<string, string>>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/strategies — sources', () => {
  it('tags a stored value equal to the default as stored, and an untouched one as defaults', async () => {
    m.rows.mockResolvedValue([
      {
        id: 'att',
        domain: 'trending_bot',
        chain: 'sol',
        name: '',
        config: { stop_loss_percentage: -20 },
        is_active: true,
      },
    ])
    const s = await sources()
    expect(s.trending_bot['att.stop_loss_percentage']).toBe('stored')
    expect(s.trending_bot['att.max_hold_hours']).toBe('defaults')
  })

  it('reports all defaults when no row is stored', async () => {
    m.rows.mockResolvedValue([])
    const s = await sources()
    expect(s.trending_bot).toEqual({
      'att.stop_loss_percentage': 'defaults',
      'att.max_hold_hours': 'defaults',
    })
  })

  it('reads the DLMM thresholds from the nested config of its row', async () => {
    m.rows.mockResolvedValue([
      { id: 'dlmm_default', domain: 'dlmm', config: { min_tvl: 50000 }, is_active: true },
    ])
    const s = await sources()
    expect(s.dlmm['config.min_tvl']).toBe('stored')
    expect(s.dlmm['config.min_holders']).toBe('defaults')
  })

  it('ignores a stored row from another chain', async () => {
    m.rows.mockResolvedValue([
      {
        id: 'att',
        domain: 'trending_bot',
        chain: 'robinhood',
        config: { stop_loss_percentage: -20 },
        is_active: true,
      },
    ])
    const s = await sources()
    expect(s.trending_bot['att.stop_loss_percentage']).toBe('defaults')
  })
})
