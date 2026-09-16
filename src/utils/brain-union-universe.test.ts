import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  evaluateBrainBackedOpen,
  pickLegoRecipe,
} from '@/utils/brain-gates'
import {
  filterByMintMembership,
  loadBrainUnionUniverse,
} from '@/utils/brain-union-universe'
import type { BrainListToken, LegoRecipe } from '@/utils/market-brain'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const MINT = 'MintB'

function token(overrides: Partial<BrainListToken> = {}): BrainListToken {
  return {
    mint: MINT,
    symbol: 'B',
    name: 'B',
    marketCap: 80_000,
    liquidity: 20_000,
    score100: 10,
    freshWalletsPct: 80,
    top10AdjustedPct: 90,
    raw: {},
    ...overrides,
  }
}

describe('filterByMintMembership', () => {
  it('keeps matching mints and fail-closes on an empty universe', () => {
    const items = [{ id: 'MintA' }, { id: 'MintB' }]
    expect(
      filterByMintMembership(items, (row) => row.id, ['MintB']).map((row) => row.id),
    ).toEqual(['MintB'])
    expect(filterByMintMembership(items, (row) => row.id, [])).toEqual([])
  })
})

describe('evaluateBrainBackedOpen', () => {
  const climate = { label: 'Safe' as const }

  it('prefers brain list mcap/liq and does not enable bmScore by default', () => {
    const result = evaluateBrainBackedOpen({
      mint: MINT,
      localMarketCap: 1_000,
      brainToken: token(),
      universeMints: [MINT],
      climate,
    })
    expect(result.pass).toBe(true)
    expect(result.gates.find((g) => g.id === 'bmScore')?.enabled).toBe(false)
  })

  it('fills local mcap when the brain row omits it, and fail-closes missing liq', () => {
    const missingLiq = evaluateBrainBackedOpen({
      mint: MINT,
      localMarketCap: 80_000,
      brainToken: token({ marketCap: null, liquidity: null }),
      universeMints: [MINT],
      climate,
    })
    expect(missingLiq.pass).toBe(false)
    expect(missingLiq.rejectedBy).toEqual(['liquidity'])

    const filled = evaluateBrainBackedOpen({
      mint: MINT,
      localMarketCap: 80_000,
      localLiquidity: 12_000,
      brainToken: token({ marketCap: null, liquidity: null }),
      universeMints: [MINT],
      climate,
    })
    expect(filled.pass).toBe(true)
  })

  it('opts in bmScore only when the recipe lists it', () => {
    const recipe: LegoRecipe = {
      id: 'signals_sell_over_100',
      active: true,
      domain: 'signals',
      universe: ['union'],
      gates: [{ id: 'bmScore', min: 45 }],
      profileId: 'default',
      raw: {},
    }
    const rejected = evaluateBrainBackedOpen({
      mint: MINT,
      brainToken: token({ score100: 10 }),
      universeMints: [MINT],
      climate,
      recipe,
    })
    expect(rejected.rejectedBy).toContain('bmScore')
  })
})

describe('pickLegoRecipe', () => {
  it('prefers exact id then an active domain recipe', () => {
    const recipes: LegoRecipe[] = [
      {
        id: 'other',
        active: true,
        domain: 'mcap',
        universe: ['union'],
        gates: [],
        profileId: 'default',
        raw: {},
      },
      {
        id: 'signals_sell_over_100',
        active: true,
        domain: 'signals',
        universe: ['union'],
        gates: [],
        profileId: 'default',
        raw: {},
      },
    ]
    expect(pickLegoRecipe(recipes, { recipeId: 'signals_sell_over_100' })?.id).toBe(
      'signals_sell_over_100',
    )
    expect(pickLegoRecipe(recipes, { domain: 'signals' })?.id).toBe('signals_sell_over_100')
  })
})

describe('loadBrainUnionUniverse', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  it('loads /union membership and recipes when enabled', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input)
      if (href.includes('/recipes')) {
        return jsonResponse({
          recipes: [
            {
              id: 'mcap_enter_first_seen',
              active: true,
              domain: 'mcap',
              universe: ['union'],
              gates: [],
              profileId: 'default',
            },
          ],
        })
      }
      return jsonResponse({
        tokens: [{ mint: 'MintB', marketCap: 90_000, liquidity: 11_000 }],
      })
    })
    const loaded = await loadBrainUnionUniverse({
      enabled: true,
      skipReason: null,
      token: 't',
      fetchImpl,
      domain: 'mcap',
    })
    expect(loaded.applied).toBe(true)
    expect(loaded.source).toBe('union')
    expect(loaded.mints).toEqual(['MintB'])
    expect(loaded.recipesById.get('mcap_enter_first_seen')?.domain).toBe('mcap')
  })
})
