/**
 * Which strategies are the *same bet*?
 *
 * Breadth ("N strategies agree on this token") only means something if the N are
 * independent. Today `MAX_CONCURRENT_SEARCH = 3` fills all three slots with grid
 * neighbours that share a constant entry filter and differ only in take-profit
 * (`buildDefaultMcapSearchGrid`), so `search_mcap_first_seen_sl_30_tp150_h48`,
 * `..._tp200_h48` and `..._tp300_h48` are one rule counted three times — measured
 * Jaccard 0.37-0.66 against each other, 0.01-0.05 against every other strategy.
 *
 * There is no lineage column anywhere (`strategy_definitions` has none,
 * `strategy_outcomes` has none, `features` has none), so the family is derived from
 * the definition: its id plus, for search variants, the entry template in its config.
 *
 * Deliberately dependency-free. The canonical-slot mapping already exists as
 * `canonicalSimId` (src/strategies/strategy-search-cycle.ts:82) and the prefix list as
 * `isSearchStrategyId` (src/strategies/strategy-search-bandit.ts:63); both of those
 * modules import `./db`, so importing them here would create a cycle for the callers
 * that need a family (db.ts). This module therefore restates those two rules and
 * `strategy-family.test.ts` asserts it agrees with `canonicalSimId` for every known
 * entry template — if that mapping moves, the test fails.
 */
import type { StrategyChain, StrategyDomain } from './types'

/** Mirrors SEARCH_ID_PREFIX in src/strategies/strategy-search-bandit.ts:26. */
const SEARCH_ID_PREFIXES = ['search_mcap_', 'search_gmgn_', 'search_signals_'] as const

export function isSearchVariantId(id: string): boolean {
  return SEARCH_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
}

/**
 * Which canonical slot a search variant belongs to, by entry template only — exit
 * params (stop loss / take profit / hold) are what the grid varies, and they are the
 * same bet. Mirrors canonicalSimId; see the note above.
 *
 * Stricter than canonicalSimId on purpose: an *unknown* template returns null so the
 * variant stays its own family, rather than being merged into `first_seen` (which is
 * what `canonicalSimId`'s `=== 'milestone_80' ? … : first_seen` fallback would do).
 */
function canonicalSlotFor(
  domain: StrategyDomain,
  entryTemplate: string | null,
): string | null {
  if (domain === 'signals') return 'signals_default'
  if (domain === 'gmgn') return 'gmgn_smartmoney_default'
  if (domain === 'mcap_tracker') {
    if (entryTemplate === 'milestone_80') return 'mcap_enter_at_80'
    if (entryTemplate === 'first_seen') return 'mcap_enter_first_seen'
    return null
  }
  return null
}

/**
 * Read the entry template from a stored strategy config. The live shape nests it
 * (`{ entry: { entryTemplate } }`, see McapSearchConfig); `candidateFromSearchRow`
 * lifts it to the top level before `canonicalSimId` reads it. Accept both.
 */
function readEntryTemplate(config: Record<string, unknown> | null | undefined): string | null {
  if (!config) return null
  const top = config.entryTemplate
  if (typeof top === 'string' && top.trim()) return top
  const entry = config.entry
  if (entry && typeof entry === 'object') {
    const nested = (entry as Record<string, unknown>).entryTemplate
    if (typeof nested === 'string' && nested.trim()) return nested
  }
  return null
}

/**
 * The family (independent bet) a strategy belongs to.
 *
 * 1. `_rh` twins collapse to their sol sibling by suffix — the twins are named
 *    `<base>_rh` and resolved per chain (load-strategy.ts), and the family key carries
 *    the chain, so a stripped id cannot collide across chains.
 * 2. Search variants collapse to their canonical slot by entry template.
 * 3. Everything else is its own family.
 */
export function resolveStrategyFamily(params: {
  strategyId: string
  domain: StrategyDomain
  /** strategy_definitions.config — needed for search variants (entry template). */
  config?: Record<string, unknown> | null
}): string {
  const { strategyId, domain } = params
  const base = strategyId.endsWith('_rh') ? strategyId.slice(0, -3) : strategyId
  if (!isSearchVariantId(base)) return base
  return canonicalSlotFor(domain, readEntryTemplate(params.config)) ?? base
}

/** Family identity is scoped to a chain: the same id may exist on sol and robinhood. */
export function strategyFamilyKey(chain: StrategyChain, familyId: string): string {
  return `${chain}:${familyId}`
}
