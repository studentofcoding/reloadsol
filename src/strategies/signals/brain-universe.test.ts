import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyBrainSignalsUniverse,
  evaluateSignalsBrainOpen,
  filterSignalsByUnionMembership,
  signalsItemMint,
} from '@/strategies/signals/brain-universe'

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
  lists?: Record<string, unknown>
  unionStatus?: number
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = String(input)
    if (href.includes('/recipes')) {
      return jsonResponse(opts.recipes ?? { recipes: [] })
    }
    for (const [name, body] of Object.entries(opts.lists ?? {})) {
      if (href.endsWith(`/${name}`)) return jsonResponse(body)
    }
    if (opts.unionStatus && opts.unionStatus !== 200) {
      return jsonResponse({ error: 'unauthorized' }, opts.unionStatus)
    }
    return jsonResponse(opts.union ?? { tokens: [{ mint: 'MintB' }] })
  })
}

describe('filterSignalsByUnionMembership', () => {
  it('keeps only signals whose mint is on the union list', () => {
    const items = [row('MintA'), row('MintB'), row('MintC')]
    expect(
      filterSignalsByUnionMembership(items, ['MintB', 'MintC']).map(signalsItemMint),
    ).toEqual(['MintB', 'MintC'])
  })

  it('returns empty when the universe is empty (membership fail closed)', () => {
    expect(filterSignalsByUnionMembership([row('MintA')], [])).toEqual([])
  })
})

describe('applyBrainSignalsUniverse', () => {
  it('leaves scored rows unchanged when the signals flag is off', async () => {
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '')
    vi.stubEnv('MARKET_BRAIN_TOKEN', 't')
    const items = [row('MintA')]
    const result = await applyBrainSignalsUniverse(items)
    expect(result.applied).toBe(false)
    expect(result.source).toBe('local')
    expect(result.items).toBe(items)
  })

  it('keeps scored rows when the flag is on but the token is missing', async () => {
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '1')
    vi.stubEnv('MARKET_BRAIN_TOKEN', '')
    const items = [row('MintA')]
    const result = await applyBrainSignalsUniverse(items)
    expect(result.applied).toBe(false)
    expect(result.error).toMatch(/MARKET_BRAIN_TOKEN is not set/)
    expect(result.items).toEqual(items)
  })

  it('intersects scored rows with /union when configured', async () => {
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '1')
    const fetchImpl = brainFetch({
      union: { tokens: [{ mint: 'MintB' }, { mint: 'MintD' }] },
    })
    const result = await applyBrainSignalsUniverse(
      [row('MintA'), row('MintB'), row('MintC')],
      { token: 't', fetchImpl },
    )
    expect(result.applied).toBe(true)
    expect(result.source).toBe('union')
    expect(result.kept).toBe(1)
    expect(result.unionSize).toBe(2)
    expect(result.items.map(signalsItemMint)).toEqual(['MintB'])
  })

  it('uses a signals-domain recipe universe when it is not union-only', async () => {
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '1')
    const fetchImpl = brainFetch({
      union: { tokens: [{ mint: 'MintUnion' }] },
      recipes: {
        recipes: [
          {
            id: 'signals_sell_over_100',
            active: true,
            domain: 'signals',
            universe: ['bubble'],
            gates: [{ kind: 'membership' }, { kind: 'mcap', n: 50_000 }],
            profileId: 'default',
          },
        ],
      },
      lists: {
        bubble: {
          tokens: [{ mint: 'MintBubble', marketCap: 90_000, liquidity: 12_000 }],
        },
      },
    })
    const result = await applyBrainSignalsUniverse([row('MintUnion'), row('MintBubble')], {
      token: 't',
      fetchImpl,
      recipeId: 'signals_sell_over_100',
    })
    expect(result.applied).toBe(true)
    expect(result.source).toBe('recipe')
    expect(result.items.map(signalsItemMint)).toEqual(['MintBubble'])
  })

  it('fails soft back to scored rows when /union errors', async () => {
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '1')
    const token = 'super-secret-brain-token'
    const fetchImpl = brainFetch({ unionStatus: 401 })
    const items = [row('MintA')]
    const result = await applyBrainSignalsUniverse(items, { token, fetchImpl })
    expect(result.applied).toBe(false)
    expect(result.source).toBe('local')
    expect(result.items).toEqual(items)
    expect(result.error).toMatch(/unauthorized/)
    expect(result.error).not.toContain(token)
  })
})

describe('evaluateSignalsBrainOpen', () => {
  it('applies default AND gates and ignores bmScore unless the recipe opts in', async () => {
    vi.stubEnv('MARKET_BRAIN_SIGNALS', '1')
    const fetchImpl = brainFetch({
      union: {
        tokens: [
          { mint: 'MintB', marketCap: 80_000, liquidity: 20_000, score100: 10 },
        ],
      },
      recipes: {
        recipes: [
          {
            id: 'signals_sell_over_100',
            active: true,
            domain: 'signals',
            universe: ['union'],
            gates: [
              { kind: 'membership' },
              { kind: 'mcap', n: 50_000 },
              { kind: 'liquidity', n: 10_000 },
              { kind: 'climateSafe' },
            ],
            profileId: 'default',
          },
        ],
      },
    })
    const result = await applyBrainSignalsUniverse([row('MintB')], {
      token: 't',
      fetchImpl,
      recipeId: 'signals_sell_over_100',
    })
    const climate = { label: 'Safe' as const }
    const pass = evaluateSignalsBrainOpen(row('MintB'), result, {
      climate,
      recipeId: 'signals_sell_over_100',
    })
    expect(pass.pass).toBe(true)
    expect(pass.gates.find((g) => g.id === 'bmScore')?.enabled).toBe(false)
  })
})
