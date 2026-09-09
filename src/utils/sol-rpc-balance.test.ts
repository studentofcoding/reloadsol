import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchSolBalanceWithFailover } from '@/utils/sol-rpc-balance'

const WALLET = '3V3N5xh6vUUVU3CnbjMAXoyXendfXzXYKzTVEsFrLkgX'

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchSolBalanceWithFailover', () => {
  it('fails over from a dead endpoint to a working one', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('dead')) {
        return new Response('unauthorized', { status: 401 })
      }
      const body = JSON.parse(String(init?.body))
      if (body.method === 'getBalance') {
        return okJson({
          jsonrpc: '2.0',
          result: { value: 573_035_213 },
          id: body.id,
        })
      }
      if (body.method === 'getTokenAccountBalance') {
        return okJson({
          jsonrpc: '2.0',
          result: { value: { amount: '2500000', decimals: 6 } },
          id: body.id,
        })
      }
      throw new Error(`unexpected method ${body.method}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchSolBalanceWithFailover(WALLET, {
      endpoints: [
        'https://dead.example.com/rpc',
        'https://live.example.com/rpc',
      ],
      timeoutMs: 2_000,
    })

    expect(result.balance).toBeCloseTo(0.573035213, 9)
    expect(result.usdc).toBeCloseTo(2.5, 6)
    expect(result.endpoint).toBe('https://live.example.com/rpc')
    // USDC ATA read runs on the same endpoint that answered getBalance.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('live.example.com'),
      expect.anything(),
    )
  })

  it('rejects when every endpoint fails', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchSolBalanceWithFailover(WALLET, {
        endpoints: [
          'https://one.example.com/rpc',
          'https://two.example.com/rpc',
        ],
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/HTTP 500|failed/i)
  })

  it('treats a missing USDC account as zero without failing the balance read', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.method === 'getBalance') {
        return okJson({ jsonrpc: '2.0', result: { value: 10_000_000_000 }, id: body.id })
      }
      // Token account does not exist -> RPC error for the ATA.
      return okJson({
        jsonrpc: '2.0',
        error: { message: 'Invalid param: Token account not found' },
        id: body.id,
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchSolBalanceWithFailover(WALLET, {
      endpoints: ['https://live.example.com/rpc'],
      timeoutMs: 2_000,
    })

    expect(result.balance).toBe(10)
    expect(result.usdc).toBe(0)
  })
})
