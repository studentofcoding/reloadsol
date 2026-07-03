import { describe, expect, it } from 'vitest'
import { waitForRpcRateLimit } from './rpc-rate-limit'

describe('waitForRpcRateLimit', () => {
  it('spaces calls to respect RPC_MAX_REQ_PER_SEC', async () => {
    const prev = process.env.RPC_MAX_REQ_PER_SEC
    process.env.RPC_MAX_REQ_PER_SEC = '5'

    const start = Date.now()
    await waitForRpcRateLimit()
    await waitForRpcRateLimit()
    await waitForRpcRateLimit()
    const elapsed = Date.now() - start

    process.env.RPC_MAX_REQ_PER_SEC = prev

    // 3 calls at 5/s → ~400ms minimum between first and third
    expect(elapsed).toBeGreaterThanOrEqual(350)
  })
})
