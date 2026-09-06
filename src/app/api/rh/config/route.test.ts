import { afterEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/rh/config/route'

const EXECUTOR = '0x61F1eb4cF3a7962d54413769369675be6BEa3907'

afterEach(() => {
  delete process.env.NEXT_PUBLIC_RH_BATCH_EXECUTOR_ADDRESS
  delete process.env.RH_BATCH_EXECUTOR_ADDRESS
})

describe('GET /api/rh/config', () => {
  it('returns the public executor address without caching', async () => {
    process.env.RH_BATCH_EXECUTOR_ADDRESS = EXECUTOR
    const response = await GET()

    expect(await response.json()).toEqual({
      batchExecutorAddress: EXECUTOR,
    })
    expect(response.headers.get('cache-control')).toBe(
      'no-store, max-age=0, must-revalidate',
    )
  })

  it('returns null when the executor is not configured', async () => {
    const response = await GET()
    expect(await response.json()).toEqual({ batchExecutorAddress: null })
  })
})
