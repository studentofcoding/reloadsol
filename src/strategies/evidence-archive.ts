/**
 * Daily evidence archive: Postgres -> append-only gzip NDJSON in Cloudflare R2.
 *
 * Why (map #140, ticket #144): `token_ohlc_bars` is a rolling ~48 h window, so every day of 1m bars
 * that nobody copied out is gone for good, and "reported data must be provable" needs the bars that
 * existed when a position opened. Postgres keeps the working set; the archive is the durable copy.
 *
 * Contract
 *   - One object per (dataset, UTC day): `<prefix>/<dataset>/YYYY/MM/DD/<dataset>-YYYY-MM-DD.ndjson.gz`.
 *   - Written with `If-None-Match: *` — an existing key is NEVER overwritten. A re-run that finds the
 *     key present compares sha256 and records `ok` (identical) or `conflict` (different, loud).
 *   - A per-day manifest (`<prefix>/manifests/YYYY/MM/DD/manifest-<runStamp>.json`) lists every
 *     dataset object with row count, min/max timestamp and sha256 (of the gz bytes and the raw NDJSON).
 *   - Only COMPLETE UTC days are exported (day end + grace hours), so an object is final when written.
 *   - Disabled unless `EVIDENCE_ARCHIVE_ENABLED=1` AND R2 credentials are present (see r2-store.ts).
 *
 * SPEC: docs/specs/SPEC-evidence-bar-archive-v1.md
 */
import { createGzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { sha256Hex } from '@/utils/s3-sigv4'
import type { ObjectStore } from '@/utils/r2-store'

export type KeyColumn = { col: string; sqlType: string }

export type DatasetSpec = {
  name: string
  table: string
  /** Column that defines the UTC day. MUST be keys[0]. */
  dayColumn: string
  /** Total order used for keyset pagination (first = dayColumn). Unique together. */
  keys: KeyColumn[]
  /** Table may not exist yet (sibling PRs add it). Skipped silently when absent. */
  optional?: boolean
}

export const ARCHIVE_DATASETS: readonly DatasetSpec[] = [
  {
    name: 'token_ohlc_bars',
    table: 'token_ohlc_bars',
    dayColumn: 'timestamp',
    keys: [
      { col: 'timestamp', sqlType: 'timestamptz' },
      { col: 'token_address', sqlType: 'text' },
      { col: 'interval', sqlType: 'text' },
    ],
  },
  {
    name: 'token_info_detect',
    table: 'token_info_detect',
    dayColumn: 'created_at',
    keys: [
      { col: 'created_at', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'uuid' },
    ],
  },
  {
    name: 'token_detect_snapshots',
    table: 'token_detect_snapshots',
    dayColumn: 'detected_at',
    keys: [
      { col: 'detected_at', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'uuid' },
    ],
  },
  {
    name: 'strategy_outcomes',
    table: 'strategy_outcomes',
    dayColumn: 'created_at',
    keys: [
      { col: 'created_at', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'uuid' },
    ],
  },
  {
    // Mutable mirror rows: the day object is the state as of archive time for rows last touched that day.
    name: 'sl_tp_positions',
    table: 'sl_tp_positions',
    dayColumn: 'updated_at',
    keys: [
      { col: 'updated_at', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'uuid' },
    ],
  },
  {
    name: 'trading_records',
    table: 'trading_records',
    dayColumn: 'timestamp',
    keys: [
      { col: 'timestamp', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'text' },
    ],
  },
  // Added by the entry-freeze and open-attempts PRs; absent tables are skipped.
  {
    name: 'token_entry_context',
    table: 'token_entry_context',
    dayColumn: 'created_at',
    keys: [
      { col: 'created_at', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'uuid' },
    ],
    optional: true,
  },
  {
    name: 'position_open_attempts',
    table: 'position_open_attempts',
    dayColumn: 'created_at',
    keys: [
      { col: 'created_at', sqlType: 'timestamptz' },
      { col: 'id', sqlType: 'uuid' },
    ],
    optional: true,
  },
]

// ───────────────────────── config ─────────────────────────

export type ArchiveConfig = {
  prefix: string
  graceHours: number
  lookbackDays: number
  maxDaysPerRun: number
  pageSize: number
  maxObjectBytes: number
  datasets: string[] | null
}

type EnvLike = Record<string, string | undefined>

function posInt(env: EnvLike, name: string, fallback: number): number {
  const n = Number(env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function isArchiveEnabled(env: EnvLike = process.env): boolean {
  return env.EVIDENCE_ARCHIVE_ENABLED?.trim() === '1' && env.EVIDENCE_ARCHIVE_KILL_SWITCH?.trim() !== '1'
}

export function archiveConfigFromEnv(env: EnvLike = process.env): ArchiveConfig {
  const datasets = env.EVIDENCE_ARCHIVE_DATASETS?.split(',').map((s) => s.trim()).filter(Boolean)
  return {
    prefix: (env.R2_ARCHIVE_PREFIX?.trim() || 'reloadsol-evidence/v1').replace(/^\/+|\/+$/g, ''),
    graceHours: posInt(env, 'EVIDENCE_ARCHIVE_GRACE_HOURS', 2),
    lookbackDays: posInt(env, 'EVIDENCE_ARCHIVE_LOOKBACK_DAYS', 3),
    maxDaysPerRun: posInt(env, 'EVIDENCE_ARCHIVE_MAX_DAYS_PER_RUN', 3),
    pageSize: posInt(env, 'EVIDENCE_ARCHIVE_PAGE_SIZE', 5000),
    maxObjectBytes: posInt(env, 'EVIDENCE_ARCHIVE_MAX_OBJECT_MB', 128) * 1024 * 1024,
    datasets: datasets && datasets.length > 0 ? datasets : null,
  }
}

// ───────────────────────── pure helpers ─────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000

export function utcDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function dayWindow(day: string): { startIso: string; endIso: string } {
  const start = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(start)) throw new Error(`bad day ${day}`)
  return { startIso: new Date(start).toISOString(), endIso: new Date(start + DAY_MS).toISOString() }
}

/**
 * Complete UTC days that are safe to export now, oldest first: day end + grace <= now, within the
 * lookback, minus `already` (days with a done row), capped at `maxDays`.
 */
export function eligibleDays(opts: {
  nowMs: number
  graceHours: number
  lookbackDays: number
  maxDays: number
  already?: ReadonlySet<string>
}): string[] {
  const lastCompleteEnd = opts.nowMs - opts.graceHours * 3_600_000
  const lastDayStart = Math.floor(lastCompleteEnd / DAY_MS) * DAY_MS - DAY_MS
  const days: string[] = []
  for (let i = opts.lookbackDays - 1; i >= 0; i -= 1) {
    const start = lastDayStart - i * DAY_MS
    if (start + DAY_MS > lastCompleteEnd) continue
    const day = utcDayString(start)
    if (!opts.already?.has(day)) days.push(day)
  }
  return days.slice(0, opts.maxDays)
}

function ymdPath(day: string): string {
  return day.replace(/-/g, '/')
}

export function objectKey(prefix: string, dataset: string, day: string): string {
  return `${prefix}/${dataset}/${ymdPath(day)}/${dataset}-${day}.ndjson.gz`
}

export function manifestKey(prefix: string, day: string, runStamp: string): string {
  return `${prefix}/manifests/${ymdPath(day)}/manifest-${runStamp}.json`
}

export function runStampFor(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

export function buildPageSql(spec: DatasetSpec, hasCursor: boolean, pageSize: number): string {
  const q = (c: string) => `t."${c}"`
  const keyList = spec.keys.map((k) => q(k.col)).join(', ')
  const keySelect = spec.keys.map((k, i) => `${q(k.col)}::text AS k${i}`).join(', ')
  const cursor = hasCursor
    ? ` AND (${keyList}) > (${spec.keys.map((k, i) => `$${i + 3}::${k.sqlType}`).join(', ')})`
    : ''
  return (
    `SELECT to_jsonb(t) AS j, ${keySelect} FROM "${spec.table}" t ` +
    `WHERE ${q(spec.dayColumn)} >= $1::timestamptz AND ${q(spec.dayColumn)} < $2::timestamptz${cursor} ` +
    `ORDER BY ${keyList} LIMIT ${Math.floor(pageSize)}`
  )
}

// ───────────────────────── export ─────────────────────────

export type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>

export type ExportedObject = {
  body: Buffer
  rows: number
  bytesRaw: number
  sha256Gz: string
  sha256Raw: string
  minTs: string | null
  maxTs: string | null
}

export class ObjectTooLargeError extends Error {}

/** Page through one dataset-day and gzip it as NDJSON. Memory is bounded by `maxObjectBytes`. */
export async function exportDatasetDay(
  query: QueryFn,
  spec: DatasetSpec,
  day: string,
  opts: { pageSize: number; maxObjectBytes: number },
): Promise<ExportedObject> {
  const { startIso, endIso } = dayWindow(day)
  const gzip = createGzip({ level: 6 })
  const chunks: Buffer[] = []
  let gzBytes = 0
  gzip.on('data', (c: Buffer) => {
    chunks.push(c)
    gzBytes += c.length
  })
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('end', resolve)
    gzip.on('error', reject)
  })
  const raw = createHash('sha256')
  let rows = 0
  let bytesRaw = 0
  let cursor: string[] | null = null
  let minTs: string | null = null
  let maxTs: string | null = null

  for (;;) {
    const sql = buildPageSql(spec, cursor != null, opts.pageSize)
    const params: unknown[] = cursor ? [startIso, endIso, ...cursor] : [startIso, endIso]
    const { rows: page } = await query<QueryResultRow>(sql, params)
    if (page.length === 0) break
    let text = ''
    for (const r of page) text += `${JSON.stringify(r.j)}\n`
    const buf = Buffer.from(text, 'utf8')
    raw.update(buf)
    bytesRaw += buf.length
    rows += page.length
    if (!gzip.write(buf)) await new Promise((r) => gzip.once('drain', r))
    // gzip emits lazily, so also bound the raw size (NDJSON of these tables compresses < 12x).
    if (gzBytes > opts.maxObjectBytes || bytesRaw > opts.maxObjectBytes * 12) {
      gzip.destroy()
      throw new ObjectTooLargeError(
        `${spec.name} ${day} exceeds ${Math.round(opts.maxObjectBytes / 1048576)} MB gz after ${rows} rows`,
      )
    }
    const first = page[0]
    const last = page[page.length - 1]
    if (minTs == null) minTs = String(first.k0)
    maxTs = String(last.k0)
    cursor = spec.keys.map((_, i) => String(last[`k${i}`]))
    if (page.length < opts.pageSize) break
  }

  gzip.end()
  await done
  const body = Buffer.concat(chunks)
  return {
    body,
    rows,
    bytesRaw,
    sha256Gz: sha256Hex(body),
    sha256Raw: raw.digest('hex'),
    minTs: minTs ? new Date(minTs).toISOString() : null,
    maxTs: maxTs ? new Date(maxTs).toISOString() : null,
  }
}

// ───────────────────────── run ─────────────────────────

export type DatasetResult = {
  dataset: string
  day: string
  status: 'ok' | 'empty' | 'failed' | 'conflict' | 'skipped'
  objectKey?: string
  rows?: number
  bytesGz?: number
  bytesRaw?: number
  sha256Gz?: string
  sha256Raw?: string
  minTs?: string | null
  maxTs?: string | null
  created?: boolean
  detail?: string
}

export type ArchiveSummary = {
  days: string[]
  results: DatasetResult[]
  manifests: string[]
  ok: number
  failed: number
}

type Logger = { info: (m: string, ctx?: unknown) => void; warn: (m: string, ctx?: unknown) => void }

async function tableExists(query: QueryFn, table: string): Promise<boolean> {
  const { rows } = await query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`public.${table}`])
  return rows[0]?.r != null
}

