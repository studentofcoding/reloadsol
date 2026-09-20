#!/usr/bin/env npx tsx
/**
 * Train the phase-4 closed-loop entry-pattern model from labeled principal outcomes.
 *
 *   npm run ml:backfill-labels -- --principals
 *   npm run ml:train-closed-loop -- --dry-run
 *   npm run ml:train-closed-loop
 *   # then: ML_CLOSED_LOOP=1
 */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

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
    } catch {
      console.error('Invalid DATABASE_URL — cannot rewrite for host access')
      process.exit(1)
    }
  }
}

resolveHostDatabaseUrl()

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const { trainAndPersistClosedLoopModel } = await import(
    '../src/strategies/closed-loop-ml.server'
  )
  const result = await trainAndPersistClosedLoopModel({ dryRun })
  console.log('Closed-loop train')
  console.log(`  used: ${result.used}`)
  console.log(`  skipped unlabeled: ${result.skipped_unlabeled}`)
  console.log(`  skipped not principal: ${result.skipped_not_principal}`)
  console.log(`  model: ${result.model.model_type} ${result.model.version}`)
  console.log(`  metrics: ${JSON.stringify(result.model.metrics)}`)
  if (dryRun) {
    console.log('Dry run — artifact not written')
  } else {
    console.log(`  path: ${result.path}`)
    console.log('Enable with ML_CLOSED_LOOP=1 after reviewing metrics.')
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
