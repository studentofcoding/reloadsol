/**
 * The strategy-consensus gate — GATED, and inert until the evidence exists.
 *
 * The idea: require N independent strategy FAMILIES to already agree on a mint before
 * opening. Family counting lives in src/strategies/strategy-family.ts; the evidence in
 * src/strategies/consensus-test.ts.
 *
 * Why it does not gate anything today:
 *   - The premium for agreement is NOT established. By independent family the median
 *     PnL is +120 % at 1 family (n=238), +255 % at 2 (n=18), +157 % at 3 (n=3) — up then
 *     down, on 18 and 3 tokens, and the live endpoint reports `inconclusive: thin sample`.
 *   - So `decideConsensusGate` returns 'no_evidence' whenever the test is not significant,
 *     regardless of mode. A gate that fires on an unproven signal is worse than no gate.
 *   - Even with significant evidence, the decision only takes effect when
 *     CONSENSUS_GATE_MODE=enforce. Default is 'shadow': record, change nothing.
 *
 * Mirrors the social FOMO / Jev shadow pattern (social-fomo-noul-shadow.ts):
 * shadow by default, explicit kill switch, fail-soft sink that can never break an open.
 */

import { query } from '@/utils/db'
import { isMissingSchemaError } from '@/utils/db-health'

export type ConsensusGateMode = 'off' | 'shadow' | 'enforce'

export const DEFAULT_CONSENSUS_MIN_FAMILIES = 2

function parseOnOff(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback
  const v = raw.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(v)) return true
  if (['0', 'false', 'off', 'no'].includes(v)) return false
  return fallback
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Kill switch forces shadow (record only); `off` stops recording. */
export function consensusGateMode(
  env: Record<string, string | undefined> = process.env,
): ConsensusGateMode {
  if (parseOnOff(env.CONSENSUS_GATE_KILL_SWITCH, false)) return 'shadow'
  const raw = env.CONSENSUS_GATE_MODE?.trim().toLowerCase()
  if (raw === 'enforce') return 'enforce'
  if (raw === 'off') return 'off'
  return 'shadow'
}

export function getConsensusMinFamilies(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePositiveInt(env.CONSENSUS_GATE_MIN_FAMILIES, DEFAULT_CONSENSUS_MIN_FAMILIES)
}

export type ConsensusGateEvidence = {
  significant: boolean
  reason: string
}

export type ConsensusGateDecision = {
  decision: 'would_gate' | 'would_pass' | 'no_evidence'
  reason: string
  /** True only when the caller must actually skip the open. */
  enforced: boolean
}

/**
 * Pure decision. `no_evidence` whenever the consensus test is not significant — the
 * gate is not allowed to act on an unproven signal, whatever the mode says.
 */
export function decideConsensusGate(params: {
  familyCount: number
  minFamilies: number
  evidence: ConsensusGateEvidence | null
  mode: ConsensusGateMode
}): ConsensusGateDecision {
  const { familyCount, minFamilies, evidence, mode } = params
  if (!evidence) {
    return { decision: 'no_evidence', reason: 'no consensus evidence available', enforced: false }
  }
  if (!evidence.significant) {
    return {
      decision: 'no_evidence',
      reason: `evidence not significant: ${evidence.reason}`,
      enforced: false,
    }
  }
  if (familyCount >= minFamilies) {
    return {
      decision: 'would_pass',
      reason: `${familyCount} family(ies) >= ${minFamilies}`,
      enforced: false,
    }
  }
  return {
    decision: 'would_gate',
    reason: `${familyCount} family(ies) < ${minFamilies} and the lift is significant`,
    enforced: mode === 'enforce',
  }
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS strategy_consensus_shadow (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    chain TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT,
    family_count INTEGER NOT NULL,
    families TEXT[] NOT NULL DEFAULT '{}',
    strategies TEXT[] NOT NULL DEFAULT '{}',
    min_families INTEGER NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('would_gate', 'would_pass', 'no_evidence')),
    reason TEXT NOT NULL,
    evidence_significant BOOLEAN NOT NULL DEFAULT FALSE,
    evidence_reason TEXT,
    mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'enforce'))
  )
`

/** One statement per query(): the extended protocol rejects multiple commands. */
const CREATE_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS strategy_consensus_shadow_created_idx
     ON strategy_consensus_shadow (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS strategy_consensus_shadow_decision_idx
     ON strategy_consensus_shadow (decision, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS strategy_consensus_shadow_token_idx
     ON strategy_consensus_shadow (chain, token_address, created_at DESC)`,
]

let ensurePromise: Promise<void> | null = null

async function ensureConsensusShadowTable(): Promise<void> {
  if (ensurePromise) {
    await ensurePromise
    return
  }
  ensurePromise = (async () => {
    await query(CREATE_TABLE_SQL)
    for (const sql of CREATE_INDEX_SQL) await query(sql)
  })()
    .then(() => undefined)
    .catch((error) => {
      ensurePromise = null
      throw error
    })
  await ensurePromise
}

export type ConsensusShadowRow = {
  chain: string
  strategyId: string
  tokenAddress: string
  symbol?: string | null
  familyCount: number
  families: string[]
  strategies: string[]
  minFamilies: number
  decision: ConsensusGateDecision['decision']
  reason: string
  evidenceSignificant: boolean
  evidenceReason: string | null
  mode: ConsensusGateMode
}

/** Fail-soft: the shadow sink must never break an open. */
export async function recordConsensusShadow(row: ConsensusShadowRow): Promise<void> {
  try {
    await ensureConsensusShadowTable()
    await query(
      `INSERT INTO strategy_consensus_shadow (
         chain, strategy_id, token_address, symbol,
         family_count, families, strategies, min_families,
         decision, reason, evidence_significant, evidence_reason, mode
       ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10, $11, $12, $13)`,
      [
        row.chain,
        row.strategyId,
        row.tokenAddress,
        row.symbol ?? null,
        row.familyCount,
        row.families,
        row.strategies,
        row.minFamilies,
        row.decision,
        row.reason,
        row.evidenceSignificant,
        row.evidenceReason,
        row.mode,
      ],
    )
  } catch (error) {
    if (isMissingSchemaError(error)) return
    console.warn('[consensus-gate] shadow insert failed:', error)
  }
}
