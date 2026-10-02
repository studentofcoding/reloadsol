/**
 * Strategy lifecycle — SPEC-config-taxonomy-v1 § T5 / rule 4: `trial | active | retired`.
 *
 * The same derivation the Workers table already uses for cron rows (`b0a9d9d`), applied to strategy
 * rows, from fields the row already has plus one the outcomes table already holds:
 *
 *     worker row                              strategy row
 *     disabled                -> retired      is_active = false              -> retired
 *     enabled, last_success_at-> active       active, has a closed outcome   -> active
 *     enabled, never succeeded-> trial        active, no closed outcome yet  -> trial
 *
 * `last_outcome_at` is the strategy's `last_success_at`: the latest `exit_at` in `strategy_outcomes`.
 *
 * Derived, never stored. Nothing here writes a row, so "retired" is a view over `is_active` and can be
 * undone by flipping `is_active` back — which is also why the search variants are *archived*, not
 * deleted: their rows, configs and outcomes stay exactly where they were.
 *
 * Deliberately dependency-free (no `./db`) so the client bundle can import it.
 */
import { isSearchVariantId } from './strategy-family'

export type StrategyLifecycle = 'trial' | 'active' | 'retired'

export type StrategyLifecycleInput = {
  is_active: boolean
  /** ISO timestamp of the latest closed outcome, if any. */
  last_outcome_at?: string | null
}

export function deriveStrategyLifecycle(input: StrategyLifecycleInput): StrategyLifecycle {
  if (!input.is_active) return 'retired'
  return input.last_outcome_at ? 'active' : 'trial'
}

/**
 * A `search_*` experiment clone (spawned by the P2 bandit, `strategy-search-bandit.ts`) that is no
 * longer active. These are DB-only rows, so there is no list of them in code to name: the predicate is
 * the id prefix (`isSearchVariantId`) plus the lifecycle word. An *active* search variant is a live
 * experiment and is not archived.
 */
export function isArchivedSearchVariant(id: string, lifecycle: StrategyLifecycle): boolean {
  return lifecycle === 'retired' && isSearchVariantId(id)
}

/**
 * Split a family's strategies into the ones that stay in the main grid and the archived search
 * variants. Order is preserved on both sides. A strategy whose lifecycle cannot be derived because the
 * outcomes lookup failed (`lastOutcomeAt` is `null`) is still classified on `is_active` alone —
 * retirement does not need the lookup, only trial-vs-active does.
 */
export function partitionByLifecycle<T extends { id: string; is_active: boolean }>(
  strategies: readonly T[],
  lastOutcomeAt: Readonly<Record<string, string>> | null,
): {
  live: Array<{ strategy: T; lifecycle: StrategyLifecycle | null }>
  archived: Array<{ strategy: T; lifecycle: StrategyLifecycle }>
} {
  const live: Array<{ strategy: T; lifecycle: StrategyLifecycle | null }> = []
  const archived: Array<{ strategy: T; lifecycle: StrategyLifecycle }> = []
  for (const strategy of strategies) {
    if (!strategy.is_active) {
      const lifecycle: StrategyLifecycle = 'retired'
      if (isArchivedSearchVariant(strategy.id, lifecycle)) archived.push({ strategy, lifecycle })
      else live.push({ strategy, lifecycle })
      continue
    }
    // Active: trial vs active needs the outcomes lookup. Without it, say nothing rather than guess.
    live.push({
      strategy,
      lifecycle: lastOutcomeAt
        ? deriveStrategyLifecycle({ is_active: true, last_outcome_at: lastOutcomeAt[strategy.id] ?? null })
        : null,
    })
  }
  return { live, archived }
}
