#!/usr/bin/env npx tsx
/**
 * One-shot soft backfill of token_mcap_tracking labels + OHLC corpus cards.
 *
 * Host CLI needs Postgres via DATABASE_URL or DATABASE_URL_DIRECT
 * (same notes as scripts/backfill-ml-labels.ts).
 *
 *   npx tsx scripts/backfill-mcap-labels.ts [--dry-run] [--sol-only]
 *   npm run mcap:backfill-labels
 *   npm run mcap:backfill-labels -- --dry-run
 *
 * A plain re-run soft-overwrites empty OHLC rows (bars=[], including
 * ohlc_source none and backfill_empty) and captures missing rows.
 * Non-empty gmgn / solanatracker / last10_fallback cards are left alone.
 * Empty fetch does not INSERT (no UNIQUE lock); it counts as ohlc_failed.
 *
 * OHLC concurrency default is 2 (override with MCAP_OHLC_CONCURRENCY).
 * Does not write dlmm_potential_list or token_rug_list.
 * --dry-run: no UPDATE and no OHLC network.
 * --refill-empty: accepted alias; plain run already refills empties.
 * --sol-only: skip 0x / EVM mints (GMGN robinhood path).
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

type CliArgs = {
  dryRun: boolean
  refillEmpty: boolean
  solOnly: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    refillEmpty: false,
    solOnly: false,
  }
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--refill-empty') args.refillEmpty = true
    else if (arg === '--sol-only') args.solOnly = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/backfill-mcap-labels.ts [options]

Soft-overwrites token_mcap_tracking labels with live auto-label rules and
captures OHLC for potential / rugged.

A plain run retries OHLC when the corpus row is missing or bars=[].
backfill_empty / none are refillable. Non-empty cards are skipped.
Failed fetch does not insert an empty row (ohlc_failed).

Options:
  --dry-run        Print counts only. No UPDATE and no OHLC fetch.
  --refill-empty   Explicit alias for the empty/missing OHLC retry.
  --sol-only       Skip 0x EVM mints.

Env:
  MCAP_OHLC_CONCURRENCY   Parallel OHLC fetches (default 2).
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
  const {
    MCAP_LABEL_BACKFILL_OHLC_CONCURRENCY,
    planMcapOhlcCapture,
    runMcapLabelBackfill,
  } = await import('../src/utils/mcap-label-backfill')
  const { query, queryOne } = await import('../src/utils/db')
  const { captureSignalOhlcLabel } = await import(
    '../src/strategies/signal-ohlc-labels'
  )
  const { toSignalOhlcStoreLabel } = await import('../src/strategies/signal-ohlc-window')
  const { isEvmTokenAddress } = await import('../src/utils/gmgn-cli')
  type Snap = import('../src/utils/mcap-tracker').McapSnapshot

  console.log('Backfill mcap tracker labels + OHLC corpus')
  console.log(`  mode: ${args.dryRun ? 'dry-run (no writes)' : 'persist'}`)
  console.log(`  refill-empty: ${args.refillEmpty}`)
  console.log(`  sol-only: ${args.solOnly}`)
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

      const isEvm =
        isEvmTokenAddress(record.token_address) ||
        record.chain === 'robinhood'
      if (args.solOnly && isEvm) {
        return 'skipped_evm'
      }

      const existing = await queryOne<{
        id: string
        bars: unknown
        ohlc_source: string
      }>(
        `SELECT id, bars, ohlc_source FROM signal_ohlc_labels
         WHERE token_address = $1 AND label = $2
         LIMIT 1`,
        [record.token_address, store],
      )

      const ohlcPlan = planMcapOhlcCapture(existing)
      // Non-empty cards stay. Empty (none / backfill_empty / bars=[]) refill
      // on a plain re-run — backfill_empty is not a permanent skip.
      if (ohlcPlan === 'existing') return 'existing'

      const id = await captureSignalOhlcLabel({
        tokenAddress: record.token_address,
        label: record.label ?? store,
        tokenSymbol: record.token_symbol,
        source: 'mcap_label_backfill',
        chain: record.chain ?? (isEvm ? 'robinhood' : 'sol'),
      })
      if (!id) throw new Error('OHLC capture returned no bars / no id')
      return ohlcPlan === 'refill' ? 'refilled' : 'captured'
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
