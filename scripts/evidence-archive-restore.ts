#!/usr/bin/env npx tsx
/**
 * Read / verify / replay the R2 evidence archive (SPEC-evidence-bar-archive-v1). READ-ONLY by default.
 *
 *   npx tsx scripts/evidence-archive-restore.ts list    [--day=YYYY-MM-DD]
 *   npx tsx scripts/evidence-archive-restore.ts verify  --day=YYYY-MM-DD
 *   npx tsx scripts/evidence-archive-restore.ts replay  --dataset=token_ohlc_bars --day=YYYY-MM-DD \
 *        [--mint=<addr>] [--from=<iso>] [--to=<iso>] [--limit=N] [--out=bars.ndjson]
 *   npx tsx scripts/evidence-archive-restore.ts restore-bars --day=YYYY-MM-DD --yes     # writes Postgres
 *
 * Source: R2 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET [, R2_ARCHIVE_PREFIX])
 * or a local mirror of the bucket with `--dir=/path/to/bucket-root`.
 *
 * `restore-bars` is the only writer: INSERT ... ON CONFLICT DO NOTHING into token_ohlc_bars (the
 * (token_address, interval, timestamp) unique key), needs DATABASE_URL(_DIRECT) and an explicit `--yes`.
 * It never updates existing rows, so replaying a day over a live table is a no-op for bars still there.
 */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'
import { promises as fs, createWriteStream } from 'fs'
import { join } from 'path'
import { createR2Store, r2ConfigFromEnv, r2MissingEnv, type ObjectStore } from '../src/utils/r2-store'
import {
  listManifests,
  readManifest,
  replayRows,
  verifyObject,
} from '../src/strategies/evidence-archive-reader'
import { sha256Hex } from '../src/utils/s3-sigv4'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

function dirStore(root: string): ObjectStore {
  return {
    async putIfAbsent() {
      throw new Error('local directory store is read-only')
    },
    async head(key) {
      try {
        const b = await fs.readFile(join(root, key))
        return { size: b.length, sha256: sha256Hex(b) }
      } catch {
        return null
      }
    },
    async get(key) {
      try {
        return await fs.readFile(join(root, key))
      } catch {
        return null
      }
    },
    async list(prefix) {
      const out: string[] = []
      async function walk(dir: string): Promise<void> {
        let entries: import('fs').Dirent[] = []
        try {
          entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const p = join(dir, e.name)
          if (e.isDirectory()) await walk(p)
          else {
            const key = p.slice(root.length + 1)
            if (key.startsWith(prefix)) out.push(key)
          }
        }
      }
      await walk(root)
      return out.sort()
    },
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const prefix = (process.env.R2_ARCHIVE_PREFIX?.trim() || 'reloadsol-evidence/v1').replace(/^\/+|\/+$/g, '')
  const dir = arg('dir')
  let store: ObjectStore
  if (dir) store = dirStore(resolve(dir))
  else {
    const cfg = r2ConfigFromEnv()
    if (!cfg) {
      console.error(`R2 credentials missing; set: ${r2MissingEnv().join(', ')} (or pass --dir=)`)
      process.exit(2)
    }
    store = createR2Store(cfg)
  }
  const day = arg('day')

  if (cmd === 'list') {
    for (const key of await listManifests(store, prefix, day)) {
      const m = await readManifest(store, key)
      console.log(key)
      for (const d of m?.datasets ?? []) {
        console.log(`  ${d.dataset.padEnd(24)} ${d.status.padEnd(8)} rows=${d.rows} gz=${d.bytes_gz} ${d.min_ts ?? ''} .. ${d.max_ts ?? ''}`)
      }
    }
    return
  }

  if (cmd === 'verify') {
    if (!day) throw new Error('--day required')
    let bad = 0
    for (const key of await listManifests(store, prefix, day)) {
      const m = await readManifest(store, key)
      for (const d of m?.datasets ?? []) {
        if (d.status !== 'ok') continue
        const r = await verifyObject(store, d, day)
        console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.dataset} ${day} rows=${r.rows ?? '?'} ${r.problem ?? ''}`)
        if (!r.ok) bad += 1
      }
    }
    process.exit(bad > 0 ? 1 : 0)
  }

  if (cmd === 'replay' || cmd === 'restore-bars') {
    if (!day) throw new Error('--day required')
    const dataset = cmd === 'restore-bars' ? 'token_ohlc_bars' : (arg('dataset') ?? 'token_ohlc_bars')
    const rows = replayRows(store, prefix, dataset, day, {
      mint: arg('mint'),
      fromIso: arg('from'),
      toIso: arg('to'),
      limit: arg('limit') ? Number(arg('limit')) : undefined,
    })
    if (cmd === 'replay') {
      const out = arg('out') ? createWriteStream(arg('out')!) : process.stdout
      for await (const r of rows) out.write(`${JSON.stringify(r)}\n`)
      if (out !== process.stdout) out.end()
      return
    }
    if (!flag('yes')) {
      console.error('restore-bars writes token_ohlc_bars; re-run with --yes to proceed (ON CONFLICT DO NOTHING).')
      process.exit(2)
    }
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL })
    let inserted = 0
    let seen = 0
    let batch: Record<string, unknown>[] = []
    const flush = async () => {
      if (batch.length === 0) return
      const res = await pool.query(
        `INSERT INTO token_ohlc_bars (token_address, interval, open, high, low, close, timestamp, volume, source, samples)
         SELECT token_address, interval, open, high, low, close, timestamp, volume, source, samples
           FROM jsonb_to_recordset($1::jsonb) AS x(token_address text, interval text, open numeric, high numeric,
                low numeric, close numeric, timestamp timestamptz, volume numeric, source text, samples int)
         ON CONFLICT (token_address, interval, timestamp) DO NOTHING`,
        [JSON.stringify(batch)],
      )
      inserted += res.rowCount ?? 0
      batch = []
    }
    for await (const r of rows) {
      seen += 1
      batch.push(r)
      if (batch.length >= 2000) await flush()
    }
    await flush()
    await pool.end()
    console.log(`restore-bars ${day}: read ${seen}, inserted ${inserted}, skipped ${seen - inserted} (already present)`)
    return
  }

  console.error('usage: list | verify --day= | replay --dataset= --day= | restore-bars --day= --yes')
  process.exit(2)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
