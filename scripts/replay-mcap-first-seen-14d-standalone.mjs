#!/usr/bin/env node
/**
 * Self-contained 14d first_seen paper replay (no @/ imports).
 * Run inside reloadsol-web:
 *   NODE_PATH=/app/node_modules node /tmp/replay-mcap-first-seen-14d-standalone.mjs [--dry-run]
 */
let Pool
try {
  ;({ Pool } = await import('pg'))
} catch {
  const { createRequire } = await import('module')
  const { pathToFileURL } = await import('url')
  const require = createRequire(pathToFileURL('/app/package.json'))
  ;({ Pool } = require('/app/node_modules/pg'))
}

const STRATEGY_ID = 'mcap_enter_first_seen'
const DOMAIN = 'mcap_tracker'
const CHAIN = 'sol'
const DAYS = 14
const TP = 200
const SL = -50
const MAX_HOLD_H = 96
const MCAP_MIN = 30_000
const MCAP_MAX = 2_000_000

const dryRun = process.argv.includes('--dry-run')

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
function iso(v) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  return null
}
function band(mcap) {
  if (mcap == null || mcap <= 0) return null
  if (mcap < 50_000) return 'under50k'
  if (mcap <= 100_000) return '51-100k'
  if (mcap <= 200_000) return '101-200k'
  if (mcap <= 500_000) return '201-500k'
  if (mcap <= 1_000_000) return '501k-1M'
  return 'over1M'
}
function peakGrowth(row) {
  const first = num(row.first_mcap)
  const peak = num(row.peak_mcap)
  const stored = num(row.peak_growth_percent)
  const fromRatio =
    first != null && first > 0 && peak != null && peak > 0
      ? (peak / first - 1) * 100
      : null
  if (fromRatio != null && stored != null) return Math.max(fromRatio, stored)
  return fromRatio ?? stored
}
function hoursBetween(a, b) {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000
}
function trainingClass(pnl, status) {
  if (pnl == null || !Number.isFinite(pnl)) return null
  const won = status === 'won' || pnl >= 0
  if (!won || pnl < 0) return 0
  if (pnl < 20) return 0
  if (pnl < 50) return 1
  if (pnl < 100) return 2
  if (pnl < 300) return 3
  return 4
}
function decide(row, now = Date.now()) {
  const first = num(row.first_mcap)
  const current = num(row.current_mcap)
  const entryAt = iso(row.first_seen_at)
  if (first == null || first <= 0 || !entryAt) return { kind: 'skip', reason: 'no_entry_mcap' }
  if (first < MCAP_MIN || first > MCAP_MAX) return { kind: 'skip', reason: 'out_of_range' }
  const lastUpdated = iso(row.last_updated_at) || iso(row.peak_seen_at) || entryAt
  const growth =
    num(row.mcap_growth_percent) ??
    (current != null && current > 0 ? (current / first - 1) * 100 : 0)
  const peakG = peakGrowth(row)
  const ageHours = (now - Date.parse(entryAt)) / 3_600_000
  const hitTp =
    (peakG != null && peakG >= TP) ||
    (num(row.peak_mcap) != null && first > 0 && num(row.peak_mcap) / first - 1 >= TP / 100)
  if (hitTp) {
    return {
      kind: 'close',
      closeReason: 'take_profit_200',
      exitAt: iso(row.when_reach_200pct) || iso(row.peak_seen_at) || lastUpdated,
      exitMcap: first * (1 + TP / 100),
      pnlPct: TP,
    }
  }
  const deepDrop =
    !!row.when_drop_80pct || growth <= -80 || (peakG != null && peakG >= 80 && growth <= -40)
  const ruggedDeep = row.label === 'rugged' && (growth <= -40 || deepDrop)
  if (growth <= SL || ruggedDeep) {
    const stopMcap = first * (1 + SL / 100)
    const actual = current != null && current > 0 ? current : stopMcap
    const exitMcap = actual <= stopMcap ? actual : stopMcap
    return {
      kind: 'close',
      closeReason: row.label === 'rugged' ? 'label_rugged' : 'stop_loss',
      exitAt: lastUpdated,
      exitMcap,
      pnlPct: ((exitMcap - first) / first) * 100,
    }
  }
  if (ageHours >= MAX_HOLD_H) {
    const exitMcap = current != null && current > 0 ? current : first
    return {
      kind: 'close',
      closeReason: 'max_age',
      exitAt: lastUpdated,
      exitMcap,
      pnlPct: ((exitMcap - first) / first) * 100,
    }
  }
  return { kind: 'open_left', ageHours }
}

