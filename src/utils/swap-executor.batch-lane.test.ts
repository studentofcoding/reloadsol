import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendBatchViaShyftRpc } from '@/utils/swap-executor'

/**
 * The batch landing lane. Measured on a real 5-leg batch 2026-10-02:
 *   `send_many_txns` (REST)     → 417, 1 of 3 landed, confirm 61s
 *   this RPC, sends in parallel → 2 of 3 (one RateLimitExceeded)
 *   this RPC, sends serialised  → 3 of 3 CONFIRMED, confirm 163ms
 */
describe('sendBatchViaShyftRpc', () => {
  const ORIGINAL = { ...process.env }

  afterEach(() => {
    process.env = { ...ORIGINAL }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns null when the lane is not configured, so callers keep their previous behaviour', async () => {
    delete process.env.SHYFT_RPC_URL

    expect(await sendBatchViaShyftRpc(['a', 'b'])).toBeNull()
  })

  it('sends one sendTransaction per leg and returns a signature for each', async () => {
    process.env.SHYFT_RPC_URL = 'https://rpc.example'
    process.env.BATCH_SEND_MIN_INTERVAL_MS = '0'
    const bodies: { method: string; params: unknown[] }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body))
        return {
          json: async () => ({ jsonrpc: '2.0', id: bodies.length, result: `sig${bodies.length}` }),
        }
      }),
    )

    const rows = await sendBatchViaShyftRpc(['tx1', 'tx2', 'tx3'])

    expect(rows).toEqual([{ signature: 'sig1' }, { signature: 'sig2' }, { signature: 'sig3' }])
    expect(bodies.every((b) => b.method === 'sendTransaction')).toBe(true)
    expect(bodies.map((b) => b.params[0])).toEqual(['tx1', 'tx2', 'tx3'])
  })

  it('never sends in parallel — each send starts after the previous one resolved', async () => {
    process.env.SHYFT_RPC_URL = 'https://rpc.example'
    process.env.BATCH_SEND_MIN_INTERVAL_MS = '0'
    let inFlight = 0
    let maxInFlight = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { json: async () => ({ result: 'sig' }) }
      }),
    )

    await sendBatchViaShyftRpc(['tx1', 'tx2', 'tx3'])

    // three parallel sends drew RateLimitExceeded from this RPC; one at a time did not
    expect(maxInFlight).toBe(1)
  })

  it('does not abort the batch when one leg is rejected — the rest still get sent', async () => {
    process.env.SHYFT_RPC_URL = 'https://rpc.example'
    process.env.BATCH_SEND_MIN_INTERVAL_MS = '0'
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        if (call === 2) {
          return { json: async () => ({ error: { message: 'RateLimitExceeded' } }) }
        }
        return { json: async () => ({ result: `sig${call}` }) }
      }),
    )

    const rows = await sendBatchViaShyftRpc(['tx1', 'tx2', 'tx3'])

    // leg 2 is null -> the caller resolves it through the per-tx RPC fallback
    expect(rows).toEqual([{ signature: 'sig1' }, null, { signature: 'sig3' }])
    expect(call).toBe(3)
  })

  it('treats a transport throw as a per-leg miss rather than failing the batch', async () => {
    process.env.SHYFT_RPC_URL = 'https://rpc.example'
    process.env.BATCH_SEND_MIN_INTERVAL_MS = '0'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET')
      }),
    )

    expect(await sendBatchViaShyftRpc(['tx1'])).toEqual([null])
  })
})
