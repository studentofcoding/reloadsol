import { describe, expect, it, vi, beforeEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async (..._args: unknown[]) => ({ rows: [] as unknown[] })),
}))

vi.mock('@/utils/db', () => ({
  query: queryMock,
  queryOne: vi.fn(async () => null),
}))

import { upsertStrategyDefinition } from './db'

// Regression: the upsert used to omit `chain`, so every Admin write landed as
// chain='sol' and the chain-scoped registry read never saw the RH twins — the
// toggle silently no-opped.

describe('upsertStrategyDefinition persists chain', () => {
  beforeEach(() => {
    queryMock.mockClear()
  })

  it('writes chain in the execution_mode branch', async () => {
    await upsertStrategyDefinition({
      id: 'att_rh',
      domain: 'trending_bot',
      chain: 'robinhood',
      name: 'Attention Strategy (Robinhood)',
      config: {},
      is_active: true,
      execution_mode: 'sim_only',
    })

    const call = queryMock.mock.calls[0]
    expect(String(call[0])).toContain('chain')
    expect(call[1] as unknown[]).toContain('robinhood')
  })

  it('writes chain in the branch without execution_mode', async () => {
    await upsertStrategyDefinition({
      id: 'signals_default_rh',
      domain: 'signals',
      chain: 'robinhood',
      name: 'Default momentum (Robinhood)',
      config: {},
      is_active: true,
    })

    const call = queryMock.mock.calls[0]
    expect(String(call[0])).toContain('chain')
    expect(call[1] as unknown[]).toContain('robinhood')
  })

  it('defaults to sol when the chain is omitted', async () => {
    await upsertStrategyDefinition({
      id: 'att',
      domain: 'trending_bot',
      name: 'Attention Strategy',
      config: {},
      is_active: true,
    })

    const call = queryMock.mock.calls[0]
    expect(call[1] as unknown[]).toContain('sol')
  })
})
