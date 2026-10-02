/**
 * Spawn diversity guard — GATED, records first.
 *
 * The search spawner's only limit is a count cap (`MAX_CONCURRENT_SEARCH = 3`), and the
 * grid ranks exit-parameter neighbours adjacently, so all three slots can go to the same
 * entry rule: measured token-set Jaccard 0.66 between
 * `search_mcap_first_seen_sl_30_tp200_h48` and `..._tp300_h48`. That redundancy is what
 * made the "consensus" signal look real before families were counted
 * (src/strategies/strategy-family.ts).
 *
 * This module measures the redundancy and only acts when
 *    SEARCH_DIVERSITY_ENFORCE=1
 * (threshold `SEARCH_DIVERSITY_MAX_JACCARD`, default 0.5). Default is to annotate and
 * record, so the spawner's behaviour is unchanged until someone turns it on.
 */

export const DEFAULT_SEARCH_DIVERSITY_MAX_JACCARD = 0.5

function parseOnOff(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(v)) return true
  if (['0', 'false', 'off', 'no'].includes(v)) return false
  return fallback
}

export function searchDiversityEnforced(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseOnOff(env.SEARCH_DIVERSITY_ENFORCE, false)
}

export function getSearchDiversityMaxJaccard(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.SEARCH_DIVERSITY_MAX_JACCARD)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_SEARCH_DIVERSITY_MAX_JACCARD
}

export type CandidateTokens = { id: string; tokens: ReadonlySet<string> }

export type CandidateDiversity = {
  candidate_id: string
  /** Highest overlap against an already-active variant. */
  max_jaccard: number
  counterpart_id: string | null
  shared: number
  redundant: boolean
}

/** Jaccard of two token sets. 0 when either is empty (no evidence of redundancy). */
export function tokenSetJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const t of small) if (large.has(t)) shared += 1
  return shared / (a.size + b.size - shared)
}

export function sharedTokenCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const t of small) if (large.has(t)) shared += 1
  return shared
}

/**
 * Per candidate: the highest Jaccard against any active variant, and whether it is at
 * or above the threshold (i.e. it would be rejected when enforcing).
 */
export function annotateCandidateDiversity(params: {
  candidates: CandidateTokens[]
  active: CandidateTokens[]
  maxJaccard: number
}): CandidateDiversity[] {
  return params.candidates.map((candidate) => {
    let best = 0
    let counterpart: string | null = null
    let shared = 0
    for (const other of params.active) {
      const j = tokenSetJaccard(candidate.tokens, other.tokens)
      if (j > best) {
        best = j
        counterpart = other.id
        shared = sharedTokenCount(candidate.tokens, other.tokens)
      }
    }
    return {
      candidate_id: candidate.id,
      max_jaccard: best,
      counterpart_id: counterpart,
      shared,
      redundant: counterpart != null && best >= params.maxJaccard,
    }
  })
}
