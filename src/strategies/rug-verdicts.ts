import { query } from '@/utils/db'
import { firstHeldMinute, labelForward } from '@/strategies/rug-signal-separation'

/**
 * `rug_verdicts` — **one verdict per token, on a fixed 10-minute block** (SPEC-rug-verdict-block T3).
 *
 * The detector currently re-judges the same token on every sweep over a moving window, so 4,104
 * shadow rows are ~2,350 mints, the inputs at evaluation depend on when a sweep happened to run, and
 * the validation harness needed a per-mint dedupe to stop the rates from lying. This table is the
 * fix: a token is judged **once**, at its own clock, and the features are snapshotted at that moment.
 *
 * The clock is the mint's **first held minute** (`firstHeldMinute`), not `first_seen_at` — measured:
 * that column covers only ~17% of the scored corpus, 49 mints read as a *negative* age against it,
 * and the median lag from first-seen to our first candle is −18 min. Our own series is both the
 * honest clock and what the block is built from, so the two cannot disagree.
 *
 * **One verdict per token is enforced by the schema itself** — the primary key is
 * `(token_address, chain)` and every write is `ON CONFLICT DO NOTHING`. There is no code path that
 * can produce a second verdict, which is stronger than a guard that could be forgotten.
 *
 * **Fail-open throughout.** A verdict is a record of work that happened for other reasons; a recorder
 * that can fail the sweep would be worse than no recorder.
 */

export type RugVerdictDecision = 'would_rug' | 'pass' | 'no_bars'

export type RugVerdictInput = {
  chain: string
  tokenAddress: string
  /** Epoch seconds of the mint's first held minute — the clock this verdict is anchored to. */
  firstMinuteAt: number
  /** Real minutes in the block. `10` is complete; a short block is recorded, never padded. */
  minutesUsed: number
  score: number
  decision: RugVerdictDecision
  /** The snapshot: the scorer's breakdown plus the inputs it read. Written once, never recomputed. */
  features: Record<string, unknown>
  mcap: number | null
  liquidityUsd: number | null
  source: string
}

export type RugVerdictRow = {
  tokenAddress: string
  symbol: string | null
  firstMinuteAt: string
  verdictAt: string
  minutesUsed: number
  score: number | null
  decision: RugVerdictDecision
  features: Record<string, unknown> | null
  mcap: number | null
  liquidityUsd: number | null
  label: string | null
  source: string
}

let ensurePromise: Promise<void> | null = null

function ensureTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS rug_verdicts (
           token_address TEXT NOT NULL,
           chain TEXT NOT NULL DEFAULT 'sol',
           symbol TEXT,
           first_minute_at TIMESTAMPTZ NOT NULL,
           verdict_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           minutes_used INTEGER NOT NULL,
           score INTEGER,
           decision TEXT NOT NULL,
           features JSONB,
           mcap DOUBLE PRECISION,
           liquidity_usd DOUBLE PRECISION,
           label TEXT,
           label_at TIMESTAMPTZ,
           source TEXT NOT NULL,
           PRIMARY KEY (token_address, chain)
         )`,
      )
      await query(
        `CREATE INDEX IF NOT EXISTS idx_rug_verdicts_verdict_at ON rug_verdicts(verdict_at DESC)`,
      )
    })()
      .then(() => undefined)
      .catch((error) => {
        ensurePromise = null
        throw error
      })
  }
  return ensurePromise
}

/**
 * Write the one verdict for this token. Returns true when this call created it, false when the token
 * already had one (or the write failed) — the caller must not treat false as an error.
 */
export async function recordRugVerdict(
  input: RugVerdictInput,
  symbol?: string | null,
): Promise<boolean> {
  try {
    await ensureTable()
    const { rowCount } = await query(
      `INSERT INTO rug_verdicts (
         token_address, chain, symbol, first_minute_at, minutes_used, score, decision,
         features, mcap, liquidity_usd, source
       ) VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8::jsonb, $9, $10, $11)
       ON CONFLICT (token_address, chain) DO NOTHING`,
      [
        input.tokenAddress,
        input.chain,
        symbol ?? null,
        input.firstMinuteAt,
        input.minutesUsed,
        input.score,
        input.decision,
        JSON.stringify(input.features),
        input.mcap,
        input.liquidityUsd,
        input.source,
      ],
    )
    return rowCount > 0
  } catch {
    // Ignored on purpose: see the header.
    return false
  }
}

/** First held minute per mint, batched. Fail-open: an unknown mint is simply absent. */
export async function loadFirstHeldMinutes(mints: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(mints.map((m) => m.trim()).filter(Boolean))]
  const out = new Map<string, number>()
  if (unique.length === 0) return out
  try {
    const { rows } = await query<{ token_address: string; hour_bucket: string; c_min: number[] | null }>(
      `SELECT token_address, hour_bucket::text AS hour_bucket, c_min
         FROM token_metrics_history
        WHERE token_address = ANY($1::text[])
          AND c_min IS NOT NULL
        ORDER BY token_address, hour_bucket ASC`,
      [unique],
    )
    const byMint = new Map<string, Array<{ hour_bucket: string; c_min: number[] | null }>>()
    for (const row of rows) {
      const list = byMint.get(row.token_address) ?? []
      list.push({ hour_bucket: row.hour_bucket, c_min: row.c_min })
      byMint.set(row.token_address, list)
    }
    for (const [mint, hours] of byMint) {
      const first = firstHeldMinute(hours)
      if (first != null) out.set(mint, first)
    }
    return out
  } catch {
    return out
  }
}

/** Recent verdicts, newest first — the reader the dev page needs so this is not a dead store. */
export async function loadRugVerdicts(limit = 100): Promise<RugVerdictRow[]> {
  try {
    await ensureTable()
    const { rows } = await query<{
      token_address: string
      symbol: string | null
      first_minute_at: string
      verdict_at: string
      minutes_used: number
      score: number | null
      decision: RugVerdictDecision
      features: Record<string, unknown> | null
      mcap: number | null
      liquidity_usd: number | null
      label: string | null
      source: string
    }>(
      `SELECT token_address, symbol, first_minute_at::text AS first_minute_at,
              verdict_at::text AS verdict_at, minutes_used, score, decision, features, mcap,
              liquidity_usd, label, source
         FROM rug_verdicts
        ORDER BY verdict_at DESC
        LIMIT $1`,
      [Math.min(Math.max(1, Math.floor(limit)), 500)],
    )
    return rows.map((r) => ({
      tokenAddress: r.token_address,
      symbol: r.symbol,
      firstMinuteAt: r.first_minute_at,
      verdictAt: r.verdict_at,
      minutesUsed: r.minutes_used,
      score: r.score,
      decision: r.decision,
      features: r.features,
      mcap: r.mcap,
      liquidityUsd: r.liquidity_usd,
      label: r.label,
      source: r.source,
    }))
  } catch {
    return []
  }
}

export type RugVerdictHealth = {
  total: number
  fullBlocks: number
  byDecision: Record<string, number>
  newest: string | null
}

export async function rugVerdictHealth(): Promise<RugVerdictHealth> {
  const empty: RugVerdictHealth = { total: 0, fullBlocks: 0, byDecision: {}, newest: null }
  try {
    await ensureTable()
    const { rows } = await query<{ decision: string; n: string; newest: string | null }>(
      `SELECT decision, COUNT(*)::text AS n, MAX(verdict_at)::text AS newest
         FROM rug_verdicts GROUP BY decision`,
    )
    const { rows: totals } = await query<{ total: string; full: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE minutes_used >= 10)::text AS full
         FROM rug_verdicts`,
    )
    return {
      total: Number(totals[0]?.total ?? 0),
      fullBlocks: Number(totals[0]?.full ?? 0),
      byDecision: Object.fromEntries(rows.map((r) => [r.decision, Number(r.n)])),
      newest: rows.reduce<string | null>((n, r) => (r.newest && (!n || r.newest > n) ? r.newest : n), null),
    }
  } catch {
    return empty
  }
}

/**
 * T4 — the label. **A verdict is features; the label is what happened next.**
 *
 * The rule is the one the validation harness already uses and is deliberately *independent of the
 * scorer*: a ≥60% market-cap drop within 30 minutes of the verdict, read forward from the verdict
 * instant. It is the same `labelForward` the harness is pinned by tests through, so the corpus and
 * the validator cannot drift into two different definitions of "rug".
 *
 * Three properties that matter:
 *   * **Never fabricated.** A verdict whose forward minutes do not exist stays `label = NULL` and is
 *     counted as underivable — an unknown, not a `safe`. The whole point of the label is that it is
 *     measured, and a missing window is the absence of a measurement.
 *   * **Only once.** `WHERE label IS NULL` makes a re-run a no-op rather than a rewrite, so a verdict
 *     cannot quietly change its own label as more data lands.
 *   * **Fail-open.** Labelling is enrichment on rows written for other reasons; a failure here must
 *     not fail the sweep that produces them.
 */
