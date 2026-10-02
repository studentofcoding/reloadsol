#!/usr/bin/env node
/**
 * Backfill the exit contract (S8) onto rows that predate it.
 *
 * Why these rows need a disposition rather than a code fix: `registerSimExitContract` stamps
 * `reference_kind` / `reference_value` / `exit_basis` on EVERY call, and the mcap family is one of
 * its four call sites. So the 149 active (510 lifetime) rows carrying no contract are not a missing
 * registration — they are rows opened BEFORE `db/init/57-sl-tp-exit-contract.sql` existed.
 *
 * The worker already copes: `checkSLTPTriggers` falls back to `reference_value ?? entry_price`. This
 * writes that assumption down. The point is S3 — the row can then DECLARE its basis instead of every
 * caller agreeing on a convention it cannot state. Nothing about how these positions are evaluated
 * changes: `reference_value = entry_price` and `reference_kind = 'price'` is exactly what the
 * evaluator already uses for them.
 *
 * Only `reference_kind`, `reference_value` and `exit_basis` are written. `stop_loss_percentage` and
 * `take_profit_percentage` are already on the row and are left alone, so a wrong derivation cannot
 * move a stop. Rows whose `entry_price` is not a positive number cannot be derived and are LEFT
 * UNTOUCHED and reported — never invented, and never NULLed.
 *
 * Idempotent by construction: the selector only takes rows that are still uncontracted, so a second
 * run plans zero updates. That is the property to check after applying.
 *
 * Run inside reloadsol-web (host scripts cannot resolve the Docker DB hostname):
 *   NODE_PATH=/app/node_modules node /tmp/backfill-exit-contracts-standalone.mjs [--apply]
 * or via scripts/run-backfill-exit-contracts-on-vps.sh
 *
 * `--apply` writes an exact before-image of every row it is about to change to
 * /tmp/exit-contract-backfill-<ts>.json and prints the path, so the change is reversible in full.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const BATCH = 500

/**
 * Decide what each uncontracted row should say about itself.
 *
 * Pure: takes rows, returns the plan. No clock, no I/O — so the rule is unit-testable and the
 * dry-run and the apply cannot disagree.
 */
export function planContractBackfill(rows) {
  const updates = []
  /** Rows whose contract is genuinely not derivable, with the reason. Never invented. */
  const underivable = []
  const stats = {
    total: rows.length,
    alreadyContracted: 0,
    derivable: 0,
    entryPriceNotPositive: 0,
    missingThresholds: 0,
  }

  for (const r of rows) {
    // Idempotency lives here: only a COMPLETE contract is skipped, so a re-run plans nothing.
    //
    // It must be `&&`, matching SELECT_SQL's `OR ... IS NULL`. A row with a basis but no reference
    // value is still uncloseable, so treating "any column set" as contracted would leave it in the
    // selector forever, planned by nothing and skipped by everything — a row the dry-run keeps
    // reporting and the apply never fixes.
    if (
      r.reference_kind != null &&
      r.reference_value != null &&
      r.exit_basis != null
    ) {
      stats.alreadyContracted += 1
      continue
    }

    const entry = Number(r.entry_price)
    if (!Number.isFinite(entry) || entry <= 0) {
      stats.entryPriceNotPositive += 1
      underivable.push({
        id: r.id,
        strategy_id: r.strategy_id,
        reason: 'entry_price_not_positive',
        entry_price: r.entry_price,
      })
      continue
    }

    // Without a usable stop there is nothing for a reference value to be measured against, so
    // stamping one would produce a row that still cannot be evaluated — a contract in shape only.
    const stop = Number(r.stop_loss_percentage)
    if (!Number.isFinite(stop) || stop === 0) {
      stats.missingThresholds += 1
      underivable.push({
        id: r.id,
        strategy_id: r.strategy_id,
        reason: 'stop_loss_percentage_missing',
        stop_loss_percentage: r.stop_loss_percentage,
      })
      continue
    }

    stats.derivable += 1
    updates.push({
      id: r.id,
      reference_kind: 'price',
      reference_value: entry,
      exit_basis: 'price',
    })
  }

  return { updates, underivable, stats }
}

async function connect() {
  let Pool
  try {
    ;({ Pool } = await import('pg'))
  } catch {
    const require = createRequire(pathToFileURL('/app/package.json'))
    ;({ Pool } = require('/app/node_modules/pg'))
  }
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
}

