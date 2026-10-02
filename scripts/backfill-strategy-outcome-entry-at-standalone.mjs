#!/usr/bin/env node
/**
 * Backfill `strategy_outcomes.entry_at` so the column identifies a *trade*, not a mint.
 *
 * Why: the trending-sim writers stamp the outcome with the entry metadata of the
 * position they closed, but the entry was read from the mint's FIRST-EVER buy
 * (`openPositionsFor` in src/strategies/trending-bot-rh-sim.ts kept
 * `buyByMint` = first match, and `fetchTradingRecordsForWallet` is
 * `ORDER BY timestamp ASC`). Every later trade of the same mint therefore carried
 * the original `entry_at`, so `(chain, strategy_id, token_address, entry_at)`
 * collapsed e.g. att_rh's 77,319 distinct trades into 1,331 keys. The read-side
 * dedupe (`dedupeStrategyOutcomeRows`) then silently dropped the rest.
 *
 * This mirrors the fixed writer exactly: per mint, walk the strategy's records in
 * ascending time with a full close (`close_position = true`) ending a cycle, and
 * take each cycle's OPENING buy (the earliest buy after the previous close). Each
 * outcome is paired to the close that produced it (nearest close timestamp within
 * --tolerance-seconds) and inherits that cycle's entry. Where the close record is
 * missing entirely (a handful of rows), the entry is derived from the latest buy
 * at or before the exit instead; only rows with neither are left untouched.
 *
 * Only `entry_at` is written. `exit_at`, `pnl_pct`, `status` and `features` are
 * never touched, so a wrong pairing degrades grouping, never P&L.
 *
 * Run inside reloadsol-web (host scripts cannot resolve the Docker DB hostname):
 *   NODE_PATH=/app/node_modules node /tmp/backfill-strategy-outcome-entry-at.mjs [--apply]
 * or via scripts/run-backfill-strategy-outcome-entry-at-on-vps.sh
 *
 * Dry-run is the default and prints the residual collisions the unique index
 * (db/init/45-strategy-outcomes-identity.sql) would still see.
 */
import { pathToFileURL } from 'node:url'

/** Strategies whose entry_at is written from a reconstructed position entry. */
const DEFAULT_STRATEGIES = [
  'att_rh',
  'gmgn_sm_kol_combined',
  'gmgn_smartmoney_default',
  'gmgn_kol_momentum',
  'signals_sell_over_100',
]

const BATCH = 500
/**
 * The outcome is written milliseconds after its close, so a gap beyond this means
 * the close record is missing (not that the close is far away) and the entry is
 * derived from the buy instead — see the fallback in planUpdates.
 */
const DEFAULT_TOLERANCE_MS = 120_000

export function iso(v) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  return null
}

export const msOf = (v) => {
  const i = iso(v)
  return i == null ? null : Date.parse(i)
}

/**
 * Per mint: cycle id = number of full closes strictly before the record, with a
 * close ordered before a buy sharing its instant (so close@T then buy@T ends the
 * old cycle and opens the next). A cycle's entry is its earliest buy.
 *
 * Returns Map<mint, { closes: [{ts}] (ascending), entriesByCycle: Map<cycleId, entryAt> }>.
 * The close at index i in `closes` ends cycle i.
 */
export function cyclesForRecords(records) {
  const byMint = new Map()
  for (const r of records) {
    if (!r.mint) continue
    let m = byMint.get(r.mint)
    if (!m) {
      m = { buys: [], closes: [], entriesByCycle: new Map() }
      byMint.set(r.mint, m)
    }
    if (r.op === 'buy') m.buys.push(r)
    else if (r.isClose) m.closes.push(r)
  }

  for (const m of byMint.values()) {
    m.closes.sort((a, b) => a.ts - b.ts)
    m.buysAsc = [...m.buys].sort((a, b) => a.ts - b.ts)
    const events = [
      ...m.closes.map((c) => ({ ts: c.ts, isClose: true, entryAt: null })),
      ...m.buys.map((b) => ({ ts: b.ts, isClose: false, entryAt: b.entryAt })),
    ].sort((a, b) => a.ts - b.ts || (b.isClose ? 1 : 0) - (a.isClose ? 1 : 0))

    let closesSoFar = 0
    for (const ev of events) {
      if (ev.isClose) {
        closesSoFar += 1
        continue
      }
      if (!m.entriesByCycle.has(closesSoFar)) {
        m.entriesByCycle.set(closesSoFar, ev.entryAt)
      }
    }
  }
  return byMint
}

/** Index of the close nearest `exitTs` within `toleranceMs`, else -1. */
export function nearestCloseIndex(closes, exitTs, toleranceMs = DEFAULT_TOLERANCE_MS) {
  if (!closes.length || exitTs == null) return { index: -1, diff: Infinity }
  let lo = 0
  let hi = closes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (closes[mid].ts < exitTs) lo = mid + 1
    else hi = mid
  }
  let best = -1
  let bestDiff = Infinity
  for (const i of [lo - 1, lo, lo + 1]) {
    if (i < 0 || i >= closes.length) continue
    const d = Math.abs(closes[i].ts - exitTs)
    if (d < bestDiff) {
      bestDiff = d
      best = i
    }
  }
  return { index: bestDiff <= toleranceMs ? best : -1, diff: bestDiff }
}