function features(row, d) {
  const first = num(row.first_mcap)
  const entryAt = iso(row.first_seen_at)
  const status = d.pnlPct >= 0 ? 'won' : 'lost'
  const tc = trainingClass(d.pnlPct, status)
  const mlLabel = tc === 0 ? 'skip' : tc != null ? 'interesting' : null
  return {
    feature_schema_version: 1,
    mint_address: row.token_address,
    pool_address: null,
    instrument: 'spot_token',
    token_symbol: row.token_symbol,
    entry_template: 'first_seen',
    entry_trigger: 'first_seen',
    first_mcap: first,
    entry_mcap: first,
    entry_mcap_band: band(first),
    first_seen_at: entryAt,
    when_reach_80pct: iso(row.when_reach_80pct),
    when_reach_120pct: iso(row.when_reach_120pct),
    when_reach_200pct: iso(row.when_reach_200pct),
    when_drop_40pct: iso(row.when_drop_40pct),
    when_drop_80pct: iso(row.when_drop_80pct),
    reached_80: !!row.when_reach_80pct,
    reached_120: !!row.when_reach_120pct,
    reached_200: !!row.when_reach_200pct,
    time_to_80_minutes: row.when_reach_80pct
      ? hoursBetween(entryAt, iso(row.when_reach_80pct))
      : null,
    time_to_120_minutes: row.when_reach_120pct
      ? hoursBetween(entryAt, iso(row.when_reach_120pct))
      : null,
    time_to_200_minutes: row.when_reach_200pct
      ? hoursBetween(entryAt, iso(row.when_reach_200pct))
      : null,
    exit_mcap: d.exitMcap,
    mcap_growth_at_exit: d.pnlPct,
    close_reason: d.closeReason,
    peak_mcap: num(row.peak_mcap),
    peak_growth_percent: peakGrowth(row),
    peak_seen_at: iso(row.peak_seen_at),
    label: row.label,
    organic_score: num(row.organic_score),
    top_holders_pct: num(row.top_holders_pct),
    volume_5m: num(row.volume_5m),
    volume_at_entry: num(row.volume_5m),
    replay_backfill: true,
    replay_window: '14d',
    replay_exit_approximation: 'tracking_milestones_no_ohlc',
    training_class: tc,
    ml_label: mlLabel,
    ml_condition: 'new_chart',
    ml_note: `replay_backfill 14d: ${d.closeReason} pnl=${d.pnlPct.toFixed(1)}`,
    domain_features: {
      close_reason: d.closeReason,
      exit_mcap: d.exitMcap,
      mcap_growth_at_exit: d.pnlPct,
      reached_80: !!row.when_reach_80pct,
      reached_120: !!row.when_reach_120pct,
      reached_200: !!row.when_reach_200pct,
      replay_backfill: true,
      replay_window: '14d',
    },
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL required')
    process.exit(1)
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      `SELECT token_address, token_symbol, chain,
              first_mcap, current_mcap, first_seen_at, last_updated_at,
              mcap_growth_percent,
              when_reach_80pct, when_reach_120pct, when_reach_200pct,
              when_drop_40pct, when_drop_80pct,
              peak_mcap, peak_growth_percent, peak_seen_at,
              label, organic_score, top_holders_pct, volume_5m
       FROM token_mcap_tracking
       WHERE COALESCE(chain, 'sol') = $1
         AND first_seen_at >= NOW() - ($2::text || ' days')::interval
         AND first_mcap IS NOT NULL AND first_mcap > 0
       ORDER BY first_seen_at DESC
       LIMIT 5000`,
      [CHAIN, String(DAYS)],
    )

    let inserted = 0
    let skipped = 0
    let openLeft = 0
    const skippedReasons = {}
    const closeReasons = {}
    const sample = []
    const watch = new Set(['BIDDY', 'FLEX', 'CYPHERCAT'])
    const bump = (m, k) => {
      m[k] = (m[k] || 0) + 1
    }

    for (const row of rows) {
      const sym = String(row.token_symbol || '').toUpperCase()
      const want = watch.has(sym) || sample.length < 12

      const exists = await client.query(
        `SELECT id FROM strategy_outcomes
         WHERE strategy_id = $1 AND domain = $2 AND token_address = $3
         LIMIT 1`,
        [STRATEGY_ID, DOMAIN, row.token_address],
      )
      if (exists.rowCount > 0) {
        skipped++
        bump(skippedReasons, 'already_has_outcome')
        if (want)
          sample.push({
            symbol: row.token_symbol,
            mint: row.token_address,
            action: 'skip:already_has_outcome',
          })
        continue
      }

      const action = decide(row)
      if (action.kind === 'skip') {
        skipped++
        bump(skippedReasons, action.reason)
        if (want)
          sample.push({
            symbol: row.token_symbol,
            mint: row.token_address,
            action: `skip:${action.reason}`,
          })
        continue
      }
      if (action.kind === 'open_left') {
        openLeft++
        if (want)
          sample.push({
            symbol: row.token_symbol,
            mint: row.token_address,
            action: `open_left:${action.ageHours.toFixed(1)}h`,
          })
        continue
      }

      bump(closeReasons, action.closeReason)
      if (want)
        sample.push({
          symbol: row.token_symbol,
          mint: row.token_address,
          action: dryRun ? 'would_insert' : 'insert',
          pnlPct: action.pnlPct,
          closeReason: action.closeReason,
        })

      if (dryRun) {
        inserted++
        continue
      }

      const feat = features(row, action)
      const status = action.pnlPct >= 0 ? 'won' : 'lost'
      await client.query(
        `INSERT INTO strategy_outcomes (
           strategy_id, domain, token_address, entry_at, exit_at,
           pnl_pct, status, is_simulated, features, chain
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8::jsonb,$9)`,
        [
          STRATEGY_ID,
          DOMAIN,
          row.token_address,
          iso(row.first_seen_at),
          action.exitAt,
          action.pnlPct,
          status,
          JSON.stringify(feat),
          CHAIN,
        ],
      )
      inserted++
    }

    const report = {
      windowDays: DAYS,
      dryRun,
      candidates: rows.length,
      inserted,
      skipped,
      openLeft,
      skippedReasons,
      closeReasons,
      sample,
      approximation:
        'Milestone exit approx (no OHLC): TP if peak>=+200%; else SL if growth<=-50 or rugged+deep; else max_age@96h; else open_left skip',
    }
    console.log(JSON.stringify(report, null, 2))
    console.log(
      `SUMMARY candidates=${report.candidates} inserted=${report.inserted} skipped=${report.skipped} open_left=${report.openLeft}`,
    )
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
