/**
 * Read side of the evidence archive: list, verify and replay objects written by evidence-archive.ts.
 * Pure over an `ObjectStore`, so the same code runs against R2 (prod) and a local directory (tests,
 * offline analysis). Read-only: nothing here writes to R2 or Postgres.
 */
import { gunzipSync } from 'node:zlib'
import { sha256Hex } from '@/utils/s3-sigv4'
import type { ObjectStore } from '@/utils/r2-store'
import { manifestKey, objectKey } from '@/strategies/evidence-archive'

export type ManifestDataset = {
  dataset: string
  status: string
  object_key: string | null
  rows: number
  bytes_gz: number
  sha256_gz: string | null
  sha256_raw: string | null
  min_ts: string | null
  max_ts: string | null
}

export type Manifest = { version: number; day: string; generated_at: string; run: string; datasets: ManifestDataset[] }

export async function listManifests(store: ObjectStore, prefix: string, day?: string): Promise<string[]> {
  const base = day ? manifestKey(prefix, day, '').replace(/manifest-\.json$/, '') : `${prefix}/manifests/`
  return (await store.list(base)).filter((k) => /manifest-.*\.json$/.test(k)).sort()
}

export async function readManifest(store: ObjectStore, key: string): Promise<Manifest | null> {
  const buf = await store.get(key)
  return buf ? (JSON.parse(buf.toString('utf8')) as Manifest) : null
}

export type VerifyResult = { dataset: string; day: string; ok: boolean; rows?: number; problem?: string }

/** Download an object, check gz sha256 + row count against the manifest entry. */
export async function verifyObject(
  store: ObjectStore,
  entry: ManifestDataset,
  day: string,
): Promise<VerifyResult> {
  if (!entry.object_key) return { dataset: entry.dataset, day, ok: entry.status === 'empty', problem: entry.status === 'empty' ? undefined : 'no object key' }
  const gz = await store.get(entry.object_key)
  if (!gz) return { dataset: entry.dataset, day, ok: false, problem: 'object missing' }
  if (entry.sha256_gz && sha256Hex(gz) !== entry.sha256_gz) {
    return { dataset: entry.dataset, day, ok: false, problem: 'sha256 mismatch (gz)' }
  }
  const raw = gunzipSync(gz)
  if (entry.sha256_raw && sha256Hex(raw) !== entry.sha256_raw) {
    return { dataset: entry.dataset, day, ok: false, problem: 'sha256 mismatch (raw)' }
  }
  const rows = raw.length === 0 ? 0 : raw.toString('utf8').split('\n').filter(Boolean).length
  if (rows !== entry.rows) return { dataset: entry.dataset, day, ok: false, rows, problem: `row count ${rows} != manifest ${entry.rows}` }
  return { dataset: entry.dataset, day, ok: true, rows }
}

export type ReplayFilter = {
  /** `token_address` for bars / detect rows; matched against `token_address` then `mint`. */
  mint?: string
  /** Inclusive ISO bounds on the dataset's day column (bars: `timestamp`). */
  fromIso?: string
  toIso?: string
  limit?: number
}

/** Stream the rows of one dataset-day, optionally filtered. Rows are the original `to_jsonb(row)`. */
export async function* replayRows(
  store: ObjectStore,
  prefix: string,
  dataset: string,
  day: string,
  filter: ReplayFilter = {},
  tsField = 'timestamp',
): AsyncGenerator<Record<string, unknown>> {
  const gz = await store.get(objectKey(prefix, dataset, day))
  if (!gz) throw new Error(`no archive object for ${dataset} ${day}`)
  let n = 0
  for (const line of gunzipSync(gz).toString('utf8').split('\n')) {
    if (!line) continue
    const row = JSON.parse(line) as Record<string, unknown>
    if (filter.mint && row.token_address !== filter.mint && row.mint !== filter.mint) continue
    const ts = row[tsField] ?? row.created_at ?? row.detected_at
    if (typeof ts === 'string') {
      if (filter.fromIso && Date.parse(ts) < Date.parse(filter.fromIso)) continue
      if (filter.toIso && Date.parse(ts) > Date.parse(filter.toIso)) continue
    }
    yield row
    n += 1
    if (filter.limit && n >= filter.limit) return
  }
}

/** Store backed by a local directory laid out like the bucket (for offline analysis and tests). */
export function createMemoryStore(initial: Record<string, Buffer> = {}): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map(Object.entries(initial))
  return {
    objects,
    async putIfAbsent(key, body) {
      if (objects.has(key)) return { created: false }
      objects.set(key, Buffer.from(body))
      return { created: true }
    },
    async head(key) {
      const b = objects.get(key)
      return b ? { size: b.length, sha256: sha256Hex(b) } : null
    },
    async get(key) {
      return objects.get(key) ?? null
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    },
  }
}
