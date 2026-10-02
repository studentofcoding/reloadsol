/**
 * Backfill `rug_signal_shadow.symbol` for rows written before the copier resolved it.
 *
 * The copier hardcoded `symbol: null`, so all of its rows — the bulk of the log — carry no symbol and
 * the dev page can only show a truncated mint. The writer is fixed; this repairs the history so the
 * existing 3,000+ observations are readable.
 *
 * Safety shape, deliberately boring:
 *   * **Dry run by default.** Nothing is written without `--apply`.
 *   * Batched, and idempotent — a second run finds nothing left to do, so it is safe to re-run.
 *   * A backup of the exact (id, symbol) pairs it is about to change is written *before* the update.
 *   * A mint with no known symbol is left NULL. It is never guessed from the address, because a wrong
 *     symbol is worse than an absent one and would be indistinguishable from a real one later.
 *
 * Symbols come from the same two tables the live lookup uses, so the repair and the writer agree.
 *
 * Run: `bash scripts/run-rug-shadow-symbol-backfill-on-vps.sh [--apply]`
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

// `pg` resolves through NODE_PATH inside the web container, which only applies to CJS require.
const require = createRequire(import.meta.url)
const { Client } = require('pg')

const APPLY = process.argv.includes('--apply')
const BATCH = Number(process.env.RUG_SYMBOL_BATCH || 500)

const SYMBOL_SQL = `
  SELECT token_address, MAX(token_symbol) AS token_symbol
    FROM (
      SELECT token_address, token_symbol FROM token_mcap_tracking
       WHERE token_address = ANY($1::text[]) AND token_symbol IS NOT NULL AND token_symbol <> ''
      UNION ALL
      SELECT token_address, token_symbol FROM trending_token_tracker
       WHERE token_address = ANY($1::text[]) AND token_symbol IS NOT NULL AND token_symbol <> ''
    ) s
   GROUP BY token_address`

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const { rows: pending } = await client.query(
      `SELECT id::text AS id, token_address
         FROM rug_signal_shadow
        WHERE symbol IS NULL
        ORDER BY id ASC`,
    )
    console.log(`rows with no symbol: ${pending.length}`)
    if (pending.length === 0) {
      console.log('nothing to do — the writer is already filling them.')
      return
    }

    const byMint = new Map()
    for (const row of pending) {
      const list = byMint.get(row.token_address) ?? []
      list.push(row.id)
      byMint.set(row.token_address, list)
    }
    const mints = [...byMint.keys()]
    console.log(`distinct mints: ${mints.length}`)

    // Resolve every mint in batches so one query never carries the whole watch history.
    const symbols = new Map()
    for (let i = 0; i < mints.length; i += BATCH) {
      const slice = mints.slice(i, i + BATCH)
      const { rows } = await client.query(SYMBOL_SQL, [slice])
      for (const row of rows) if (row.token_symbol) symbols.set(row.token_address, row.token_symbol)
    }

    const updates = []
    for (const [mint, ids] of byMint) {
      const symbol = symbols.get(mint)
      if (!symbol) continue
      for (const id of ids) updates.push({ id, mint, symbol })
    }
    const unresolvable = pending.length - updates.length
    console.log(`resolvable: ${updates.length}   left NULL (unknown symbol): ${unresolvable}`)
    if (updates.length === 0) return

    if (!APPLY) {
      const sample = updates.slice(0, 5).map((u) => `${u.symbol} (${u.mint.slice(0, 8)}…)`)
      console.log(`DRY RUN — nothing written. Sample: ${sample.join(', ')}`)
      console.log('Re-run with --apply to write.')
      return
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `/tmp/rug-shadow-symbol-backup-${stamp}.json`
    writeFileSync(backupPath, JSON.stringify(updates.map((u) => ({ id: u.id, symbol: null })), null, 0))
    console.log(`backup of the ${updates.length} rows being changed: ${backupPath}`)

    let written = 0
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH)
      await client.query(
        `UPDATE rug_signal_shadow AS r
            SET symbol = v.symbol
           FROM (SELECT * FROM unnest($1::text[], $2::text[]) AS t(id, symbol)) v
          WHERE r.id = v.id::bigint AND r.symbol IS NULL`,
        [slice.map((u) => u.id), slice.map((u) => u.symbol)],
      )
      written += slice.length
    }
    console.log(`updated: ${written}`)

    const { rows: after } = await client.query(
      `SELECT COUNT(*)::text AS n FROM rug_signal_shadow WHERE symbol IS NULL`,
    )
    console.log(`rows still without a symbol: ${after[0].n}`)
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('backfill failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
