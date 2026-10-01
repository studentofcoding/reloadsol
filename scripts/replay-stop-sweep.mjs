#!/usr/bin/env node
/**
 * Replay the stop sweep — READ-ONLY. Writes nothing, ever.
 *
 * SPEC: docs/specs/SPEC-exit-optimization-v1.md (P4).
 *
 * Why a replay and not a query: the register's "+0.247 SOL from a tighter stop" is an UPPER BOUND obtained by
 * clamping realised losses, which assumes no trade that fell past the stop ever recovered. That assumption is
 * false by construction, so the bound has to be replaced by walking the actual price path.
 *
 * The reading is deliberately RELATIVE. `token_ohlc_bars` is folded from 15s Jupiter spot samples, so a bar's
 * `low` is a *sampled* low and a real wick can be missed — which under-triggers tight stops and flatters them.
 * That bias largely cancels because the baseline is replayed from the SAME bars, so this script:
 *
 *   1. replays the recorded stop first and checks it reproduces the recorded outcome (fidelity), then
 *   2. scores each candidate PAIRED against that replay, never against an absolute.
 *
 * Usage (inside the web container, where DATABASE_URL resolves):
 *   node scripts/replay-stop-sweep.mjs
 *
 * Env:
 *   STOP_SWEEP_CANDIDATES  -16,-20,-25,-31.7   stops to test (percent, negative)
 *   STOP_SWEEP_MIN_BARS    20                  bars a trade needs to be replayable
 *   STOP_SWEEP_WINDOW_DAYS 2                   bounded by OHLC_BARS_RETENTION_HOURS
 *   STOP_SWEEP_ONLY        ''                  strategy_id prefix filter, e.g. search_mcap
 */
import { Client } from 'pg'

const STOPS = (process.env.STOP_SWEEP_CANDIDATES ?? '-16,-20,-25,-31.7')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n < 0)
const MIN_BARS = Number(process.env.STOP_SWEEP_MIN_BARS ?? 20)
const WINDOW_DAYS = Number(process.env.STOP_SWEEP_WINDOW_DAYS ?? 2)
const ONLY = (process.env.STOP_SWEEP_ONLY ?? '').trim()

