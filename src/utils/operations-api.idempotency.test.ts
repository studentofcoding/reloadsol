import { describe, expect, it, vi, afterEach } from 'vitest'
import { trackOperation } from '@/utils/operations-api'

afterEach(() => vi.unstubAllGlobals())

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
})

/**
 * The retry in `trackOperation` is only safe because the idempotency key is generated ONCE per logical
 * operation, outside the retry. If each attempt minted a new key, the server would treat every retry as a
 * new operation and the counter would inflate — the exact failure this work exists to prevent, and one
 * that is invisible afterwards because `token_operations` is an aggregate with no per-operation row.
 */
describe('trackOperation — idempotency key survives the retry', () => {
  it('sends the SAME key on a retried attempt, so a retry cannot double-count', async () => {
    const seen: string[] = []
    let call = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        call += 1
        seen.push(JSON.parse(init.body).operationKey)
        if (call === 1) throw new Error('ChunkLoadError: Failed to load chunk /_next/static/chunks/x.js')
        return ok({ success: true, pointsEarned: 10, applied: true, duplicate: false })
      }),
    )

    const result = await trackOperation('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX', 'sell', 2)

    expect(call).toBe(2)                       // it did retry
    expect(seen[0]).toBeTruthy()               // a key was sent
    expect(seen[0]).toBe(seen[1])              // and it was the SAME one
    expect(result.pointsEarned).toBe(10)
  })

  it('does not retry a real server error — a 500 is an answer, not a transport fault', async () => {
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      }),
    )

    await expect(
      trackOperation('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX', 'sell', 1),
    ).rejects.toThrow(/boom/)
    expect(call).toBe(1)
  })

  it('mints a fresh key for a separate operation', async () => {
    const keys: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        keys.push(JSON.parse(init.body).operationKey)
        return ok({ success: true, pointsEarned: 10, applied: true, duplicate: false })
      }),
    )

    await trackOperation('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX', 'sell', 1)
    await trackOperation('3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX', 'sell', 1)

    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })
})
