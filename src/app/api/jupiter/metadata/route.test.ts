import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

const mocks = vi.hoisted(() => ({
  fetchOne: vi.fn(),
  lookup: vi.fn(),
}))
vi.mock('@/utils/jupiter-metadata', async () => {
  const real = await vi.importActual<typeof import('@/utils/jupiter-metadata')>('@/utils/jupiter-metadata')
  return {
    ...real,
    fetchTokenMetadataFromJupiter: (...a: unknown[]) => mocks.fetchOne(...a),
    lookupJupiterMetadata: (...a: unknown[]) => mocks.lookup(...a),
  }
})

import { NextRequest } from 'next/server'
import { JupiterUnavailableError } from '@/utils/jupiter-metadata'
import { GET, POST } from './route'

const MINT_A = 'AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA'.slice(0, 43)
const MINT_B = 'BbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB'
const MINT_C = 'CcccccccccccccccccccccccccccccccccccccccccC'
// the route keeps a process-level cache, so each test uses mints no earlier test touched
const P_A = 'DdddddddddddddddddddddddddddddddddddddddddD'
const P_B = 'EeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeE'
const P_C = 'FfffffffffffffffffffffffffffffffffffffffffF'
const P_D = 'GgggggggggggggggggggggggggggggggggggggggggG'

const get = (mint: string) => new NextRequest(`http://localhost/api/jupiter/metadata?mint=${mint}`)
const post = (mints: string[]) =>
  new NextRequest('http://localhost/api/jupiter/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mints }),
  })

beforeEach(() => {
  mocks.fetchOne.mockReset()
  mocks.lookup.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GET /api/jupiter/metadata', () => {
  it('returns real data from Jupiter', async () => {
    mocks.fetchOne.mockResolvedValue({ decimals: 9, symbol: 'REAL', name: 'Real' })
    const res = await GET(get(MINT_A))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.source).toBe('jupiter_api_v2')
    expect(json.data.symbol).toBe('REAL')
  })

  it('Jupiter unavailable -> 503 with NO fabricated decimals-6 / "TOKEN" payload', async () => {
    mocks.fetchOne.mockRejectedValue(new JupiterUnavailableError('rate_limited', 'Rate limited', 8000))
    const res = await GET(get(MINT_B))
    const json = await res.json()
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('8')
    expect(json.unavailable).toBe(true)
    expect(json.data).toBeUndefined()
  })

  it('Jupiter says "no such token" -> the legacy placeholder, flagged source "default" (and not cached)', async () => {
    mocks.fetchOne.mockRejectedValue(new Error('Token not found: x'))
    const json = await (await GET(get(MINT_C))).json()
    expect(json.source).toBe('default')
    expect(json.data.symbol).toBe('TOKEN')
    mocks.fetchOne.mockResolvedValue({ decimals: 6, symbol: 'NOWREAL', name: 'n' })
    const again = await (await GET(get(MINT_C))).json()
    expect(again.data.symbol).toBe('NOWREAL')
  })
})

describe('POST /api/jupiter/metadata', () => {
  it('splits found / not found / unavailable and never invents data for an unavailable mint', async () => {
    mocks.lookup.mockResolvedValue({
      found: { [P_A]: { decimals: 9, symbol: 'AAA', name: 'a' } },
      notFound: [P_B],
      unavailable: [{ mint: P_C, error: new JupiterUnavailableError('rate_limited', 'cooling down') }],
    })
    const json = await (await POST(post([P_A, P_B, P_C]))).json()
    expect(json.results[P_A].data.symbol).toBe('AAA')
    expect(json.results[P_B].source).toBe('default')
    expect(json.results[P_C].unavailable).toBe(true)
    expect(json.results[P_C].data).toBeUndefined()
    expect(mocks.lookup).toHaveBeenCalledTimes(1) // one call for the whole batch, no local batching loop
  })

  it('a thrown lookup marks every mint unavailable (no defaults)', async () => {
    mocks.lookup.mockRejectedValue(new Error('boom'))
    const json = await (await POST(post([P_D]))).json()
    expect(json.results[P_D].unavailable).toBe(true)
    expect(json.results[P_D].data).toBeUndefined()
  })
})
