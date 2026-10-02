import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  METADATA_BATCH_CHUNK,
  fetchTokenMetadataBatch,
} from './token-metadata-client'

const okResponse = (mints: string[]) =>
  new Response(
    JSON.stringify({
      results: Object.fromEntries(
        mints.map((m) => [m, { data: { symbol: `S${m}`, name: `N${m}` } }]),
      ),
    }),
    { status: 200 },
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchTokenMetadataBatch', () => {
  it('splits a long mint list into bounded POSTs and merges the results', async () => {
    const total = METADATA_BATCH_CHUNK * 2 + 5
    const mints = Array.from({ length: total }, (_, i) => `m${i}`)
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(JSON.parse(String(init.body)).mints),
    )
    vi.stubGlobal('fetch', fetchMock)

    const map = await fetchTokenMetadataBatch([...mints, 'm0'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init.body)).mints.length).toBeLessThanOrEqual(
        METADATA_BATCH_CHUNK,
      )
    }
    expect(map.size).toBe(total)
    expect(map.get('m7')?.symbol).toBe('Sm7')
  })

  it('throws on a non-OK response instead of returning an empty map', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(fetchTokenMetadataBatch(['a'])).rejects.toThrow(/503/)
  })

  it('throws when the network call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down')
      }),
    )
    await expect(fetchTokenMetadataBatch(['a'])).rejects.toThrow('network down')
  })

  it('returns an empty map without calling fetch for no mints', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await fetchTokenMetadataBatch([])).size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
