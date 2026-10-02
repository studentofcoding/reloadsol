/**
 * Rug-signal validation harness — read-only.
 *
 * Answers one question: **does the shipped trip rule actually precede a collapse more often than the
 * base rate?** The verdicts come from `rug_signal_shadow` (written by the real code on every
 * evaluation, trips and non-trips alike), and the label is derived independently from the market-cap
 * candles — so the test is not graded by the thing being tested.
 *
 * Design points that matter:
 *   * **The trip is the scorer's own verdict, read from `decision`.** This file used to re-derive it
 *     as `score >= threshold`, which was a second implementation of the scorer — and a wrong one: the
 *     score path never reached its threshold, so it reported `trips: 0` forever while the core-pair
 *     path was tripping. Anything re-derived here is labelled `retroactive` and reported separately.
 *   * **The label looks forward from the evaluation**, not backward. A rug card's own window ends
 *     *in* the dump, which is why the labelled corpus could never validate a pre-dump signal.
 *   * **Unlabellable rows are counted, not dropped.** A row whose token has no candles after it is
 *     not a negative — it is unknown, and silently treating it as one is how a precision figure
 *     becomes fiction.
 *   * **`inconclusive` is a verdict.** The floor is applied to the *trip* denominator too: `0/0` is
 *     not "precision 0%", and printing a confident "no lift" from it is the error this guards.
 *   * **Days must agree.** A pooled number can hide one good day; the acceptance rule is agreement
 *     across days, per the SPEC.
 *
 * Run: `bash scripts/run-rug-signal-validate-on-vps.sh [days]` (or `node` inside the web container).
 *
 * Plain JS on purpose: it executes inside the production web container, which ships no TypeScript
 * toolchain. Types here would be a syntax error, not documentation.
 */
import { createRequire } from 'node:module'

// `pg` resolves through NODE_PATH inside the web container, which only applies to CJS require —
// ESM bare imports resolve from the *file's* directory tree, and this file lives in /tmp.
const require = createRequire(import.meta.url)
const { Client } = require('pg')

const DAYS = Number(process.argv[2] || 3)
const EVENT_DROP = Number(process.env.RUG_EVENT_DROP || 0.6)
const EVENT_WINDOW_MIN = Number(process.env.RUG_EVENT_WINDOW || 30)
const MIN_LABELLED = Number(process.env.RUG_VALIDATE_MIN_ROWS || 30)
const MIN_POSITIVES = Number(process.env.RUG_VALIDATE_MIN_POSITIVES || 5)
/** Fewer 5m bars than this and the scorer could not judge the shape — an unknown, not a negative. */
const MIN_BARS = Number(process.env.RUG_SIG_MIN_BARS || 5)
/** The shipped core-pair rule, for the retroactive view. Must mirror `rug-signal.ts`. */
const CORE_THRESHOLD = Number(process.env.RUG_SIG_CORE_THRESHOLD || 40)
const CORE_MIN_LIQ = Number(process.env.RUG_SIG_CORE_MIN_LIQ || 10)
/** Candidate operating points, so the threshold is chosen from data instead of re-guessed. */
const CORE_CANDIDATES = (process.env.RUG_VALIDATE_CORE_CANDIDATES || '46,40,35,30,25')
  .split(',')
  .map(Number)
  .filter(Number.isFinite)

/** Raw liquidity-to-mcap ratio buckets. Thin liquidity is the hypothesis under test. */
const LIQ_BUCKETS = [
  { label: '< 2%', lo: 0, hi: 0.02 },
  { label: '2–5%', lo: 0.02, hi: 0.05 },
  { label: '5–10%', lo: 0.05, hi: 0.1 },
  { label: '≥ 10%', lo: 0.1, hi: Infinity },
]

