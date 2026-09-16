import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBrainMcapUniverse,
  evaluateMcapBrainOpen,
  filterMcapByUnionMembership,
  mcapItemMint,
} from '@/strategies/mcap-track/brain-universe'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function row(address: string, mcap = 80_000) {
  return { token_address: address, current_mcap: mcap, first_mcap: mcap }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function brainFetch(opts: {
  union?: unknown
  recipes?: unknown
  unionStatus?: number
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input)
    if (href.includes('/recipes')) {
      return jsonResponse(opts.recipes ?? { recipes: [] })
    }
    if (opts.unionStatus && opts.unionStatus !== 200) {
      return jsonResponse({ error: 'unauthorized' }, opts.unionStatus)
    }
    return jsonResponse(
      opts.union ?? {
        tokens: [
          { mint: 'MintB', marketCap: 80_000, liquidity: 20_000 },
        ],
      },
    )
  })
}

describe('filterMcapByUnionMembership', () => {
  it('keeps only rows whose mint is on the union list', () => {
    const items = [row('MintA'), row('MintB'), row('MintC')]
    expect(filterMcapByUnionMembership(items, ['MintB', 'MintC']).map(mcapItemMint)).toEqual([
      'MintB',
      'MintC',
    ])
  })

  it('returns empty when the universe is empty (membership fail closed)', () => {
    expect(filterMcapByUnionMembership([row('MintA')], [])).toEqual([])
  })
})

describe('applyBrainMcapUniverse', () => {
  it('leaves tracker rows unchanged when the mcap flag is off', async () => {
    vi.stubEnv('MARKET_BRAIN_MCAP', '')
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const items = [row('MintA')]
    const result = await applyBrainMcapUniverse(items)
    expect(result.applied).toBe(false)
    expect(result.source).toBe('local')
    expect(result.items).toBe(items)
  })

  it('keeps tracker rows when the flag is on but the token is missing', async () => {
    vi.stubEnv('MARKET_BRAIN_MCAP', '1')
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    const items = [row('MintA')]
    const result = await applyBrainMcapUniverse(items)
    expect(result.applied).toBe(false)
    expect(result.error).toMatch(/MARKET_BRAIN_TOKEN is not set/)
    expect(result.items).toEqual(items)
  })

  it('intersects tracker rows with /union when configured', async () => {
    vi.stubEnv('MARKET_BRAIN_MCAP', '1')
    const fetchImpl = brainFetch({
      union: { tokens: [{ mint: 'MintB' }, { mint: 'MintD' }] },
    })
    const result = await applyBrainMcapUniverse(
      [row('MintA'), row('MintB'), row('MintC')],
      { token: 't', fetchImpl },
    )
    expect(result.applied).toBe(true)
    expect(result.source).toBe('union')
    expect(result.kept).toBe(1)
    expect(result.unionSize).toBe(2)
    expect(result.items.map(mcapItemMint)).toEqual(['MintB'])
  })

  it('fails soft back to tracker rows when /union errors', async () => {
    vi.stubEnv('MARKET_BRAIN_MCAP', '1')
    const token = 'super-secret-brain-token'
    const fetchImpl = brainFetch({ unionStatus: 401 })
    const items = [row('MintA')]
    const result = await applyBrainMcapUniverse(items, { token, fetchImpl })
    expect(result.applied).toBe(false)
    expect(result.source).toBe('local')
    expect(result.items).toEqual(items)
    expect(result.error).toMatch(/unauthorized/)
    expect(result.error).not.toContain(token)
  })
})

describe('evaluateMcapBrainOpen', () => {
  it('applies default AND gates using brain list facts (no bmScore)', async () => {
    vi.stubEnv('MARKET_BRAIN_MCAP', '1')
    const fetchImpl = brainFetch({
      union: {
        tokens: [
          { mint: 'MintB', marketCap: 80_000, liquidity: 20_000, score100: 10 },
          { mint: 'MintLow', marketCap: 1_000, liquidity: 20_000 },
          { mint: 'MintDry', marketCap: 80_000 },
        ],
      },
    })
    const result = await applyBrainMcapUniverse(
      [row('MintB'), row('MintLow'), row('MintDry')],
      { token: 't', fetchImpl },
    )
    const climate = { label: 'Safe' as const }
    const pass = evaluateMcapBrainOpen(row('MintB'), result, { climate })
    expect(pass.pass).toBe(true)
    expect(pass.gates.find((g) => g.id === 'bmScore')?.enabled).toBe(false)

    const low = evaluateMcapBrainOpen(row('MintLow', 1_000), result, { climate })
    expect(low.pass).toBe(false)
    expect(low.rejectedBy).toContain('mcap')

    const dry = evaluateMcapBrainOpen(row('MintDry'), result, { climate })
    expect(dry.pass).toBe(false)
    expect(dry.rejectedBy).toContain('liquidity')

    const unsafe = evaluateMcapBrainOpen(row('MintB'), result, {
      climate: { label: 'Not safe' },
    })
    expect(unsafe.rejectedBy).toContain('climateSafe')
  })
})
