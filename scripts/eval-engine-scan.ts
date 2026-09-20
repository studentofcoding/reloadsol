#!/usr/bin/env npx tsx
/**
 * One-shot eval-engine candidate scan (same as POST /api/strategies/ml/eval-scan).
 *
 *   EVAL_ENGINE=1 npm run ml:eval-scan -- --dry-run
 *   EVAL_ENGINE=1 npm run ml:eval-scan
 */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

loadEnv({ path: resolve(__dirname, '../.env.local') })
loadEnv({ path: resolve(__dirname, '../.env') })

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const { runEvalScan } = await import('../src/strategies/eval-engine.server')
  const result = await runEvalScan({
    paper: dryRun
      ? { openPaper: async () => ({ ok: true, opened: false, error: 'dry_run' }) }
      : undefined,
  })
  console.log(JSON.stringify(result.summary, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
