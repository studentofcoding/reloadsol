/**
 * The rug signal's counterfactual sink — what the scorer *would* have decided, kept where it can be read.
 *
 * The detector already logged its verdict with `console.info`, which is not queryable and is stripped from
 * the production bundle entirely (`next.config.js` keeps only `error`/`warn`). A validation that cannot read
 * its own history is not a validation, so every evaluation lands here — **including the ones that did not
 * trip**, because those are the control cohort and without them there is no base rate to compare against.
 *
 * Shape mirrors `strategy_consensus_shadow` (`src/strategies/consensus-gate.ts`): a self-creating table with
 * indexes, a fail-soft insert that can never break an open, and a reader. The reader is `loadRugSignalShadow`
 * surfaced at `GET /api/rug-signal/shadow` — shipping a sink without a reader is how a shadow store becomes a
 * dead store.
 *
 * This table is an **observation log, not a ledger**: rows are immutable, they are never used to make a
 * decision, and nothing here is ever joined back into a trade path.
 */

import { query } from '@/utils/db'

/** `would_rug` is the trip; `pass` is a scored non-trip; the rest mean the scorer had nothing to judge. */
export type RugSignalShadowDecision = 'would_rug' | 'pass' | 'no_bars' | 'disabled'

/** Where the evaluation came from — a pipeline candidate vs the metrics sweep's whole watch set. */
export type RugSignalShadowSource = 'gmgn_pipeline' | 'metrics_sweep'

export type RugSignalShadowRow = {
  chain: string
  tokenAddress: string
  symbol?: string | null
  score: number | null
  breakdown: Record<string, number> | null
  barsSource: string
  decision: RugSignalShadowDecision
  mode: 'shadow' | 'enforce'
  reason: string | null
  mcap: number | null
  liquidityUsd: number | null
  barsUsed: number
  source: RugSignalShadowSource
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rug_signal_shadow (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT,
    score INTEGER,
    breakdown JSONB,
    bars_source TEXT NOT NULL,
    bars_used INTEGER NOT NULL DEFAULT 0,
    decision TEXT NOT NULL CHECK (decision IN ('would_rug', 'pass', 'no_bars', 'disabled')),
    mode TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce')),
    reason TEXT,
    mcap DOUBLE PRECISION,
    liquidity_usd DOUBLE PRECISION,
    source TEXT NOT NULL
  )
`

/** One statement per query(): the extended protocol rejects multiple commands. */
const CREATE_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS rug_signal_shadow_created_idx
     ON rug_signal_shadow (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS rug_signal_shadow_decision_idx
     ON rug_signal_shadow (decision, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS rug_signal_shadow_token_idx
     ON rug_signal_shadow (token_address, created_at DESC)`,
]

let ensurePromise: Promise<void> | null = null

async function ensureShadowTable(): Promise<void> {
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
      // Let a later call retry rather than caching the failure forever.
      ensurePromise = null
      throw error
    })
  await ensurePromise
}

/** Fail-soft by contract: a shadow write must never break the caller's path. */
export async function recordRugSignalShadow(row: RugSignalShadowRow): Promise<void> {
  try {
    await ensureShadowTable()
    await query(
      `INSERT INTO rug_signal_shadow (
         chain, token_address, symbol, score, breakdown, bars_source, bars_used,
         decision, mode, reason, mcap, liquidity_usd, source
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.chain,
        row.tokenAddress,
        row.symbol ?? null,
        row.score == null ? null : Math.round(row.score),
        row.breakdown == null ? null : JSON.stringify(row.breakdown),
        row.barsSource,
        row.barsUsed,
        row.decision,
        row.mode,
        row.reason,
        row.mcap,
        row.liquidityUsd,
        row.source,
      ],
    )
  } catch (error) {
    console.warn('[rug-signal:shadow] record failed', {
      mint: row.tokenAddress,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export type RugSignalShadowEntry = RugSignalShadowRow & {
  id: string
  createdAt: string
}

export type RugSignalShadowSummary = {
  rows: number
  byDecision: Record<string, number>
  newest: string | null
}

/**
 * Reader. `limit` is clamped: this is an observation log and a full scan is never what a caller wants.
 * Optionally filtered to one token, which is how a single verdict gets traced after the fact.
 */
export async function loadRugSignalShadow(params: {
  limit?: number
  tokenAddress?: string | null
  decision?: string | null
} = {}): Promise<{ entries: RugSignalShadowEntry[]; summary: RugSignalShadowSummary }> {
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 100)), 1000)
  const where: string[] = []
  const values: unknown[] = []
  if (params.tokenAddress) {
    values.push(params.tokenAddress)
    where.push(`token_address = $${values.length}`)
  }
  if (params.decision) {
    values.push(params.decision)
    where.push(`decision = $${values.length}`)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  values.push(limit)

  const { rows } = await query<{
    id: string
    created_at: string
    chain: string
    token_address: string
    symbol: string | null
    score: number | null
    breakdown: Record<string, number> | null
    bars_source: string
    bars_used: number
    decision: string
    mode: string
    reason: string | null
    mcap: number | null
    liquidity_usd: number | null
    source: string
  }>(
    `SELECT id::text AS id, created_at::text AS created_at, chain, token_address, symbol, score,
            breakdown, bars_source, bars_used, decision, mode, reason, mcap, liquidity_usd, source
       FROM rug_signal_shadow
       ${clause}
      ORDER BY created_at DESC
      LIMIT $${values.length}`,
    values,
  )

  const { rows: counts } = await query<{ decision: string; n: string; newest: string | null }>(
    `SELECT decision, COUNT(*)::text AS n, MAX(created_at)::text AS newest
       FROM rug_signal_shadow GROUP BY decision`,
  )

  return {
    entries: rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      chain: r.chain,
      tokenAddress: r.token_address,
      symbol: r.symbol,
      score: r.score,
      breakdown: r.breakdown,
      barsSource: r.bars_source,
      barsUsed: r.bars_used,
      decision: r.decision as RugSignalShadowDecision,
      mode: r.mode as 'shadow' | 'enforce',
      reason: r.reason,
      mcap: r.mcap,
      liquidityUsd: r.liquidity_usd,
      source: r.source as RugSignalShadowSource,
    })),
    summary: {
      rows: counts.reduce((sum, c) => sum + Number(c.n), 0),
      byDecision: Object.fromEntries(counts.map((c) => [c.decision, Number(c.n)])),
      newest: counts.reduce<string | null>(
        (newest, c) => (c.newest && (!newest || c.newest > newest) ? c.newest : newest),
        null,
      ),
    },
  }
}
