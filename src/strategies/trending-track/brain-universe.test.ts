import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBrainTrendingUniverse,
  filterPoolsByUnionMembership,
  poolMint,
} from '@/strategies/trending-track/brain-universe'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function pool(id: string) {
  return { baseAsset: { id } }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('filterPoolsByUnionMembership', () => {
  it('keeps only pools whose mint is on the union list', () => {
    const pools = [pool('MintA'), pool('MintB'), pool('MintC')]
    expect(filterPoolsByUnionMembership(pools, ['MintB', 'MintC']).map(poolMint)).toEqual([
      'MintB',
      'MintC',
    ])
  })

  it('returns empty when the universe is empty (membership fail closed)', () => {
    expect(filterPoolsByUnionMembership([pool('MintA')], [])).toEqual([])
  })
})

describe('applyBrainTrendingUniverse', () => {
  it('leaves Jupiter pools unchanged when the trending flag is off', async () => {
    vi.stubEnv('MARKET_BRAIN_TRENDING', '')
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const pools = [pool('MintA')]
    const result = await applyBrainTrendingUniverse(pools)
    expect(result.applied).toBe(false)
    expect(result.source).toBe('jupiter')
    expect(result.pools).toBe(pools)
  })

  it('keeps Jupiter pools when the flag is on but the token is missing', async () => {
    vi.stubEnv('MARKET_BRAIN_TRENDING', '1')
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    const pools = [pool('MintA')]
    const result = await applyBrainTrendingUniverse(pools)
    expect(result.applied).toBe(false)
    expect(result.error).toMatch(/MARKET_BRAIN_TOKEN is not set/)
    expect(result.pools).toEqual(pools)
  })

  it('intersects Jupiter pools with /union when configured', async () => {
    vi.stubEnv('MARKET_BRAIN_TRENDING', '1')
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tokens: [{ mint: 'MintB' }, { mint: 'MintD' }] }),
    )
    const result = await applyBrainTrendingUniverse(
      [pool('MintA'), pool('MintB'), pool('MintC')],
      { token: 't', fetchImpl },
    )
    expect(result.applied).toBe(true)
    expect(result.source).toBe('union')
    expect(result.kept).toBe(1)
    expect(result.unionSize).toBe(2)
    expect(result.pools.map(poolMint)).toEqual(['MintB'])
  })

  it('fails soft back to Jupiter pools when /union errors', async () => {
    vi.stubEnv('MARKET_BRAIN_TRENDING', '1')
    const token = 'super-secret-brain-token'
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    const pools = [pool('MintA')]
    const result = await applyBrainTrendingUniverse(pools, { token, fetchImpl })
    expect(result.applied).toBe(false)
    expect(result.source).toBe('jupiter')
    expect(result.pools).toEqual(pools)
    expect(result.error).toMatch(/unauthorized/)
    expect(result.error).not.toContain(token)
  })
})
