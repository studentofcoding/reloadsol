#!/usr/bin/env npx tsx
/**
 * Backfill auto ML labels (skip/interesting + training_class 0–4) on strategy_outcomes.
 *
 * Run:
 *   npx tsx scripts/backfill-ml-labels.ts [--dry-run] [--domain=trending_bot] [--strategy-id=att]
 *   npm run ml:backfill-labels -- --dry-run
 */

import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error('❌ Missing Supabase environment variables')
  console.error('   SUPABASE_URL')
  console.error('   SUPABASE_SECRET_KEY')
  process.exit(1)
}

type CliArgs = {
  dryRun: boolean
  domain?: string
  strategyId?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false }
  for (const arg of argv) {
    if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg.startsWith('--domain=')) {
      args.domain = arg.slice('--domain='.length)
    } else if (arg.startsWith('--strategy-id=')) {
      args.strategyId = arg.slice('--strategy-id='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npx tsx scripts/backfill-ml-labels.ts [options]

Options:
  --dry-run              Preview class counts without writing
  --domain=DOMAIN        Filter by strategy domain (e.g. trending_bot)
  --strategy-id=ID       Filter by strategy id (e.g. att)
  -h, --help             Show this help
`)
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return args
}

async function main(): Promise<void> {
  const { backfillOutcomeLabels } = await import('../src/strategies/db')
  const args = parseArgs(process.argv.slice(2))

  console.log('Backfill ML labels on strategy_outcomes')
  if (args.domain) console.log(`  domain: ${args.domain}`)
  if (args.strategyId) console.log(`  strategy_id: ${args.strategyId}`)
  console.log(`  mode: ${args.dryRun ? 'dry-run (preview only)' : 'persist'}`)
  console.log('')

  const result = await backfillOutcomeLabels({
    domain: args.domain as import('../src/strategies/types').StrategyDomain | undefined,
    strategyId: args.strategyId,
    dryRun: args.dryRun,
  })

  console.log('Preview (class counts):')
  console.log(`  class_0 (skip):        ${result.preview['0']}`)
  console.log(`  class_1 (20–50%):    ${result.preview['1']}`)
  console.log(`  class_2 (50–100%):   ${result.preview['2']}`)
  console.log(`  class_3 (100–300%):  ${result.preview['3']}`)
  console.log(`  class_4 (≥300%):     ${result.preview['4']}`)
  console.log(`  unclassified:        ${result.preview.null}`)
  console.log('')
  console.log(`Skipped (ml_manual): ${result.skipped_manual}`)
  if (args.dryRun) {
    console.log('Dry run — no rows updated. Re-run without --dry-run to persist.')
  } else {
    console.log(`Updated: ${result.updated}`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
