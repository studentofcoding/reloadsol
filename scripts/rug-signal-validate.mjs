/**
 * Rug-signal validation harness — read-only.
 *
 * Answers one question: **does `score >= threshold` actually precede a collapse more often than the
 * base rate?** Nothing here re-implements the scorer. The verdicts come from `rug_signal_shadow`
 * (written by the real code on every evaluation, trips and non-trips alike), and the label is derived
 * independently from the market-cap candles — so the test is not graded by the thing being tested.
 *
 * Design points that matter:
 *   * **The label looks forward from the evaluation**, not backward. A rug card's own window ends
 *     *in* the dump, which is why the labelled corpus could never validate a pre-dump signal.
 *   * **Unlabellable rows are counted, not dropped.** A row whose token has no candles after it is
 *     not a negative — it is unknown, and silently treating it as one is how a precision figure
 *     becomes fiction.
 *   * **`inconclusive` is a verdict.** Below the sample floor the script prints that, never a number
 *     that could be mistaken for a result.
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
const THRESHOLD = Number(process.env.RUG_SIG_THRESHOLD || 80)
const MIN_LABELLED = Number(process.env.RUG_VALIDATE_MIN_ROWS || 30)
const MIN_POSITIVES = Number(process.env.RUG_VALIDATE_MIN_POSITIVES || 5)
/** Fewer 5m bars than this and the scorer could not judge the shape — an unknown, not a negative. */
const MIN_BARS = Number(process.env.RUG_SIG_MIN_BARS || 5)

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

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const { rows: shadowAll } = await client.query(
      `SELECT token_address, created_at::text, score, decision, bars_source, bars_scored, breakdown
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
      labelled.push({
        row,
        tripped: row.score >= THRESHOLD,
        collapsed: (baseline - trough) / baseline >= EVENT_DROP,
        dayKey: row.created_at.slice(0, 10),
      })
    }

    const positives = labelled.filter((l) => l.collapsed)
    const trips = labelled.filter((l) => l.tripped)
    const truePositives = labelled.filter((l) => l.tripped && l.collapsed)
    console.log('')
    console.log(`labelled rows: ${labelled.length}  (unlabellable, no candles after the row: ${unlabellable})`)
    console.log(`collapses (label=1): ${positives.length}   trips (score>=${THRESHOLD}): ${trips.length}`)
    if (labelled.length === 0) {
      console.log('')
      console.log(
        `VERDICT: inconclusive — nothing labellable yet (${unlabellable} rows have no market-cap ` +
          'candles after their timestamp). This is the expected state right after arming: the label ' +
          `needs ${EVENT_WINDOW_MIN} minutes of forward candles per row.`,
      )
      return
    }

    const baseRate = positives.length / labelled.length
    const precision = trips.length > 0 ? truePositives.length / trips.length : 0
    const recall = positives.length > 0 ? truePositives.length / positives.length : 0
    const pCi = wilson(truePositives.length, trips.length)
    const rCi = wilson(truePositives.length, positives.length)
    const bCi = wilson(positives.length, labelled.length)
    console.log('')
    console.log(`base rate        ${pct(baseRate)}  [${pct(bCi.lo)}, ${pct(bCi.hi)}]`)
    console.log(
      `precision @${THRESHOLD}   ${pct(precision)}  [${pct(pCi.lo)}, ${pct(pCi.hi)}]  (${truePositives.length}/${trips.length})`,
    )
    console.log(
      `recall    @${THRESHOLD}   ${pct(recall)}  [${pct(rCi.lo)}, ${pct(rCi.hi)}]  (${truePositives.length}/${positives.length})`,
    )

    // Per-day agreement — a pooled number can hide one good day.
    const days = [...new Set(labelled.map((l) => l.dayKey))].sort()
    console.log('')
    console.log('per-day (agreement is the acceptance rule, not the pooled number):')
    let daysClearing = 0
    let daysWithFloor = 0
    for (const day of days) {
      const dayRows = labelled.filter((l) => l.dayKey === day)
      const dayTrips = dayRows.filter((l) => l.tripped)
      const dayPos = dayRows.filter((l) => l.collapsed)
      const dayTp = dayRows.filter((l) => l.tripped && l.collapsed)
      const dayPrecision = dayTrips.length > 0 ? dayTp.length / dayTrips.length : 0
      const dayBaseRate = dayRows.length > 0 ? dayPos.length / dayRows.length : 0
      if (dayTrips.length >= MIN_POSITIVES) daysWithFloor++
      if (dayTrips.length >= MIN_POSITIVES && dayPrecision > dayBaseRate) daysClearing++
      console.log(
        `  ${day}  rows=${String(dayRows.length).padStart(3)}  collapses=${String(dayPos.length).padStart(2)}  ` +
          `trips=${String(dayTrips.length).padStart(2)}  precision=${dayTrips.length > 0 ? pct(dayPrecision) : 'n/a'}`,
      )
    }

    const enough = labelled.length >= MIN_LABELLED && positives.length >= MIN_POSITIVES
    console.log('')
    if (!enough) {
      console.log(
        `VERDICT: inconclusive — ${labelled.length} labelled rows / ${positives.length} collapses ` +
          `against a floor of ${MIN_LABELLED} / ${MIN_POSITIVES}. Not "no effect"; not yet a result.`,
      )
      return
    }
    const lift = precision > baseRate
    console.log(
      lift
        ? `VERDICT: the trip carries signal — precision ${pct(precision)} against a base rate of ${pct(baseRate)} ` +
            `(${daysClearing}/${daysWithFloor} days with enough trips agree). Anchors may be called FITTED only if that agreement holds.`
        : `VERDICT: no lift — precision ${pct(precision)} is not above the base rate of ${pct(baseRate)}. ` +
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