async function doneDays(query: QueryFn, dataset: string, days: string[]): Promise<Set<string>> {
  if (days.length === 0) return new Set()
  const { rows } = await query<{ day: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM evidence_archive_runs
      WHERE dataset = $1 AND status IN ('ok', 'empty') AND day = ANY($2::date[])`,
    [dataset, days],
  )
  return new Set(rows.map((r) => r.day))
}

async function recordRun(query: QueryFn, r: DatasetResult, startedAt: Date, manifest?: string): Promise<void> {
  await query(
    `INSERT INTO evidence_archive_runs
       (dataset, day, status, object_key, manifest_key, row_count, bytes_gz, bytes_raw, sha256, min_ts, max_ts, detail, started_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT DO NOTHING`,
    [
      r.dataset,
      r.day,
      r.status,
      r.objectKey ?? null,
      manifest ?? null,
      r.rows ?? 0,
      r.bytesGz ?? 0,
      r.bytesRaw ?? 0,
      r.sha256Gz ?? null,
      r.minTs ?? null,
      r.maxTs ?? null,
      r.detail ?? null,
      startedAt.toISOString(),
    ],
  )
}

export async function runEvidenceArchive(deps: {
  query: QueryFn
  store: ObjectStore
  now: Date
  config: ArchiveConfig
  log?: Logger
}): Promise<ArchiveSummary> {
  const { query, store, now, config } = deps
  const log = deps.log ?? { info: () => {}, warn: () => {} }
  const specs = ARCHIVE_DATASETS.filter((s) => !config.datasets || config.datasets.includes(s.name))
  const stamp = runStampFor(now)
  const summary: ArchiveSummary = { days: [], results: [], manifests: [], ok: 0, failed: 0 }

  const candidateDays = eligibleDays({
    nowMs: now.getTime(),
    graceHours: config.graceHours,
    lookbackDays: config.lookbackDays,
    maxDays: config.lookbackDays,
  })
  const present: DatasetSpec[] = []
  for (const spec of specs) {
    if (spec.optional && !(await tableExists(query, spec.table))) continue
    present.push(spec)
  }

  // A day is pending while ANY dataset is not done for it; pick the oldest `maxDaysPerRun` such days.
  const pendingByDay = new Map<string, DatasetSpec[]>()
  for (const spec of present) {
    const done = await doneDays(query, spec.name, candidateDays)
    for (const day of candidateDays) {
      if (done.has(day)) continue
      const list = pendingByDay.get(day) ?? []
      list.push(spec)
      pendingByDay.set(day, list)
    }
  }
  summary.days = [...pendingByDay.keys()].sort().slice(0, config.maxDaysPerRun)

  for (const day of summary.days) {
    const dayResults: DatasetResult[] = []
    for (const spec of pendingByDay.get(day) ?? []) {
      const startedAt = new Date()
      let result: DatasetResult
      try {
        const exp = await exportDatasetDay(query, spec, day, config)
        if (exp.rows === 0) {
          result = { dataset: spec.name, day, status: 'empty', rows: 0 }
        } else {
          const key = objectKey(config.prefix, spec.name, day)
          const put = await store.putIfAbsent(key, exp.body, {
            contentType: 'application/gzip',
            sha256: exp.sha256Gz,
          })
          let status: DatasetResult['status'] = 'ok'
          let detail: string | undefined
          if (!put.created) {
            const head = await store.head(key)
            if (head?.sha256 && head.sha256 !== exp.sha256Gz) {
              status = 'conflict'
              detail = `key exists with different sha256 (${head.sha256.slice(0, 12)} != ${exp.sha256Gz.slice(0, 12)}); NOT overwritten`
            } else {
              detail = 'already present (identical or unverifiable sha256)'
            }
          }
          result = {
            dataset: spec.name,
            day,
            status,
            objectKey: key,
            rows: exp.rows,
            bytesGz: exp.body.length,
            bytesRaw: exp.bytesRaw,
            sha256Gz: exp.sha256Gz,
            sha256Raw: exp.sha256Raw,
            minTs: exp.minTs,
            maxTs: exp.maxTs,
            created: put.created,
            detail,
          }
        }
      } catch (error) {
        result = {
          dataset: spec.name,
          day,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
        log.warn('evidence archive dataset failed', { dataset: spec.name, day, error: result.detail })
      }
      dayResults.push(result)
      summary.results.push(result)
      if (result.status === 'ok' || result.status === 'empty') summary.ok += 1
      else summary.failed += 1
      log.info('evidence archive dataset', { ...result })
    }

    const exported = dayResults.filter((r) => r.status === 'ok')
    let manifestObjectKey: string | undefined
    if (exported.length > 0) {
      manifestObjectKey = manifestKey(config.prefix, day, stamp)
      const manifest = {
        version: 1,
        day,
        generated_at: now.toISOString(),
        run: stamp,
        datasets: dayResults.map((r) => ({
          dataset: r.dataset,
          status: r.status,
          object_key: r.objectKey ?? null,
          rows: r.rows ?? 0,
          bytes_gz: r.bytesGz ?? 0,
          bytes_raw: r.bytesRaw ?? 0,
          sha256_gz: r.sha256Gz ?? null,
          sha256_raw: r.sha256Raw ?? null,
          min_ts: r.minTs ?? null,
          max_ts: r.maxTs ?? null,
          detail: r.detail ?? null,
        })),
      }
      const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      try {
        await store.putIfAbsent(manifestObjectKey, body, { contentType: 'application/json' })
        summary.manifests.push(manifestObjectKey)
      } catch (error) {
        log.warn('evidence archive manifest failed', { day, error: String(error) })
        manifestObjectKey = undefined
        summary.failed += 1
      }
    }
    for (const r of dayResults) {
      await recordRun(query, r, new Date(), manifestObjectKey).catch((error) =>
        log.warn('evidence archive ledger write failed', { dataset: r.dataset, day, error: String(error) }),
      )
    }
  }
  return summary
}
