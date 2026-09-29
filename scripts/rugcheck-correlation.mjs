#!/usr/bin/env node
/**
 * Read-only correlation: does the shadow risk signal (RugCheck score + dev verdict)
 * line up with our realised outcomes and rug labels?
 *
 * Nothing is written and no thresholds are changed. Run it where DATABASE_URL
 * resolves (the prod web container — see the run-*-on-vps.sh wrappers). It prints
 * lift tables with a minimum-sample floor so "no result yet" cannot read as "no
 * effect": rows under CORR_MIN_N (default 20) print as inconclusive.
 *
 *   DATABASE_URL=... node scripts/rugcheck-correlation.mjs
 */

import { Pool } from 'pg'

const url = process.env.DATABASE_URL?.trim()
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const MIN_N = Number(process.env.CORR_MIN_N ?? 20)
const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000 })

function wilson(wins, n, z = 1.96) {
  if (n === 0) return [0, 0]
  const p = wins / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - s) / d, (c + s) / d]
}

function pct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—'
}

async function tableExists(name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
    [name],
  )
  return rows.length > 0
}

async function outcomeBuckets(label, bucketSql) {
  const { rows } = await pool.query(
    `SELECT ${bucketSql} AS bucket,
            COUNT(*)::int AS n,
            SUM(CASE WHEN o.pnl_pct > 0 THEN 1 ELSE 0 END)::int AS wins,
            AVG(o.pnl_pct) AS avg_pnl,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY o.pnl_pct) AS median_pnl
     FROM token_risk_features r
     JOIN strategy_outcomes o
       ON o.token_address = r.token_address AND o.chain = r.chain
     WHERE o.pnl_pct IS NOT NULL
     GROUP BY bucket
     ORDER BY bucket`,
  )
  console.log(`\n== ${label} vs realised outcome (sim + live, n=${rows.reduce((a, r) => a + r.n, 0)}) ==`)
  if (rows.length === 0) {
    console.log('  no joined rows yet')
    return
  }
  console.log('  bucket              n   win%   95% CI        medianPnL  avgPnL')
  for (const r of rows) {
    const [lo, hi] = wilson(r.wins, r.n)
    const note = r.n < MIN_N ? '  [inconclusive: n<' + MIN_N + ']' : ''
    console.log(
      `  ${String(r.bucket).padEnd(18)} ${String(r.n).padStart(3)}  ${pct(r.wins / r.n).padStart(6)}  ` +
        `[${pct(lo)}, ${pct(hi)}]  ${Number(r.median_pnl ?? 0).toFixed(1).padStart(8)}%  ` +
        `${Number(r.avg_pnl ?? 0).toFixed(1).padStart(6)}%${note}`,
    )
  }
}

async function rugLabelJoin() {
  if (!(await tableExists('token_detect_snapshots'))) return
  const { rows } = await pool.query(
    `SELECT r.dev_verdict,
            s.rug_label,
            COUNT(*)::int AS n
     FROM token_risk_features r
     JOIN token_detect_snapshots s ON s.token_address = r.token_address
     GROUP BY 1, 2
     ORDER BY 1, 2`,
  )
  console.log('\n== dev verdict vs detect-snapshot label ==')
  if (rows.length === 0) {
    console.log('  no joined rows yet')
    return
  }
  for (const r of rows) {
    console.log(`  ${r.dev_verdict.padEnd(13)} ${r.rug_label.padEnd(10)} n=${r.n}`)
  }
}

async function main() {
  if (!(await tableExists('token_risk_features'))) {
    console.log('token_risk_features not found — apply db/init/48 first.')
    return
  }
  console.log(`shadow risk correlation (CORR_MIN_N=${MIN_N})`)

  await outcomeBuckets(
    'rugcheck score_normalised',
    `CASE
       WHEN r.rugcheck_score_norm IS NULL THEN 'na'
       WHEN r.rugcheck_score_norm <= 10 THEN '0-10'
       WHEN r.rugcheck_score_norm <= 30 THEN '11-30'
       WHEN r.rugcheck_score_norm <= 60 THEN '31-60'
       ELSE '60+' END`,
  )

  await outcomeBuckets('dev verdict', `COALESCE(r.dev_verdict, 'unknown')`)

  await rugLabelJoin()

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(rugcheck_score_norm)::int AS with_rugcheck,
            COUNT(*) FILTER (WHERE dev_verdict <> 'unknown')::int AS with_dev
     FROM token_risk_features`,
  )
  console.log('\n== coverage ==')
  console.log(`  rows=${rows[0].n} rugcheck=${rows[0].with_rugcheck} dev=${rows[0].with_dev}`)
}

main()
  .catch((err) => {
    console.error('correlation failed:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