/** Minute closes for a token: [{t, c}], ascending, from the market-cap candle arrays. */
function expandCloses(rows) {
  const out = []
  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs) || !Array.isArray(row.c_min)) continue
    for (let i = 0; i < row.c_min.length; i++) {
      const c = row.c_min[i]
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        out.push({ t: Math.floor((hourMs + i * 60_000) / 1000), c })
      }
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Wilson score interval — honest at small n, which is exactly where this starts. */
function wilson(successes, n) {
  if (n === 0) return { lo: 0, hi: 1 }
  const z = 1.96
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return {
    lo: Math.max(0, (centre - spread) / denominator),
    hi: Math.min(1, (centre + spread) / denominator),
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`

/** A cell is a result only once it has enough n; below that it says so out loud. */
function rateCell(hits, n) {
  if (n === 0) return 'n/a (no rows)'
  const ci = wilson(hits, n)
  const note = n < MIN_POSITIVES ? `  inconclusive, n<${MIN_POSITIVES}` : ''
  return `${pct(hits / n)} [${pct(ci.lo)}, ${pct(ci.hi)}] (${hits}/${n})${note}`
}

function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const { rows: shadowAll } = await client.query(
      `SELECT token_address, created_at::text, score, decision, bars_source, bars_scored,
              breakdown, mcap, liquidity_usd
         FROM rug_signal_shadow
        WHERE created_at > NOW() - make_interval(days => $1::int)
        ORDER BY created_at ASC`,
      [DAYS],
    )
    console.log(`shadow rows (last ${DAYS}d): ${shadowAll.length}`)
    if (shadowAll.length === 0) {
      console.log('')
      console.log(
        'VERDICT: inconclusive — no shadow rows yet. Arm the detector in shadow ' +
          '(RUG_SIGNAL_ENABLED=1, RUG_SIGNAL_MODE=shadow) and let the sweep run.',
      )
      return
    }

    // A row the scorer could not judge must never enter a denominator: its 0 is the absence of a
    // measurement, not a measured negative. Excluded rows are counted out loud, never dropped.
    const shadow = shadowAll.filter((r) => Number(r.bars_scored) >= MIN_BARS)
    const unjudged = shadowAll.length - shadow.length
    console.log(
      `judged for scoring: ${shadow.length}   excluded, too few 5m bars (<${MIN_BARS}): ${unjudged}`,
    )

    const byDecision = shadowAll.reduce((acc, r) => {
      acc[r.decision] = (acc[r.decision] ?? 0) + 1
      return acc
    }, {})
    const byBarsSource = shadowAll.reduce((acc, r) => {
      acc[r.bars_source] = (acc[r.bars_source] ?? 0) + 1
      return acc
    }, {})
    console.log(`decisions (all rows): ${JSON.stringify(byDecision)}`)
    console.log(`bars sources: ${JSON.stringify(byBarsSource)}`)

    // Label each row by looking FORWARD from its own timestamp.
    const tokens = [...new Set(shadow.map((r) => r.token_address))]
    const closes = new Map()
    for (const token of tokens) {
      const { rows } = await client.query(
        `SELECT hour_bucket::text, c_min
           FROM token_metrics_history
          WHERE token_address = $1 AND hour_bucket > NOW() - make_interval(days => $2::int)
          ORDER BY hour_bucket ASC`,
        [token, Math.max(DAYS, 2)],
      )
      closes.set(token, expandCloses(rows))
    }

    const labelled = []
    let unlabellable = 0
    let noLiquidity = 0
    const windowSec = EVENT_WINDOW_MIN * 60
    for (const row of shadow) {
      if (row.score == null) continue
      const series = closes.get(row.token_address) ?? []
      const at = Math.floor(Date.parse(row.created_at) / 1000)
      let baseline = null
      let trough = null
      for (const point of series) {
        if (point.t <= at) baseline = point.c
        else if (point.t <= at + windowSec) trough = trough == null ? point.c : Math.min(trough, point.c)
      }
      if (baseline == null || trough == null) {
        unlabellable++
        continue
      }
      const breakdown = row.breakdown ?? {}
      const staircase = num(breakdown.staircase) ?? 0
      const liquidity = num(breakdown.liquidity) ?? 0
      const mcap = num(row.mcap)
      const liquidityUsd = num(row.liquidity_usd)
      const liqRatio =
        mcap != null && mcap > 0 && liquidityUsd != null && liquidityUsd >= 0
          ? liquidityUsd / mcap
          : null
      if (liqRatio == null) noLiquidity++
      labelled.push({
        row,
        staircase,
        liquidity,
        core: staircase + liquidity,
        liqRatio,
        // The scorer's verdict as stored — the shipped rule, not a second implementation of it.
        trippedShipped: row.decision === 'would_rug',
        // The current rule re-applied to the stored features: lets an operating point be evaluated
        // now rather than waited for. Always reported separately, always labelled retroactive.
        trippedRetroactive: staircase + liquidity >= CORE_THRESHOLD && liquidity >= CORE_MIN_LIQ,
        collapsed: (baseline - trough) / baseline >= EVENT_DROP,
        dayKey: row.created_at.slice(0, 10),
      })
    }

    console.log('')
    console.log(`labelled rows: ${labelled.length}  (unlabellable, no candles after the row: ${unlabellable})`)
    if (labelled.length === 0) {
      console.log('')
      console.log(
        `VERDICT: inconclusive — nothing labellable yet (${unlabellable} rows have no market-cap ` +
          'candles after their timestamp). This is the expected state right after arming: the label ' +
          `needs ${EVENT_WINDOW_MIN} minutes of forward candles per row.`,
      )
      return
    }

    // Rows are not independent: the same mint is re-evaluated every sweep, so 22 rows can be three
    // mints seen eleven times. Judging diversification by seats rather than distinct hands inflates
    // n. `labelled` is ascending, so the first row per mint is its earliest evaluation.
    const byMint = []
    {
      const seen = new Set()
      for (const l of labelled) {
        if (seen.has(l.row.token_address)) continue
        seen.add(l.row.token_address)
        byMint.push(l)
      }
    }

    const positives = labelled.filter((l) => l.collapsed)
    const baseRate = positives.length / labelled.length
    const bCi = wilson(positives.length, labelled.length)
    console.log(
      `collapses (label=1): ${positives.length}   base rate ${pct(baseRate)} [${pct(bCi.lo)}, ${pct(bCi.hi)}]`,
    )

    const reportView = (set, name, predicate) => {
      const trips = set.filter(predicate)
      const tp = trips.filter((l) => l.collapsed)
      const precision = trips.length > 0 ? tp.length / trips.length : 0
      const recall = positives.length > 0 ? tp.length / positives.length : 0
      const pCi = wilson(tp.length, trips.length)
      const rCi = wilson(tp.length, positives.length)
      if (trips.length === 0) {
        console.log(`  ${name}: 0 trips — precision undefined, NOT zero (inconclusive)`)
      } else {
        const note = trips.length < MIN_POSITIVES ? `  inconclusive, trips<${MIN_POSITIVES}` : ''
        console.log(
          `  ${name}: trips ${trips.length}  precision ${pct(precision)} [${pct(pCi.lo)}, ${pct(pCi.hi)}] ` +
            `(${tp.length}/${trips.length})  recall ${pct(recall)} [${pct(rCi.lo)}, ${pct(rCi.hi)}]${note}`,
        )
      }
      return { trips, tp, precision, recall }
    }

    console.log('')
    console.log('trips (shipped = the decision the scorer actually stored):')
    const shipped = reportView(labelled, 'shipped      ', (l) => l.trippedShipped)
    console.log(`trips (retroactive = the current core rule re-applied to stored features):`)
    const retro = reportView(labelled, 'retroactive  ', (l) => l.trippedRetroactive)

    // Threshold sensitivity: the operating point becomes an output, not an input.
    console.log('')
    console.log(`core-threshold sensitivity (retroactive; liquidity >= ${CORE_MIN_LIQ} required):`)
    for (const candidate of CORE_CANDIDATES) {
      const trips = labelled.filter((l) => l.core >= candidate && l.liquidity >= CORE_MIN_LIQ)
      const tp = trips.filter((l) => l.collapsed)
      const mark = candidate === CORE_THRESHOLD ? '  <- shipped' : ''
      const cell =
        trips.length === 0
          ? 'no trips'
          : `${pct(tp.length / trips.length)} (${tp.length}/${trips.length})` +
            (trips.length < MIN_POSITIVES ? `  inconclusive, n<${MIN_POSITIVES}` : '')
      console.log(
        `  core >= ${String(candidate).padStart(2)}  trips ${String(trips.length).padStart(3)}  precision ${cell}${mark}`,
      )
    }

    // The sum hides which component is doing the work. Sweep the components on their own.
    const sweepCell = (set, predicate) => {
      const trips = set.filter(predicate)
      if (trips.length === 0) return 'none'
      const tp = trips.filter((l) => l.collapsed).length
      const note = trips.length < MIN_POSITIVES ? ` inconclusive, n<${MIN_POSITIVES}` : ''
      return `${pct(tp / trips.length)} (${tp}/${trips.length})${note}`
    }

    console.log('')
    console.log('staircase-threshold sensitivity (retroactive; rows vs independent mints):')
    for (const candidate of [30, 25, 20, 15, 10]) {
      console.log(
        `  staircase >= ${String(candidate).padStart(2)}  rows ${sweepCell(labelled, (l) => l.staircase >= candidate).padEnd(26)}` +
          `  mints ${sweepCell(byMint, (l) => l.staircase >= candidate)}`,
      )
    }
    console.log('')
    console.log('liquidity-only sensitivity (is thin liquidity alone a trip?):')
    for (const candidate of [0.01, 0.02, 0.03, 0.05]) {
      console.log(
        `  liq/mcap <= ${pct(candidate).padEnd(5)}  rows ${sweepCell(labelled, (l) => l.liqRatio != null && l.liqRatio <= candidate).padEnd(26)}` +
          `  mints ${sweepCell(byMint, (l) => l.liqRatio != null && l.liqRatio <= candidate)}`,
      )
    }

    const separation = (set, title) => {
      const pos = set.filter((l) => l.collapsed)
      const rate = set.length > 0 ? pos.length / set.length : 0
      const ci = wilson(pos.length, set.length)
      console.log('')
      console.log(`${title}  (n=${set.length}, collapses=${pos.length}, base rate ${pct(rate)} [${pct(ci.lo)}, ${pct(ci.hi)}])`)
      for (const bucket of LIQ_BUCKETS) {
        const rows = set.filter(
          (l) => l.liqRatio != null && l.liqRatio >= bucket.lo && l.liqRatio < bucket.hi,
        )
        console.log(
          `  liq/mcap ${bucket.label.padEnd(6)} ${rateCell(rows.filter((l) => l.collapsed).length, rows.length)}`,
        )
      }
      for (const [lo, hi] of [
        [0, 10],
        [10, 25],
        [25, 41],
      ]) {
        const rows = set.filter((l) => l.staircase >= lo && l.staircase < hi)
        console.log(
          `  staircase ${lo}-${Math.min(hi - 1, 40)} ${rateCell(rows.filter((l) => l.collapsed).length, rows.length)}`,
        )
      }
    }

    separation(labelled, 'separation by row (every sweep counts — not independent)')
    separation(byMint, 'separation by distinct mint (first evaluation only — independent)')

    console.log('')
    console.log(`trips per distinct mint (what would actually be deployed; ${byMint.length} mints):`)
    reportView(byMint, 'shipped      ', (l) => l.trippedShipped)
    reportView(byMint, 'retroactive  ', (l) => l.trippedRetroactive)

    // Per-day agreement — a pooled number can hide one good day.
    const days = [...new Set(labelled.map((l) => l.dayKey))].sort()
    console.log('')
    console.log('per-day (agreement is the acceptance rule, not the pooled number):')
    let daysClearing = 0
    let daysWithFloor = 0
    for (const day of days) {
      const dayRows = labelled.filter((l) => l.dayKey === day)
      const dayTrips = dayRows.filter((l) => l.trippedShipped || l.trippedRetroactive)
      const dayPos = dayRows.filter((l) => l.collapsed)
      const dayTp = dayTrips.filter((l) => l.collapsed)
      const dayPrecision = dayTrips.length > 0 ? dayTp.length / dayTrips.length : 0
      const dayBaseRate = dayRows.length > 0 ? dayPos.length / dayRows.length : 0
      const dayStair = dayRows.filter((l) => l.staircase >= 25)
      const dayStairTp = dayStair.filter((l) => l.collapsed).length
      if (dayTrips.length >= MIN_POSITIVES) daysWithFloor++
      if (dayTrips.length >= MIN_POSITIVES && dayPrecision > dayBaseRate) daysClearing++
      console.log(
        `  ${day}  rows=${String(dayRows.length).padStart(3)}  collapses=${String(dayPos.length).padStart(2)}  ` +
          `trips=${String(dayTrips.length).padStart(2)}  precision=${dayTrips.length > 0 ? pct(dayPrecision) : 'n/a'}`,
      )
      console.log(
        `            staircase>=25 trips=${String(dayStair.length).padStart(2)} ` +
          `precision=${dayStair.length > 0 ? `${pct(dayStairTp / dayStair.length)} (${dayStairTp}/${dayStair.length})` : 'n/a'}`,
      )
    }

    // The trip denominator carries its own floor: 0/0 is not a precision of zero.
    const tripsForVerdict = retro.trips.length >= shipped.trips.length ? retro : shipped
    console.log('')
    if (labelled.length < MIN_LABELLED) {
      console.log(
        `VERDICT: inconclusive — ${labelled.length} labelled rows against a floor of ${MIN_LABELLED}. ` +
          'Not "no effect"; not yet a result.',
      )
      return
    }
    if (positives.length < MIN_POSITIVES) {
      console.log(
        `VERDICT: inconclusive — only ${positives.length} collapses against a floor of ${MIN_POSITIVES}. ` +
          'There is nothing to predict yet.',
      )
      return
    }
    if (tripsForVerdict.trips.length < MIN_POSITIVES) {
      console.log(
        `VERDICT: inconclusive — ${tripsForVerdict.trips.length} trips against a floor of ${MIN_POSITIVES}. ` +
          'Precision is undefined here, NOT zero: the rule has not fired enough times to say anything. ' +
          'Lower RUG_SIG_CORE_THRESHOLD to raise the trip rate, or let the soak run.',
      )
      return
    }
    const lift = tripsForVerdict.precision > baseRate
    console.log(
      lift
        ? `VERDICT: the trip carries signal — precision ${pct(tripsForVerdict.precision)} against a base rate of ${pct(baseRate)} ` +
            `(${daysClearing}/${daysWithFloor} days with enough trips agree). Anchors may be called FITTED only if that agreement holds.`
        : `VERDICT: no lift — precision ${pct(tripsForVerdict.precision)} is not above the base rate of ${pct(baseRate)}. ` +
            'The trip is not evidence of a coming collapse; do NOT enforce.',
    )
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('validate failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
