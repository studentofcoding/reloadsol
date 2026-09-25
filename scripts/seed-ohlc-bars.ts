#!/usr/bin/env npx tsx
/**
 * Seed `token_ohlc_bars` (our own 1m OHLC series) from bar sets we already store,
 * so the Freeview chart is not flat on day 1 for tokens we have previously labelled.
 *
 * Sources (both 1m, both `OhlcRugBar { t,o,h,l,c,v? }`):
 *   - signal_ohlc_labels.bars      (rug / potential / detect captures)
 *   - token_detect_snapshots.bars  (Freeview / concentration detect snapshots)
 *
 * No external dependency — this only re-reads our own Postgres.
 *
 * Host CLI needs Postgres reachable: DATABASE_URL_DIRECT, or
 *   docker compose -f docker-compose.yml -f docker-compose.migrate.yml up -d reloadsol-db
 *   (host 127.0.0.1:5433)
 *
 *   npx tsx scripts/seed-ohlc-bars.ts [--dry-run] [--source=all|labels|detect] [--limit=N]
 *   npm run ohlc:seed-bars -- --dry-run
 */

import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'
import { Pool } from 'pg'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

type Args = { dryRun: boolean; source: 'all' | 'labels' | 'detect'; limit: number }

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, source: 'all', limit: 0 }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else if (arg.startsWith('--source=')) {
      const v = arg.slice('--source='.length)
      if (v === 'all' || v === 'labels' || v === 'detect') args.source = v
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length))
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n)
    }
  }
  return args
}

/** Host runs cannot resolve reloadsol-bouncer / reloadsol-db Docker DNS. */
function databaseUrl(): string {
  const direct = process.env.DATABASE_URL_DIRECT?.trim()
  const url = (direct || process.env.DATABASE_URL || '').trim()
  if (!url) {
    console.error('Set DATABASE_URL or DATABASE_URL_DIRECT in .env / .env.local')
    process.exit(1)
  }
  if (/reloadsol-(bouncer|db)/.test(url)) {
    try {
      const parsed = new URL(url)
      parsed.hostname = '127.0.0.1'
      parsed.port = parsed.port || '5433'
      console.log('Host run: using DATABASE_URL via 127.0.0.1')
      return parsed.toString()
    } catch {
      console.error('Invalid DATABASE_URL — cannot rewrite for host access')
      process.exit(1)
    }
  }
  return url
}

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number | null }

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Same validation the in-app reader applies: finite, positive t/o/h/l/c; optional v. */
function parseBars(raw: unknown): Bar[] {
  if (!Array.isArray(raw)) return []
  const out: Bar[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const t = num(r.t)
    const o = num(r.o)
    const h = num(r.h)
    const l = num(r.l)
    const c = num(r.c)
    if (t == null || o == null || h == null || l == null || c == null) continue
    if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue
    out.push({ t: Math.floor(t), o, h, l, c, v: num(r.v) })
  }
  return out
}

const INSERT_SQL = `
INSERT INTO token_ohlc_bars (
  token_address, interval, open, high, low, close, volume, timestamp, source, samples
)
SELECT x.token_address, '1m', x.o, x.h, x.l, x.c, x.v, to_timestamp(x.t), x.source, 1
  FROM jsonb_to_recordset($1::jsonb) AS x(
    token_address text, o numeric, h numeric, l numeric, c numeric, v numeric,
    t bigint, source text
  )
ON CONFLICT (token_address, interval, timestamp) DO NOTHING
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(
    `Seeding token_ohlc_bars from stored bars (source=${args.source}${args.dryRun ? ', dry-run' : ''})`,
  )

  const jobs: Array<{ source: string; sql: string }> = []
  if (args.source === 'all' || args.source === 'labels') {
    jobs.push({
      source: 'seed:signal_ohlc_labels',
      sql: `SELECT DISTINCT ON (token_address) token_address, bars
              FROM signal_ohlc_labels
             WHERE jsonb_typeof(bars) = 'array' AND jsonb_array_length(bars) > 0
             ORDER BY token_address, created_at DESC`,
    })
  }
  if (args.source === 'all' || args.source === 'detect') {
    jobs.push({
      source: 'seed:detect_snapshot',
      sql: `SELECT DISTINCT ON (token_address) token_address, bars
              FROM token_detect_snapshots
             WHERE jsonb_typeof(bars) = 'array' AND jsonb_array_length(bars) > 0
             ORDER BY token_address, detected_at DESC`,
    })
  }

  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    const records: Array<{
      token_address: string
      t: number
      o: number
      h: number
      l: number
      c: number
      v: number | null
      source: string
    }> = []
    const mints = new Set<string>()

    for (const job of jobs) {
      const { rows } = await pool.query<{ token_address: string; bars: unknown }>(job.sql)
      let used = 0
      for (const row of rows) {
        if (args.limit > 0 && used >= args.limit) break
        const bars = parseBars(row.bars)
        if (bars.length === 0) continue
        used++
        mints.add(row.token_address)
        for (const b of bars) {
          records.push({ token_address: row.token_address, ...b, source: job.source })
        }
      }
      console.log(`  ${job.source}: ${rows.length} token rows -> ${used} mints used`)
    }

    console.log(`Collected ${records.length} bars across ${mints.size} mints`)
    if (args.dryRun) {
      console.log('Dry run — nothing written.')
      return
    }
    if (records.length === 0) {
      console.log('Nothing to seed.')
      return
    }

    const batches = 500
    for (let i = 0; i < records.length; i += batches) {
      await pool.query(INSERT_SQL, [JSON.stringify(records.slice(i, i + batches))])
    }
    console.log(`Seeded ${records.length} bars (existing rows left untouched).`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
