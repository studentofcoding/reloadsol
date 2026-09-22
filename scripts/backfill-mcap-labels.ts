#!/usr/bin/env npx tsx
/**
 * One-shot soft backfill of token_mcap_tracking labels + OHLC corpus cards.
 *
 * Host CLI needs Postgres via DATABASE_URL or DATABASE_URL_DIRECT
 * (same notes as scripts/backfill-ml-labels.ts).
 *
 *   npx tsx scripts/backfill-mcap-labels.ts [--dry-run]
 *   npm run mcap:backfill-labels -- --dry-run
 *
 * Does not write dlmm_potential_list or token_rug_list.
 * --dry-run: no UPDATE and no OHLC network.
 */

import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

/** Host-side scripts cannot resolve reloadsol-bouncer / reloadsol-db Docker DNS. */
function resolveHostDatabaseUrl(): void {
  const direct = process.env.DATABASE_URL_DIRECT?.trim()
  if (direct) {
    process.env.DATABASE_URL = direct
    return
  }

  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    console.error('Set DATABASE_URL or DATABASE_URL_DIRECT in .env / .env.local')
    process.exit(1)
  }

  if (/reloadsol-(bouncer|db)/.test(url)) {
    try {
      const parsed = new URL(url)
      parsed.hostname = '127.0.0.1'
      process.env.DATABASE_URL = parsed.toString()
      console.log('Host run: using DATABASE_URL via 127.0.0.1 (not Docker service name)')
    } catch {
      console.error('Invalid DATABASE_URL — cannot rewrite for host access')
      process.exit(1)
    }
  }
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  const args = { dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/backfill-mcap-labels.ts [--dry-run]

Soft-overwrites every token_mcap_tracking row with the live auto-label
rules and captures OHLC for potential / rugged (concurrency 3).

  --dry-run   Print counts only. No UPDATE and no OHLC fetch.
`)
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

function printHostDbConnectionHint(err: unknown): void {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : ''
  if (code !== 'ECONNREFUSED' && code !== 'ENOTFOUND') return

  console.error('')
  console.error('Postgres is not reachable on the host.')
  console.error('Set DATABASE_URL_DIRECT, or:')
  console.error('  docker compose -f docker-compose.yml -f docker-compose.migrate.yml up -d reloadsol-db')
  console.error('  then re-run npm run mcap:backfill-labels -- --dry-run')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  resolveHostDatabaseUrl()
  const { MCAP_LABEL_BACKFILL_OHLC_CONCURRENCY, runMcapLabelBackfill } =
    await import('../src/utils/mcap-label-backfill')
  const { query, queryOne } = await import('../src/utils/db')
  const { captureSignalOhlcLabel } = await import('../src/strategies/signal-ohlc-labels')
  const { toSignalOhlcStoreLabel } = await import('../src/strategies/signal-ohlc-window')
  type Snap = import('../src/utils/mcap-tracker').McapSnapshot

  console.log('Backfill mcap tracker labels + OHLC corpus')
  console.log(`  mode: ${args.dryRun ? 'dry-run (no writes)' : 'persist'}`)
  console.log(`  ohlc concurrency: ${MCAP_LABEL_BACKFILL_OHLC_CONCURRENCY}`)
  console.log('')

  const { rows } = await query<Snap>(
    `SELECT * FROM token_mcap_tracking`,
  )

  const counts = await runMcapLabelBackfill({
    rows,
    dryRun: args.dryRun,
    concurrency: MCAP_LABEL_BACKFILL_OHLC_CONCURRENCY,
    updateRow: async (record) => {
      await query(
        `UPDATE token_mcap_tracking SET
           label = $2,
           when_drop_40pct = $3,
           when_drop_80pct = $4,
           peak_mcap = $5,
           peak_growth_percent = $6,
           peak_seen_at = $7
         WHERE token_address = $1 AND chain = $8`,
        [
          record.token_address,
          record.label ?? null,
          record.when_drop_40pct ?? null,
          record.when_drop_80pct ?? null,
          record.peak_mcap ?? null,
          record.peak_growth_percent ?? null,
          record.peak_seen_at ?? null,
          record.chain ?? 'sol',
        ],
      )
    },
    captureOhlc: async (record) => {
      const store = toSignalOhlcStoreLabel(record.label ?? '')
      if (!store) throw new Error(`not a corpus label: ${record.label ?? ''}`)
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM signal_ohlc_labels
         WHERE token_address = $1 AND label = $2
         LIMIT 1`,
        [record.token_address, store],
      )
      if (existing) return 'existing'
      const id = await captureSignalOhlcLabel({
        tokenAddress: record.token_address,
        label: record.label ?? store,
        tokenSymbol: record.token_symbol,
        source: 'mcap_label_backfill',
      })
      if (!id) throw new Error('OHLC capture returned no id')
      return 'captured'
    },
    countOhlcTotals: async () => {
      const { rows: totals } = await query<{ label: string; count: number }>(
        `SELECT label, COUNT(*)::int AS count
         FROM signal_ohlc_labels
         WHERE label IN ('potential', 'rug')
         GROUP BY label`,
      )
      let potential = 0
      let rug = 0
      for (const row of totals) {
        if (row.label === 'potential') potential = row.count
        if (row.label === 'rug') rug = row.count
      }
      return { potential, rug }
    },
  })

  console.log(JSON.stringify(counts, null, 2))
  if (args.dryRun) {
    console.log('Dry run — no rows updated and no OHLC fetches.')
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  printHostDbConnectionHint(err)
  process.exit(1)
})
