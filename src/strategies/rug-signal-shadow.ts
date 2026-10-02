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
  /** 5m bars the scorer actually evaluated — 0 on rows it could not judge. */
  barsScored: number
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
    bars_scored INTEGER NOT NULL DEFAULT 0,
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
    // The table may predate a column (it is created on first use, not by a migration), so add it
    // idempotently rather than assuming a fresh create.
    await query(
      `ALTER TABLE rug_signal_shadow ADD COLUMN IF NOT EXISTS bars_scored INTEGER NOT NULL DEFAULT 0`,
    )
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
         chain, token_address, symbol, score, breakdown, bars_source, bars_used, bars_scored,
         decision, mode, reason, mcap, liquidity_usd, source
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        row.chain,
        row.tokenAddress,
        row.symbol ?? null,
        row.score == null ? null : Math.round(row.score),
        row.breakdown == null ? null : JSON.stringify(row.breakdown),
        row.barsSource,
        row.barsUsed,
        row.barsScored,
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

/** Sort keys the reader accepts. Anything else falls back to `created_at`. */
export type RugSignalShadowOrder = 'created_at' | 'score'

/**
 * Column whitelist. An `ORDER BY` identifier cannot be parameterised, so it is interpolated — which
 * means only these exact strings may ever reach the SQL, never caller-supplied text.
 */
const ORDER_COLUMNS: Record<RugSignalShadowOrder, string> = {
  created_at: 'created_at',
  score: 'score',
}

/**
 * Reader. `limit` is clamped: this is an observation log and a full scan is never what a caller wants.
 * Optionally filtered to one token, which is how a single verdict gets traced after the fact.
 *
 * Paged and sortable for the dev page, which is looking at thousands of rows. `total` is the count
 * matching the *filters*, not the whole log, so the pager cannot overstate what it is walking.
 */
export async function loadRugSignalShadow(params: {
  limit?: number
  offset?: number
  tokenAddress?: string | null
  decision?: string | null
  orderBy?: RugSignalShadowOrder | null
  direction?: 'asc' | 'desc' | null
} = {}): Promise<{ entries: RugSignalShadowEntry[]; summary: RugSignalShadowSummary; total: number }> {
  const limit = Math.min(Math.max(1, Math.floor(params.limit ?? 100)), 1000)
  const offset = Math.max(0, Math.floor(params.offset ?? 0))
  const where: string[] = []
  const filters: unknown[] = []
  if (params.tokenAddress) {
    filters.push(params.tokenAddress)
    where.push(`token_address = $${filters.length}`)
  }
  if (params.decision) {
    filters.push(params.decision)
    where.push(`decision = $${filters.length}`)
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const column = ORDER_COLUMNS[params.orderBy ?? 'created_at'] ?? 'created_at'
  const direction = params.direction === 'asc' ? 'ASC' : 'DESC'
  // `NULLS LAST` keeps unscored rows out of the top of a score sort rather than treating a missing
  // score as the lowest score; `id` breaks ties so a page boundary cannot repeat or skip a row.
  const order = `ORDER BY ${column} ${direction} NULLS LAST, created_at DESC, id DESC`
  const values = [...filters, limit, offset]

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
    bars_scored: number
    decision: string
    mode: string
    reason: string | null
    mcap: number | null
    liquidity_usd: number | null
    source: string
  }>(
    `SELECT id::text AS id, created_at::text AS created_at, chain, token_address, symbol, score,
            breakdown, bars_source, bars_used, bars_scored, decision, mode, reason, mcap,
            liquidity_usd, source
       FROM rug_signal_shadow
       ${clause}
       ${order}
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )

  const { rows: counts } = await query<{ decision: string; n: string; newest: string | null }>(
    `SELECT decision, COUNT(*)::text AS n, MAX(created_at)::text AS newest
       FROM rug_signal_shadow GROUP BY decision`,
  )

  const { rows: totals } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM rug_signal_shadow ${clause}`,
    filters,
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
      barsScored: r.bars_scored,
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
    total: Number(totals[0]?.n ?? 0),
  }
}