/**
 * Latest buy at or before `ts` (buysAsc is time-ordered). Used when a close record
 * is missing: the cycle that was open is the one containing that buy, so its entry
 * is still the right answer rather than a guess.
 */
export function lastBuyAtOrBefore(buysAsc, ts) {
  if (!buysAsc?.length || ts == null) return null
  let lo = 0
  let hi = buysAsc.length - 1
  if (buysAsc[0].ts > ts) return null
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (buysAsc[mid].ts <= ts) lo = mid
    else hi = mid - 1
  }
  return buysAsc[lo].entryAt ?? null
}

/** Pure planner: outcome rows + cycles -> the updates to apply. */
export function planUpdates(outcomes, cyclesByMint, toleranceMs = DEFAULT_TOLERANCE_MS) {
  const updates = []
  /** Rows whose true entry cannot be derived, with the reason. */
  const unsolvable = []
  const stats = {
    changed: 0,
    unchanged: 0,
    unmatched: 0,
    noOpeningBuy: 0,
    maxDiff: 0,
    // Pairing quality: the outcome is written right after its close, so anything
    // beyond a few seconds means the close record is missing and the entry is
    // being taken from the wrong cycle.
    diff: { lt1s: 0, s1_60: 0, m1_10: 0, gt10m: 0 },
    fallbackBuy: 0,
    unmatchedSamples: [],
  }
  const bucket = (ms) => {
    if (ms < 1_000) stats.diff.lt1s += 1
    else if (ms < 60_000) stats.diff.s1_60 += 1
    else if (ms < 600_000) stats.diff.m1_10 += 1
    else stats.diff.gt10m += 1
  }

  for (const o of outcomes) {
    const m = cyclesByMint.get(o.token_address)
    const exitTs = msOf(o.exit_at)
    const { index, diff } = m
      ? nearestCloseIndex(m.closes, exitTs, toleranceMs)
      : { index: -1, diff: Infinity }

    let newEntryAt = null
    let matchedClose = false
    if (m && index >= 0) {
      matchedClose = true
      // The close at index i in the ascending closes array ends cycle i.
      newEntryAt = m.entriesByCycle.get(index) ?? null
      if (diff > stats.maxDiff) stats.maxDiff = diff
      bucket(diff)
    } else if (m) {
      // No close in range: the close record is missing, so derive the entry from
      // the buy that opened the cycle still open at exit. Only used when nothing
      // was matched — a matched close with no opening buy must stay untouched
      // (falling back there would return the previous cycle's buy and collide).
      newEntryAt = lastBuyAtOrBefore(m.buysAsc, exitTs)
      if (newEntryAt) stats.fallbackBuy += 1
    }

    if (!newEntryAt) {
      const reason = matchedClose ? 'close_without_opening_buy' : 'no_close_no_buy'
      unsolvable.push({ id: o.id, mint: o.token_address, exit_at: o.exit_at, reason })
      if (matchedClose) stats.noOpeningBuy += 1
      else stats.unmatched += 1
      if (stats.unmatchedSamples.length < 5) {
        stats.unmatchedSamples.push({
          id: o.id,
          mint: o.token_address,
          exit_at: o.exit_at,
          reason,
        })
      }
      continue
    }
    if (iso(o.entry_at) === newEntryAt) {
      stats.unchanged += 1
      continue
    }
    stats.changed += 1
    updates.push({ id: o.id, entry_at: newEntryAt })
  }
  return { updates, unsolvable, stats }
}

async function connect() {
  let Pool
  try {
    ;({ Pool } = await import('pg'))
  } catch {
    const { createRequire } = await import('node:module')
    const require = createRequire(pathToFileURL('/app/package.json'))
    ;({ Pool } = require('/app/node_modules/pg'))
  }
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
}

function parseArgs(argv) {
  const strategyArg = argv.find((a) => a.startsWith('--strategy='))
  const tolArg = argv.find((a) => a.startsWith('--tolerance-seconds='))
  return {
    apply: argv.includes('--apply'),
    // Rows with neither a close nor a prior buy cannot be derived. Setting them to
    // NULL is the honest choice and the partial identity index excludes them;
    // without this flag they keep the stale value and block the index.
    nullUnderivable: argv.includes('--null-underivable'),
    strategies: strategyArg
      ? strategyArg.slice('--strategy='.length).split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_STRATEGIES,
    toleranceMs: tolArg
      ? Number(tolArg.slice('--tolerance-seconds='.length)) * 1000
      : DEFAULT_TOLERANCE_MS,
  }
}

