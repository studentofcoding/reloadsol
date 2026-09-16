/**
 * Shared GET /union membership loader for mcap + signals brain plugs.
 *
 * Trending keeps its own copy in strategies/trending-track/brain-universe.ts.
 * Prefer /union; recipe.universe is used when a matching recipe lists endpoints.
 * Brain fetch errors fail soft (applied=false). Do not log tokens. Live execute unchanged.
 */

import {
  evaluateBrainBackedOpen,
  pickLegoRecipe,
  type GateEvalResult,
} from '@/utils/brain-gates'
import {
  fetchBrainList,
  fetchBrainRecipes,
  fetchBrainUnion,
  isBrainListName,
  type BrainListName,
  type BrainListToken,
  type LegoDomain,
  type LegoRecipe,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'

export type BrainUnionUniverse = {
  applied: boolean
  source: 'local' | 'union' | 'recipe'
  mints: string[]
  tokensByMint: Map<string, BrainListToken>
  recipesById: Map<string, LegoRecipe>
  unionSize: number
  error?: string
}

function emptyUniverse(error?: string): BrainUnionUniverse {
  return {
    applied: false,
    source: 'local',
    mints: [],
    tokensByMint: new Map(),
    recipesById: new Map(),
    unionSize: 0,
    error,
  }
}

function mergeTokens(rows: BrainListToken[]): {
  mints: string[]
  tokensByMint: Map<string, BrainListToken>
} {
  const tokensByMint = new Map<string, BrainListToken>()
  for (const token of rows) {
    const mint = token.mint?.trim()
    if (!mint || tokensByMint.has(mint)) continue
    tokensByMint.set(mint, token)
  }
  return { mints: [...tokensByMint.keys()], tokensByMint }
}

function recipesMap(recipes: LegoRecipe[]): Map<string, LegoRecipe> {
  const byId = new Map<string, LegoRecipe>()
  for (const recipe of recipes) byId.set(recipe.id, recipe)
  return byId
}

function universeListsForRecipe(recipe: LegoRecipe | null): BrainListName[] {
  if (!recipe?.universe?.length) return ['union']
  const lists: BrainListName[] = []
  for (const name of recipe.universe) {
    if (isBrainListName(name) && !lists.includes(name)) lists.push(name)
  }
  return lists.length > 0 ? lists : ['union']
}

export function filterByMintMembership<T>(
  items: T[],
  mintOf: (item: T) => string | null | undefined,
  unionMints: Iterable<string>,
): T[] {
  const membership = new Set<string>()
  for (const mint of unionMints) {
    const trimmed = mint?.trim()
    if (trimmed) membership.add(trimmed)
  }
  if (membership.size === 0) return []
  return items.filter((item) => {
    const mint = mintOf(item)?.trim()
    return Boolean(mint && membership.has(mint))
  })
}

export function localMarketCapOf(item: {
  current_mcap?: number | null
  first_mcap?: number | null
}): number | null {
  return asLocalNumber(item.current_mcap) ?? asLocalNumber(item.first_mcap)
}

function asLocalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Load /union (or recipe universe) + recipes. Fail-soft: recipe errors still
 * apply membership when the list fetch succeeds.
 */
export async function loadBrainUnionUniverse(
  params: {
    enabled: boolean
    skipReason: string | null
    recipeId?: string
    domain?: LegoDomain
  } & MarketBrainFetchOpts,
): Promise<BrainUnionUniverse> {
  if (params.skipReason) return emptyUniverse(params.skipReason)
  if (!params.enabled) return emptyUniverse()

  const fetchOpts: MarketBrainFetchOpts = {
    baseUrl: params.baseUrl,
    token: params.token,
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
  }

  const [unionResult, recipesResult] = await Promise.all([
    fetchBrainUnion(fetchOpts),
    fetchBrainRecipes(fetchOpts),
  ])

  const recipesById = recipesResult.ok
    ? recipesMap(recipesResult.data)
    : new Map<string, LegoRecipe>()
  const recipe = pickLegoRecipe(recipesById.values(), {
    recipeId: params.recipeId,
    domain: params.domain,
  })
  const lists = universeListsForRecipe(recipe)
  const preferUnionOnly = lists.length === 1 && lists[0] === 'union'

  let tokens: BrainListToken[] = []
  let source: 'union' | 'recipe' = 'union'
  if (preferUnionOnly) {
    if (!unionResult.ok) return emptyUniverse(unionResult.error)
    tokens = unionResult.data.tokens
    source = 'union'
  } else {
    const fetched = await Promise.all(lists.map((list) => fetchBrainList(list, fetchOpts)))
    const okLists = fetched.filter((row) => row.ok)
    if (okLists.length === 0) {
      const firstError = fetched.find((row) => !row.ok)
      return emptyUniverse(firstError && !firstError.ok ? firstError.error : 'brain list fetch failed')
    }
    for (const row of okLists) {
      if (row.ok) tokens.push(...row.data.tokens)
    }
    source = 'recipe'
  }

  const merged = mergeTokens(tokens)
  return {
    applied: true,
    source,
    mints: merged.mints,
    tokensByMint: merged.tokensByMint,
    recipesById,
    unionSize: merged.mints.length,
  }
}

export type BrainMintItem = {
  token_address?: string | null
  current_mcap?: number | null
  first_mcap?: number | null
}

export function evaluateUniverseOpen(
  item: BrainMintItem & { token_address: string },
  universe: BrainUnionUniverse,
  opts: {
    climate?: Parameters<typeof evaluateBrainBackedOpen>[0]['climate']
    recipeId?: string
    domain?: LegoDomain
    localLiquidity?: number | null
  } = {},
): GateEvalResult {
  const mint = item.token_address.trim()
  const recipe = pickLegoRecipe(universe.recipesById.values(), {
    recipeId: opts.recipeId,
    domain: opts.domain,
  })
  return evaluateBrainBackedOpen({
    mint,
    localMarketCap: localMarketCapOf(item),
    localLiquidity: opts.localLiquidity ?? null,
    brainToken: universe.tokensByMint.get(mint) ?? null,
    universeMints: universe.mints,
    climate: opts.climate,
    recipe,
  })
}