const SELECT_SQL = `
  SELECT id, strategy_id, chain, token_symbol,
         entry_price, stop_loss_percentage, take_profit_percentage,
         reference_kind, reference_value, exit_basis
    FROM sl_tp_positions
   WHERE reference_kind IS NULL
      OR reference_value IS NULL
      OR exit_basis IS NULL
   ORDER BY is_active DESC, created_at ASC`

async function summary(client, label) {
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE is_active) AS active_uncontracted,
            count(*) AS total_uncontracted
       FROM sl_tp_positions
      WHERE reference_kind IS NULL
         OR reference_value IS NULL
         OR exit_basis IS NULL`,
  )
  const r = rows[0] ?? {}
  console.log(`${label}: uncontracted = ${r.total_uncontracted} (active ${r.active_uncontracted})`)
}

async function main() {
  const apply = process.argv.includes('--apply')
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required')
    process.exit(1)
  }

  const pool = await connect()
  const client = await pool.connect()
  try {
    console.log(`exit-contract backfill — mode=${apply ? 'APPLY' : 'dry-run'}`)
    await summary(client, 'before')

    const { rows } = await client.query(SELECT_SQL)
    const { updates, underivable, stats } = planContractBackfill(rows)

    console.log('')
    console.log(
      `rows selected: ${stats.total} · already contracted: ${stats.alreadyContracted} · ` +
        `derivable: ${stats.derivable}`,
    )
    console.log(
      `underivable (left untouched): ${underivable.length} ` +
        `[entry_price<=0: ${stats.entryPriceNotPositive} · no stop: ${stats.missingThresholds}]`,
    )
    for (const u of underivable.slice(0, 8)) {
      console.log(`  ${u.reason}: ${u.strategy_id} entry_price=${u.entry_price}`)
    }

    if (!updates.length) {
      console.log('')
      console.log('nothing to do — every selected row is already contracted or underivable.')
      return
    }

    // Grouped so the dry-run shows the shape of the write, not just a count.
    const byStrategy = new Map()
    for (const u of updates) {
      const row = rows.find((r) => r.id === u.id)
      const key = `${row?.strategy_id ?? '(none)'} · ${row?.chain ?? '?'}`
      byStrategy.set(key, (byStrategy.get(key) ?? 0) + 1)
    }
    console.log('')
    console.log(`planned contract: reference_kind='price', reference_value=entry_price, exit_basis='price'`)
    for (const [key, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key}: ${n}`)
    }

    if (!apply) {
      console.log('')
      console.log('dry-run — nothing written. Re-run with --apply to write.')
      return
    }

    // The before-image, taken BEFORE the write. Every field being changed is currently NULL, so a
    // restore is simply setting them back — but recording the actual values means the rollback does
    // not depend on that being true.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `/tmp/exit-contract-backfill-${stamp}.json`
    writeFileSync(
      backupPath,
      JSON.stringify({ at: new Date().toISOString(), rows: updates.map((u) => {
        const row = rows.find((r) => r.id === u.id)
        return {
          id: u.id,
          before: {
            reference_kind: row?.reference_kind ?? null,
            reference_value: row?.reference_value ?? null,
            exit_basis: row?.exit_basis ?? null,
          },
        }
      }) }, null, 2),
    )
    console.log('')
    console.log(`before-image written: ${backupPath} (${updates.length} rows)`)

    let written = 0
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH)
      // `updated_at` is deliberately NOT written. For a closed legacy row it is both the close-time
      // proxy the summary windows on (COALESCE(closed_at, updated_at)) and the ordering key the
      // worker reads, so touching it would shift already-closed rows into the recent window.
      const res = await client.query(
        `UPDATE sl_tp_positions p
            SET reference_kind = v.kind,
                reference_value = v.value,
                exit_basis = v.basis
           FROM unnest($1::uuid[], $2::text[], $3::double precision[], $4::text[])
             AS v(id, kind, value, basis)
          WHERE p.id = v.id`,
        [
          slice.map((u) => u.id),
          slice.map((u) => u.reference_kind),
          slice.map((u) => u.reference_value),
          slice.map((u) => u.exit_basis),
        ],
      )
      written += res.rowCount ?? 0
    }
    console.log(`applied ${written} contract(s)`)

    console.log('')
    await summary(client, 'after')
    const { rows: rerun } = await client.query(SELECT_SQL)
    console.log(`re-run would select: ${rerun.length} row(s) — 0 means the write is idempotent`)
  } finally {
    client.release()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exit(1)
  })
}