async function reportResidual(client) {
  const { rows } = await client.query(
    `SELECT strategy_id, chain, count(*) AS rows,
            count(DISTINCT (token_address, entry_at)) AS keys,
            count(*) - count(DISTINCT (token_address, entry_at)) AS extra
       FROM strategy_outcomes
      WHERE token_address IS NOT NULL AND entry_at IS NOT NULL
      GROUP BY 1, 2
     HAVING count(*) > count(DISTINCT (token_address, entry_at))
      ORDER BY extra DESC`,
  )
  if (!rows.length) {
    console.log('  none — identity is unique per (chain, strategy_id, token_address, entry_at)')
    return
  }
  for (const r of rows) {
    console.log(`  ${r.strategy_id} (${r.chain}): rows=${r.rows} keys=${r.keys} extra=${r.extra}`)
  }
}

async function main() {
  const { apply, nullUnderivable, strategies, toleranceMs } = parseArgs(process.argv)
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required')
    process.exit(1)
  }

  const pool = await connect()
  const client = await pool.connect()
  try {
    console.log(
      `entry_at backfill — strategies=${strategies.join(',')} ` +
        `mode=${apply ? 'APPLY' : 'dry-run'} tolerance=${toleranceMs / 1000}s`,
    )

    const { rows: recRows } = await client.query(
      `SELECT data->'tokens'->0->>'mintAddress' AS mint,
              (EXTRACT(EPOCH FROM timestamp) * 1000)::bigint AS ts_ms,
              data->>'operationType' AS op,
              (data->>'close_position' = 'true') AS is_close,
              data->'trading_simulation'->>'entry_at' AS entry_at
         FROM trading_records
        WHERE data->>'bot_strategy' = ANY($1)
          AND data->'tokens'->0->>'mintAddress' IS NOT NULL`,
      [strategies],
    )
    const records = recRows.map((r) => ({
      mint: r.mint,
      ts: Number(r.ts_ms),
      op: r.op,
      isClose: r.is_close === true,
      entryAt: iso(r.entry_at),
    }))

    const { rows: outcomes } = await client.query(
      `SELECT id, strategy_id, token_address, entry_at, exit_at
         FROM strategy_outcomes
        WHERE strategy_id = ANY($1) AND token_address IS NOT NULL`,
      [strategies],
    )

    const { updates, unsolvable, stats } = planUpdates(
      outcomes,
      cyclesForRecords(records),
      toleranceMs,
    )

    console.log('')
    console.log(
      `totals: outcomes=${outcomes.length} changed=${stats.changed} unchanged=${stats.unchanged} ` +
        `unmatched=${stats.unmatched} no_opening_buy=${stats.noOpeningBuy} ` +
        `max_close_diff_s=${(stats.maxDiff / 1000).toFixed(3)}`,
    )
    console.log(
      `close pairing diff: <1s=${stats.diff.lt1s} 1-60s=${stats.diff.s1_60} ` +
        `1-10m=${stats.diff.m1_10} >10m=${stats.diff.gt10m}`,
    )
    console.log(`missing close -> derived from buy: ${stats.fallbackBuy}`)
    console.log(
      `unsolvable (entry not derivable): ${unsolvable.length} ` +
        `[no_close_no_buy=${stats.unmatched} close_without_opening_buy=${stats.noOpeningBuy}] ` +
        (nullUnderivable ? '-> entry_at set to NULL' : '-> left untouched (blocks the index)'),
    )
    for (const s of stats.unmatchedSamples) {
      console.log(`  unmatched: ${s.reason} ${s.mint} exit_at=${s.exit_at}`)
    }

    if (!apply) {
      console.log('')
      console.log('dry-run — nothing written.')
      console.log('residual collisions (unique index would still reject these):')
      await reportResidual(client)
      return
    }

    console.log('')
    console.log(`applying ${updates.length} update(s) in batches of ${BATCH}…`)
    let written = 0
    for (let i = 0; i < updates.length; i += BATCH) {
      const slice = updates.slice(i, i + BATCH)
      const res = await client.query(
        `UPDATE strategy_outcomes o
            SET entry_at = v.entry_at
           FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, entry_at)
          WHERE o.id = v.id`,
        [slice.map((u) => u.id), slice.map((u) => u.entry_at)],
      )
      written += res.rowCount ?? 0
    }
    console.log(`applied ${written} update(s)`)

    if (nullUnderivable && unsolvable.length) {
      let nulled = 0
      for (let i = 0; i < unsolvable.length; i += BATCH) {
        const res = await client.query(
          `UPDATE strategy_outcomes SET entry_at = NULL
            WHERE id = ANY($1::uuid[])`,
          [unsolvable.slice(i, i + BATCH).map((u) => u.id)],
        )
        nulled += res.rowCount ?? 0
      }
      console.log(`set entry_at = NULL on ${nulled} unsolvable row(s)`)
    }

    console.log('')
    console.log('post-apply residual collisions:')
    await reportResidual(client)
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
