import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./db', async () => {
  const { TRENDING_BOT_STRATEGIES } = await import('./registry')
  return {
    loadStrategyDefinitionRows: vi.fn(async () =>
      Object.keys(TRENDING_BOT_STRATEGIES).map((id) => ({
        id,
        domain: 'trending_bot',
        name: id,
        description: null,
        config: {},
        is_active: false,
        execution_mode: 'sim_only',
        version: 1,
        updated_at: new Date().toISOString(),
      })),
    ),
  }
})

describe('getActiveStrategiesWithState empty active', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not force att when no strategies are active', async () => {
    const { getActiveStrategiesWithState, invalidateStrategyCache } =
      await import('./load-strategy')
    invalidateStrategyCache()
    const state = await getActiveStrategiesWithState()
    expect(state.strategies).toEqual([])
    expect(state.strategies).not.toContain('att')
  })
})