if (STOPS.length === 0) {
  console.error('no valid STOP_SWEEP_CANDIDATES')
  process.exit(2)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — run inside reloadsol-web')
  process.exit(2)
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** Paired difference clustered by token: one observation per mint, so overlapping trades cannot fake a CI. */
function clusteredCI(pairs) {
  const byCluster = new Map()
  for (const p of pairs) {
    const list = byCluster.get(p.mint)
    if (list) list.push(p.delta)
    else byCluster.set(p.mint, [p.delta])
  }
  const per = [...byCluster.values()].map(mean)
  const n = per.length
  if (n < 2) return { n, point: per.length ? per[0] : 0, lo: NaN, hi: NaN, t: NaN }
  const point = mean(per)
  const sd = Math.sqrt(per.reduce((s, v) => s + (v - point) ** 2, 0) / (n - 1))
  const se = sd / Math.sqrt(n)
  return { n, point, lo: point - 1.96 * se, hi: point + 1.96 * se, t: se > 0 ? point / se : NaN }
}
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—')

const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const { rows: trades } = await db.query(
  `SELECT o.id, o.strategy_id, o.token_address, o.entry_at, o.exit_at,
          o.pnl_pct::float8 AS pnl_pct,
          (o.features->'domain_features'->>'initial_price_usd')::float8 AS entry_price,
          (o.features->'domain_features'->>'cl_stop_loss_pct')::float8 AS recorded_stop
     FROM strategy_outcomes o
    WHERE o.is_simulated
      AND o.exit_at IS NOT NULL
      AND o.entry_at IS NOT NULL
      AND o.exit_at > now() - ($1 || ' days')::interval
      AND ($2 = '' OR o.strategy_id LIKE $2 || '%')`,
  [String(WINDOW_DAYS), ONLY],
)

const { rows: bars } = await db.query(
  `SELECT token_address, timestamp, low, close
     FROM token_ohlc_bars
    WHERE interval = '1m'
      AND timestamp > now() - ($1 || ' days')::interval
    ORDER BY token_address, timestamp`,
  [String(WINDOW_DAYS)],
)
await db.end()

const byMint = new Map()
for (const b of bars) {
  const t = new Date(b.timestamp).getTime()
  const list = byMint.get(b.token_address)
  const row = { t, low: Number(b.low), close: Number(b.close) }
  if (list) list.push(row)
  else byMint.set(b.token_address, [row])
}

const replayable = []
for (const t of trades) {
  const end = new Date(t.exit_at).getTime()
  const path = (byMint.get(t.token_address) ?? []).filter((b) => b.t >= new Date(t.entry_at).getTime() && b.t <= end)
  if (path.length < MIN_BARS) continue
  const entry = Number.isFinite(t.entry_price) && t.entry_price > 0 ? t.entry_price : path[0].close
  if (!(entry > 0)) continue
  replayable.push({ ...t, path, entry })
}

console.log(`\nstop sweep — read-only · window ${WINDOW_DAYS}d · min ${MIN_BARS} bars · ${ONLY || 'all strategies'}`)
console.log(`trades in window ${trades.length} · replayable ${replayable.length} · bars loaded ${bars.length}\n`)

// ---- 0. slippage comparison: did a faster exit check actually tighten the exit? ---------------------
// `--slippage` splits the replayable trades at SLIPPAGE_CUTOFF (the cadence change) and reports, per cohort,
// the one number that measures poll latency: how long AFTER the bar that breached the stop the exit landed.
if (process.argv.includes('--slippage')) {
  const cutoff = new Date(process.env.SLIPPAGE_CUTOFF ?? '2026-10-01T09:14:00Z').getTime()
  const cohorts = { before: [], after: [] }

  for (const t of replayable) {
    const stop = Number.isFinite(t.recorded_stop) && t.recorded_stop < 0 ? t.recorded_stop : -31.7
    const level = t.entry * (1 + stop / 100)
    const breach = t.path.find((b) => b.low > 0 && b.low <= level)
    // The bar that first breached the stop is what a 15-minute poll would have missed entirely.
    const lagSec = breach ? (new Date(t.exit_at).getTime() - breach.t) / 1000 : null
    const row = { lagSec, settled: Math.abs(t.pnl_pct - stop) < 2, overshoot: t.pnl_pct - stop, breached: !!breach, pnl: t.pnl_pct }
    ;(new Date(t.entry_at).getTime() >= cutoff ? cohorts.after : cohorts.before).push(row)
  }

  const q = (xs, p) => {
    if (!xs.length) return NaN
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]
  }
  const line = (label, rows) => {
    const breached = rows.filter((r) => r.breached)
    const lags = breached.map((r) => r.lagSec).filter((v) => Number.isFinite(v) && v >= 0)
    console.log(
      `  ${label.padEnd(9)} trades ${String(rows.length).padStart(4)} · breached ${String(breached.length).padStart(4)}` +
        ` · settled-on-stop ${String(rows.filter((r) => r.settled).length).padStart(4)}` +
        ` · deep tail(<-25%) ${String(rows.filter((r) => r.pnl < -25).length).padStart(4)}` +
        `\n            breach→exit lag sec: p50 ${f(q(lags, 0.5), 0)} · p90 ${f(q(lags, 0.9), 0)} · max ${f(Math.max(...lags), 0)}` +
        ` · overshoot p50 ${f(q(breached.map((r) => r.overshoot), 0.5))}pp · mean PnL ${f(mean(rows.map((r) => r.pnl)))}%`,
    )
  }

  console.log(`slippage by cohort — cutoff ${new Date(cutoff).toISOString()} (the SLTP cadence change)`)
  line('before', cohorts.before)
  line('after', cohorts.after)
  console.log(
    '\n  Success = the after-cohort breach→exit lag p50 collapses toward the new interval, the settled-on-stop\n' +
      '  count rises off its 23/780 baseline, and the deep tail shrinks. Until `after` has a real sample this\n' +
      '  prints an empty row on purpose — do not read a one-sided comparison as a result.\n',
  )
  process.exit(0)
}

