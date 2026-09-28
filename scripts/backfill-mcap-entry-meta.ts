#!/usr/bin/env npx tsx
/**
 * Backfill token_mcap_tracking entry metadata (organic_score, top_holders_pct,
 * volume_5m) for SOL tokens that were tracked without it.
 *
 * Why it is needed: `upsertMcapEntryMeta` is only called from the entry-snapshot
 * path, so a token that is merely *tracked* (never evaluated for an entry) keeps
 * NULL metadata forever. That starves the pattern/ML features that read it.
 *
 * SOL ONLY by design — the Robinhood twins are deliberately unwired, so this
 * refuses any other chain rather than quietly doing half a job. See
 * docs/02-architecture-and-data.md ("Social + Token Info are sol-only by design").
 *
 * Reuses the exact sources and writer the live path uses, so a backfilled row is
 * indistinguishable from one written during a live open:
 *   fetchJupiterEntryHints -> fetchDexScreenerVolumeHints -> upsertMcapEntryMeta
 * Both hint fetchers carry their own rate gates (Jupiter via the shared gate,
 * DexScreener via DEX_MIN_INTERVAL_MS), so a run does not burst upstream.
 *
 *   npx tsx scripts/backfill-mcap-entry-meta.ts [--dry-run] [--since-days=7] [--limit=300]
 *   npm run mcap:backfill-entry-meta -- --since-days=7 --limit=300
 *
 * --limit caps upstream calls per run. Already-filled rows are skipped, so the
 * job is resumable: run it again for the next slice.
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

type CliArgs = { dryRun: boolean; sinceDays: number; limit: number }

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    console.error(`${flag} requires a non-negative integer, got: ${raw}`)
    process.exit(1)
  }
  return n
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, sinceDays: 7, limit: 300 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--since-days') {
      args.sinceDays = positiveInt(argv[++i] ?? '', '--since-days')
    } else if (arg.startsWith('--since-days=')) {
      args.sinceDays = positiveInt(arg.slice('--since-days='.length), '--since-days')
    } else if (arg === '--limit') {
      args.limit = positiveInt(argv[++i] ?? '', '--limit')
    } else if (arg.startsWith('--limit=')) {
      args.limit = positiveInt(arg.slice('--limit='.length), '--limit')
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/backfill-mcap-entry-meta.ts [options]

  --dry-run            Resolve hints but write nothing
  --since-days=N       Only rows first seen within N days (default 7; 0 = all)
  --limit=N            Max rows to attempt per run (default 300)

Sol only: token_mcap_tracking rows on any other chain are never touched.`)
      process.exit(0)
    } else {
      console.error(`Unknown option: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

async function main(): Promise<void> {
  resolveHostDatabaseUrl()
  const args = parseArgs(process.argv.slice(2))

  // Same module the cron-driven route calls, so host runs and API runs cannot drift.
  const { backfillMcapEntryMeta } = await import('../src/strategies/mcap-entry-meta-backfill')

  console.log(
    `mcap entry-meta backfill (sol only): since-days=${args.sinceDays}` +
      ` limit=${args.limit} dry-run=${args.dryRun}`,
  )
  const result = await backfillMcapEntryMeta(args)
  console.log(
    `done: candidates=${result.candidates} filled=${result.filled}` +
      ` empty=${result.empty} failed=${result.failed}` +
      (result.dryRun ? ' (dry-run — nothing written)' : ''),
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
