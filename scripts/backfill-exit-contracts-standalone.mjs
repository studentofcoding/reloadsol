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

/**
 * `--strategy-hours=id:hours,id:hours`
 *
 * An explicit override for a strategy whose DB config carries no `exit` block. Never inferred from a
 * strategy id — parsing an `h48` suffix to decide when to force an exit is the exact guess the column
 * exists to remove, so the value has to be stated.
 */
export function parseStrategyHours(argv) {
  const arg = argv.find((a) => a.startsWith('--strategy-hours='))
  if (!arg) return {}
  const out = {}
  for (const pair of arg.slice('--strategy-hours='.length).split(',')) {
    const [id, hours] = pair.split(':')
    const n = Number(hours)
    if (id && Number.isFinite(n) && n > 0) out[id.trim()] = n
  }
  return out
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

/**
 * Decide which ACTIVE rows need a max-hold backstop stamped.
 *
 * Two deliberate restrictions:
 *
 *   * **Active only.** A closed row is not going to time out, so stamping one there is churn with no
 *     effect — and it would be a guess about a trade that already ended, which is worse than silence.
 *
 *   * **The strategy's BASE value.** The effective (cl/brain-adjusted) value at that row's open was
 *     never recorded, so it is not recoverable. A base-derived backstop is the loosest, which means
 *     it can only ever fire LATER than the trade's true backstop would have — never earlier. Late is
 *     a slow cleanup; early would be a wrong exit, and that is the direction that matters.
 *
 * A strategy with no resolvable value is REPORTED, never guessed. The DB config is incomplete — it
 * has no `exit` block for `mcap_enter_at_80` at all — so the caller may pass an explicit override
 * rather than this inventing one.
 */
export function planBackstopBackfill(rows, hoursByStrategy) {
  const updates = []
  const unresolvable = []
  const stats = { total: rows.length, stampable: 0, unresolvedStrategy: 0 }

  for (const r of rows) {
    const resolved = hoursByStrategy[r.strategy_id]
    const hours = Number(resolved)
    if (resolved == null || !Number.isFinite(hours) || hours <= 0) {
      stats.unresolvedStrategy += 1
      unresolvable.push({
        id: r.id,
        strategy_id: r.strategy_id,
        reason: 'max_hold_hours not resolvable for this strategy',
      })
      continue
    }
    stats.stampable += 1
    updates.push({ id: r.id, max_hold_hours: hours })
  }

  return { updates, unresolvable, stats }
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

/** ACTIVE rows with no backstop — the ones that can currently stay open forever. */
const SELECT_BACKSTOP_SQL = `
  SELECT id, strategy_id, chain, token_symbol, max_hold_hours
    FROM sl_tp_positions
   WHERE is_active = true AND max_hold_hours IS NULL
   ORDER BY created_at ASC`

/** The authoritative backstop per strategy, where the DB config has one. */
const SELECT_STRATEGY_EXITS_SQL = `
  SELECT id, config->'exit'->>'maxHoldHours' AS max_hold_hours
    FROM strategy_definitions`

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
    const contract = planContractBackfill(rows)

    console.log('')
    console.log(
      `[contract] selected: ${contract.stats.total} · already contracted: ${contract.stats.alreadyContracted} · ` +
        `derivable: ${contract.stats.derivable}`,
    )
    console.log(
      `[contract] underivable (left untouched): ${contract.underivable.length} ` +
        `[entry_price<=0: ${contract.stats.entryPriceNotPositive} · no stop: ${contract.stats.missingThresholds}]`,
    )
    for (const u of contract.underivable.slice(0, 8)) {
      console.log(`  ${u.reason}: ${u.strategy_id} entry_price=${u.entry_price}`)
    }
    if (contract.updates.length) {
      const byStrategy = new Map()
      for (const u of contract.updates) {
        const row = rows.find((r) => r.id === u.id)
        const key = `${row?.strategy_id ?? '(none)'} · ${row?.chain ?? '?'}`
        byStrategy.set(key, (byStrategy.get(key) ?? 0) + 1)
      }
      console.log(
        `[contract] planned: reference_kind='price', reference_value=entry_price, exit_basis='price'`,
      )
      for (const [key, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key}: ${n}`)
      }
    }

    // --- the max-hold backstop on ACTIVE rows (Item 1) ---
    const { rows: backstopRows } = await client.query(SELECT_BACKSTOP_SQL)
    const { rows: strategyExits } = await client.query(SELECT_STRATEGY_EXITS_SQL)
    const hoursByStrategy = {}
    for (const s of strategyExits) {
      if (s.max_hold_hours != null) hoursByStrategy[s.id] = Number(s.max_hold_hours)
    }
    Object.assign(hoursByStrategy, parseStrategyHours(process.argv))

    const backstop = planBackstopBackfill(backstopRows, hoursByStrategy)

    console.log('')
    console.log(
      `[backstop] ACTIVE rows with no backstop: ${backstop.stats.total} · ` +
        `stampable: ${backstop.stats.stampable} · unresolved strategy: ${backstop.stats.unresolvedStrategy}`,
    )
    const unresolved = new Map()
    for (const u of backstop.unresolvable) {
      unresolved.set(u.strategy_id, (unresolved.get(u.strategy_id) ?? 0) + 1)
    }
    for (const [id, n] of [...unresolved].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  UNRESOLVED ${id}: ${n} row(s) — pass --strategy-hours=${id}:<hours> to stamp, or leave them open`,
      )
    }
    if (backstop.updates.length) {
      const bsBy = new Map()
      for (const u of backstop.updates) {
        const row = backstopRows.find((r) => r.id === u.id)
        const key = `${row?.strategy_id ?? '(none)'} → ${u.max_hold_hours}h`
        bsBy.set(key, (bsBy.get(key) ?? 0) + 1)
      }
      console.log('[backstop] planned (strategy BASE, so it can only fire later than the true one):')
      for (const [key, n] of [...bsBy].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${key}: ${n}`)
      }
    }

    if (!contract.updates.length && !backstop.updates.length) {
      console.log('')
      console.log('nothing to do — every selected row is already settled or underivable.')
      return
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
      JSON.stringify(
        {
          at: new Date().toISOString(),
          contract: contract.updates.map((u) => {
            const row = rows.find((r) => r.id === u.id)
            return {
              id: u.id,
              before: {
                reference_kind: row?.reference_kind ?? null,
                reference_value: row?.reference_value ?? null,
                exit_basis: row?.exit_basis ?? null,
              },
            }
          }),
          backstop: backstop.updates.map((u) => ({ id: u.id, before: { max_hold_hours: null } })),
        },
        null,
        2,
      ),
    )
    console.log('')
    console.log(
      `before-image written: ${backupPath} ` +
        `(contract ${contract.updates.length}, backstop ${backstop.updates.length})`,
    )

    let written = 0
    for (let i = 0; i < contract.updates.length; i += BATCH) {
      const slice = contract.updates.slice(i, i + BATCH)
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
    if (contract.updates.length) console.log(`applied ${written} contract(s)`)

    let writtenHold = 0
    for (let i = 0; i < backstop.updates.length; i += BATCH) {
      const slice = backstop.updates.slice(i, i + BATCH)
      const res = await client.query(
        `UPDATE sl_tp_positions p
            SET max_hold_hours = v.hours
           FROM unnest($1::uuid[], $2::numeric[]) AS v(id, hours)
          WHERE p.id = v.id`,
        [slice.map((u) => u.id), slice.map((u) => u.max_hold_hours)],
      )
      writtenHold += res.rowCount ?? 0
    }
    if (backstop.updates.length) console.log(`applied ${writtenHold} backstop(s)`)

    console.log('')
    await summary(client, 'after')
    const { rows: rerun } = await client.query(SELECT_SQL)
    const { rows: rerunBackstop } = await client.query(SELECT_BACKSTOP_SQL)
    console.log(
      `re-run would select: contract ${rerun.length} / backstop ${rerunBackstop.length} ` +
        `— 0 and 0 means the write is idempotent`,
    )
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
