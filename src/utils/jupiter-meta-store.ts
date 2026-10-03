/**
 * Postgres-backed L2 for Jupiter token metadata (`jupiter_token_meta`).
 *
 * Why it exists: symbol / name / decimals / logo never change once a mint exists, and the
 * organic-score / audit / bonding-curve fields move slowly. Re-asking Jupiter for them on every
 * caller (and again after every web restart) is what burned the keyless quota. This table lets a
 * restarted web process, and any caller that tolerates an old value, skip Jupiter entirely.
 *
 * Fail-open by design: every function swallows DB errors and degrades to "not cached", and a
 * failure parks the store for a minute so a sick database never adds latency to the hot path.
 * Created lazily (`CREATE TABLE IF NOT EXISTS`), the same pattern as `detect-snapshots`.
 */
import { query } from '@/utils/db'

export type StoredJupiterMeta = {
  meta: Record<string, unknown>
  fetchedAtMs: number
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS jupiter_token_meta (
  mint TEXT PRIMARY KEY,
  meta JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jupiter_token_meta_fetched_at ON jupiter_token_meta (fetched_at);
DELETE FROM jupiter_token_meta WHERE fetched_at < NOW() - INTERVAL '30 days';
`

const PARK_MS = 60_000

let ensurePromise: Promise<void> | null = null
let parkedUntilMs = 0

export function jupiterMetaStoreEnabled(): boolean {
  if (process.env.JUPITER_META_DB_CACHE === '0') return false
  return Boolean(process.env.DATABASE_URL?.trim())
}

function park(err: unknown): void {
  parkedUntilMs = Date.now() + PARK_MS
  ensurePromise = null
  console.warn(
    `[jupiter-meta-store] DB cache unavailable for ${PARK_MS / 1000}s: ${err instanceof Error ? err.message : String(err)}`,
  )
}

async function ensure(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = query(ENSURE_SQL).then(() => undefined)
    ensurePromise.catch(() => {
      ensurePromise = null
    })
  }
  return ensurePromise
}

export function __resetJupiterMetaStoreForTests(): void {
  ensurePromise = null
  parkedUntilMs = 0
}

/** Rows for `mints` fetched at or after `minFetchedAtMs`. Never throws. */
export async function loadJupiterMetaRows(
  mints: string[],
  minFetchedAtMs: number,
): Promise<Map<string, StoredJupiterMeta>> {
  const out = new Map<string, StoredJupiterMeta>()
  if (mints.length === 0 || !jupiterMetaStoreEnabled() || Date.now() < parkedUntilMs) return out
  try {
    await ensure()
    const res = await query<{ mint: string; meta: Record<string, unknown>; ms: number }>(
      `SELECT mint, meta, (EXTRACT(EPOCH FROM fetched_at) * 1000)::float8 AS ms
         FROM jupiter_token_meta
        WHERE mint = ANY($1::text[]) AND fetched_at >= to_timestamp($2::float8 / 1000.0)`,
      [mints, minFetchedAtMs],
    )
    for (const r of res.rows) {
      if (r.meta && typeof r.meta === 'object') out.set(r.mint, { meta: r.meta, fetchedAtMs: Number(r.ms) })
    }
  } catch (err) {
    park(err)
  }
  return out
}

/** Upsert metadata rows (one statement). Never throws. */
export async function saveJupiterMetaRows(
  rows: Array<{ mint: string; meta: Record<string, unknown> }>,
): Promise<void> {
  if (rows.length === 0 || !jupiterMetaStoreEnabled() || Date.now() < parkedUntilMs) return
  try {
    await ensure()
    await query(
      `INSERT INTO jupiter_token_meta (mint, meta, fetched_at)
       SELECT e->>'mint', e->'meta', NOW() FROM jsonb_array_elements($1::jsonb) AS e
       ON CONFLICT (mint) DO UPDATE SET meta = EXCLUDED.meta, fetched_at = NOW()`,
      [JSON.stringify(rows)],
    )
  } catch (err) {
    park(err)
  }
}