// ---- 1. fidelity: does replaying the RECORDED stop reproduce the recorded outcome? -------------------
let agree = 0
let compared = 0
for (const t of replayable) {
  if (!Number.isFinite(t.recorded_stop) || t.recorded_stop >= 0) continue
  const level = t.entry * (1 + t.recorded_stop / 100)
  const hit = t.path.find((b) => b.low > 0 && b.low <= level)
  compared += 1
  // A stopped replay should land within a point of the recorded loss; an unhit path should match the record.
  if (hit ? Math.abs(t.recorded_stop - t.pnl_pct) < 1.5 : Math.abs(t.pnl_pct) > 0) agree += 1
}
console.log(
  `fidelity: replaying each trade's own recorded stop agrees with the recorded outcome on ${agree}/${compared}` +
    ` (${compared ? ((100 * agree) / compared).toFixed(1) : '—'}%) — the bars are the same series the sims read\n`,
)

// ---- 2. stop-hit distribution FIRST, before any PnL summary -----------------------------------------
console.log('stop-hit distribution (how many trades a candidate would have cut short)')
console.log('  candidate   stopped   % of trades   of which were winners')
for (const stop of [...STOPS].sort((a, b) => b - a)) {
  let stopped = 0
  let winnersCut = 0
  for (const t of replayable) {
    const level = t.entry * (1 + stop / 100)
    const hit = t.path.find((b) => b.low > 0 && b.low <= level)
    if (hit) {
      stopped += 1
      if (t.pnl_pct > 0) winnersCut += 1
    }
  }
  const pct = replayable.length ? (100 * stopped) / replayable.length : 0
  console.log(
    `  ${f(stop).padStart(8)}   ${String(stopped).padStart(7)}   ${f(pct).padStart(10)}%   ${String(winnersCut).padStart(18)}`,
  )
}

// ---- 3. paired sweep: every candidate against the as-is replay on the SAME bars ----------------------
const asis = replayable.map((t) => {
  const stop = Number.isFinite(t.recorded_stop) && t.recorded_stop < 0 ? t.recorded_stop : -31.7
  const level = t.entry * (1 + stop / 100)
  const hit = t.path.find((b) => b.low > 0 && b.low <= level)
  return { mint: t.token_address, pnl: hit ? stop : t.pnl_pct }
})

console.log('\npaired sweep — candidate vs as-is, both replayed from the same bars')
console.log('  candidate   sum PnL%   mean/trade   median    worst    Δ sum    Δmean/trade  clustered 95% CI     t     verdict')
const rows = []
for (const stop of [...STOPS].sort((a, b) => b - a)) {
  const cand = replayable.map((t) => {
    const level = t.entry * (1 + stop / 100)
    const hit = t.path.find((b) => b.low > 0 && b.low <= level)
    return { mint: t.token_address, pnl: hit ? stop : t.pnl_pct }
  })
  const pairs = cand.map((c, i) => ({ mint: c.mint, delta: c.pnl - asis[i].pnl }))
  const ci = clusteredCI(pairs)
  const sum = cand.reduce((s, c) => s + c.pnl, 0)
  const asisSum = asis.reduce((s, c) => s + c.pnl, 0)
  const n = cand.length || 1
  const verdict =
    !Number.isFinite(ci.lo) ? 'inconclusive'
    : ci.lo > 0 ? 'better'
    : ci.hi < 0 ? 'worse'
    : 'inconclusive'
  rows.push({ stop, sum, mean: sum / n, median: median(cand.map((c) => c.pnl)), worst: Math.min(...cand.map((c) => c.pnl)), dSum: sum - asisSum, dMean: ci.point, ci, verdict })
  console.log(
    `  ${f(stop).padStart(8)}   ${f(sum, 0).padStart(8)}   ${f(sum / n).padStart(10)}   ${f(median(cand.map((c) => c.pnl))).padStart(7)}   ${f(Math.min(...cand.map((c) => c.pnl))).padStart(7)}   ${f(sum - asisSum, 0).padStart(7)}   ${f(ci.point).padStart(11)}   [${f(ci.lo)}, ${f(ci.hi)}]`.padEnd(24) +
      `   ${f(ci.t, 2).padStart(5)}   ${verdict}`,
  )
}
console.log(
  `\n  as-is baseline: sum ${f(asis.reduce((s, a) => s + a.pnl, 0), 0)}% over ${asis.length} trades` +
    ` (mean ${f(mean(asis.map((a) => a.pnl)))}%)\n`,
)
console.log(
  '  Read the verdict column, not the sum: the bars are sampled, so a tighter stop is flattered and no\n' +
    '  absolute figure here is a result. "better" means the paired difference cleared zero after clustering\n' +
    '  by token. A candidate that wins only by cutting a handful of eventual winners is not a stop, it is luck.\n',
)