export const RUG_LABEL_DROP = 0.6
export const RUG_LABEL_WINDOW_MIN = 30

export type RugLabelResult = {
  considered: number
  labelled: number
  collapsed: number
  underivable: number
}

/** Minute closes for a mint, from the stored per-hour arrays. */
function expandMinutes(rows: Array<{ hour_bucket: string; c_min: number[] | null }>): Array<{ t: number; c: number }> {
  const out: Array<{ t: number; c: number }> = []
  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs) || !Array.isArray(row.c_min)) continue
    for (let i = 0; i < row.c_min.length; i++) {
      const c = row.c_min[i]
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        out.push({ t: Math.floor((hourMs + i * 60_000) / 1000), c })
      }
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

export async function labelPendingRugVerdicts(
  limit = 500,
  windowMinutes = RUG_LABEL_WINDOW_MIN,
): Promise<RugLabelResult> {
  const result: RugLabelResult = { considered: 0, labelled: 0, collapsed: 0, underivable: 0 }
  try {
    await ensureTable()
    // Only verdicts whose outcome window has already closed: labelling earlier would read a partial
    // window and call it a safe.
    const { rows: pending } = await query<{ token_address: string; chain: string; verdict_at: string }>(
      `SELECT token_address, chain, verdict_at::text AS verdict_at
         FROM rug_verdicts
        WHERE label IS NULL
          AND verdict_at < NOW() - make_interval(mins => $1::int)
        ORDER BY verdict_at ASC
        LIMIT $2`,
      [windowMinutes, Math.min(Math.max(1, Math.floor(limit)), 2000)],
    )
    result.considered = pending.length
    if (pending.length === 0) return result

    const mints = [...new Set(pending.map((r) => r.token_address))]
    const { rows: minuteRows } = await query<{
      token_address: string
      hour_bucket: string
      c_min: number[] | null
    }>(
      `SELECT token_address, hour_bucket::text AS hour_bucket, c_min
         FROM token_metrics_history
        WHERE token_address = ANY($1::text[])
          AND c_min IS NOT NULL
          AND hour_bucket > NOW() - make_interval(mins => $2::int)
        ORDER BY hour_bucket ASC`,
      [mints, windowMinutes * 4],
    )
    const byMint = new Map<string, Array<{ hour_bucket: string; c_min: number[] | null }>>()
    for (const row of minuteRows) {
      const list = byMint.get(row.token_address) ?? []
      list.push({ hour_bucket: row.hour_bucket, c_min: row.c_min })
      byMint.set(row.token_address, list)
    }
    const series = new Map<string, Array<{ t: number; c: number }>>()
    for (const [mint, rows] of byMint) series.set(mint, expandMinutes(rows))

    for (const row of pending) {
      const collapsed = labelForward(
        row.verdict_at,
        series.get(row.token_address) ?? [],
        RUG_LABEL_DROP,
        windowMinutes,
      )
      if (collapsed == null) {
        result.underivable++
        continue
      }
      await query(
        `UPDATE rug_verdicts
            SET label = $3, label_at = NOW()
          WHERE token_address = $1 AND chain = $2 AND label IS NULL`,
        [row.token_address, row.chain, collapsed ? 'rug' : 'safe'],
      )
      result.labelled++
      if (collapsed) result.collapsed++
    }
    return result
  } catch {
    return result
  }
}

/**
 * The training set: labelled verdicts only, and **never `no_bars`**.
 *
 * A `no_bars` verdict is the absence of a judgement; feeding it in as a `pass` is how a precision
 * figure becomes fiction, and it is the single easiest mistake to make from the consumer side. The
 * exclusion lives here rather than in a comment on the table.
 */
export async function loadLabelledRugVerdicts(limit = 1000): Promise<RugVerdictRow[]> {
  const rows = await loadRugVerdicts(limit)
  return rows.filter((r) => r.label != null && r.decision !== 'no_bars')
}
