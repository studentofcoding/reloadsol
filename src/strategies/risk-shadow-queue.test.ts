import { afterEach, describe, expect, it, vi } from 'vitest'

/** Yield the event loop so the serial drain can finish. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('risk shadow queue', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    delete process.env.RUGCHECK_ENABLED
    delete process.env.DEV_REPUTATION_ENABLED
  })

  it('dedupes a repeated token and drains each token once', async () => {
    const attachRiskShadow = vi.fn().mockResolvedValue({})
    vi.doMock('@/strategies/risk-store', () => ({ attachRiskShadow }))
    vi.doMock('@/utils/rugcheck-api', () => ({ isRugcheckEnabled: () => true }))
    vi.doMock('@/utils/dev-reputation-data', () => ({
      isDevReputationEnabled: () => false,
    }))

    const { enqueueRiskShadow } = await import('@/strategies/risk-shadow-queue')
    enqueueRiskShadow({ chain: 'sol', tokenAddress: 'MintA' })
    enqueueRiskShadow({ chain: 'sol', tokenAddress: 'MintA' })
    enqueueRiskShadow({ chain: 'sol', tokenAddress: 'MintB' })
    await flush()

    expect(attachRiskShadow).toHaveBeenCalledTimes(2)
    const tokens = attachRiskShadow.mock.calls.map((c) => c[0].tokenAddress)
    expect(tokens.sort()).toEqual(['MintA', 'MintB'])
  })

  it('is a no-op when both flags are off', async () => {
    const attachRiskShadow = vi.fn()
    vi.doMock('@/strategies/risk-store', () => ({ attachRiskShadow }))
    vi.doMock('@/utils/rugcheck-api', () => ({ isRugcheckEnabled: () => false }))
    vi.doMock('@/utils/dev-reputation-data', () => ({
      isDevReputationEnabled: () => false,
    }))

    const { enqueueRiskShadow } = await import('@/strategies/risk-shadow-queue')
    enqueueRiskShadow({ chain: 'sol', tokenAddress: 'MintA' })
    await flush()
    expect(attachRiskShadow).not.toHaveBeenCalled()
  })

  it('survives a throwing shadow writer', async () => {
    const attachRiskShadow = vi.fn().mockRejectedValue(new Error('boom'))
    vi.doMock('@/strategies/risk-store', () => ({ attachRiskShadow }))
    vi.doMock('@/utils/rugcheck-api', () => ({ isRugcheckEnabled: () => true }))
    vi.doMock('@/utils/dev-reputation-data', () => ({
      isDevReputationEnabled: () => false,
    }))

    const { enqueueRiskShadow, riskShadowQueueSize } = await import(
      '@/strategies/risk-shadow-queue'
    )
    enqueueRiskShadow({ chain: 'sol', tokenAddress: 'MintA' })
    await flush()
    expect(attachRiskShadow).toHaveBeenCalledTimes(1)
    expect(riskShadowQueueSize()).toBe(0)
  })
})
