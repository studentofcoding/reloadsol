#!/usr/bin/env node
/**
 * Dev-reputation / RugCheck shadow soak check.
 *
 * Runs the correlation, decides whether any bucket is now statistically worth
 * acting on, and (once) pings Telegram when it is. Intended to run daily on the
 * VPS via scripts/run-soak-dev-reputation-on-vps.sh — independent of any session.
 *
 * Significance rule: a bucket counts only when n >= CORR_MIN_N (default 20) AND
 * its 95% Wilson win-rate interval excludes the overall base win rate. Otherwise
 * the answer is "no evidence yet" and nothing happens.
 *
 * State lives in Postgres (`dev_reputation_soak`, one row) so it survives
 * container rebuilds; the notification is rate-limited to once per
 * SOAK_NOTIFY_COOLDOWN_DAYS (default 7).
 *
 * Read-only against trading data. Exit code is always 0 unless it truly fails.
 */

import { Client } from 'pg'

const MIN_N = Number(process.env.CORR_MIN_N ?? 20)
const COOLDOWN_DAYS = Number(process.env.SOAK_NOTIFY_COOLDOWN_DAYS ?? 7)

function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 0]
  const p = wins / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - s) / d, (c + s) / d]
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—')

const BUCKETS = [
  {
    kind: 'rugcheck',
    bucket: `CASE
       WHEN r.rugcheck_score_norm IS NULL THEN 'na'
       WHEN r.rugcheck_score_norm <= 10 THEN '0-10'
       WHEN r.rugcheck_score_norm <= 30 THEN '11-30'
       WHEN r.rugcheck_score_norm <= 60 THEN '31-60'
       ELSE '60+' END`,
  },
  { kind: 'dev', bucket: `COALESCE(r.dev_verdict, 'unknown')` },
]

async function ensureState(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS dev_reputation_soak (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      significant BOOLEAN NOT NULL DEFAULT FALSE,
      notified_at TIMESTAMPTZ,
      detail TEXT,
      CONSTRAINT dev_reputation_soak_single CHECK (id = 1)
    )`)
  await client.query(
    `INSERT INTO dev_reputation_soak (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  )
}

async function baseRate(client) {
  const { rows } = await client.query(`
    SELECT COUNT(*)::int AS n, SUM(CASE WHEN o.pnl_pct > 0 THEN 1 ELSE 0 END)::int AS wins
    FROM token_risk_features r
    JOIN strategy_outcomes o
      ON o.token_address = r.token_address AND o.chain = r.chain
    WHERE o.pnl_pct IS NOT NULL`)
  return rows[0]
}

async function buckets(client) {
  const out = []
  for (const { kind, bucket } of BUCKETS) {
    const { rows } = await client.query(`
      SELECT ${bucket} AS bucket,
             COUNT(*)::int AS n,
             SUM(CASE WHEN o.pnl_pct > 0 THEN 1 ELSE 0 END)::int AS wins
      FROM token_risk_features r
      JOIN strategy_outcomes o
        ON o.token_address = r.token_address AND o.chain = r.chain
      WHERE o.pnl_pct IS NOT NULL
      GROUP BY bucket
      ORDER BY bucket`)
    for (const row of rows) {
      out.push({ kind, bucket: row.bucket, n: row.n, wins: row.wins })
    }
  }
  return out
}

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID?.trim()
  if (!token || !chat) {
    console.log('[soak] telegram not configured — notification skipped')
    return false
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      console.log(`[soak] telegram http ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.log(`[soak] telegram failed: ${err.message}`)
    return false
  }
}

async function main() {
  const { DATABASE_URL } = process.env
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required')

  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  await ensureState(client)

  const base = await baseRate(client)
  const baseWin = base.n ? base.wins / base.n : null
  const rows = await buckets(client)

  const scored = rows.map((r) => {
    const [lo, hi] = wilson(r.wins, r.n)
    const significant =
      r.n >= MIN_N &&
      baseWin != null &&
      (lo > baseWin || hi < baseWin)
    return { ...r, winRate: r.n ? r.wins / r.n : null, lo, hi, significant }
  })

  const hits = scored.filter((r) => r.significant)
  const anySignificant = hits.length > 0

  const detail =
    `n=${base.n} base=${pct(baseWin)} | ` +
    scored
      .map((r) => `${r.kind}:${r.bucket} n=${r.n} win=${pct(r.winRate)}${r.significant ? ' *' : ''}`)
      .join(' ')

  console.log(`[soak] ${detail}`)

  const { rows: stateRows } = await client.query(
    `SELECT notified_at FROM dev_reputation_soak WHERE id = 1`,
  )
  const notifiedAt = stateRows[0]?.notified_at ? new Date(stateRows[0].notified_at) : null
  const coolMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  const mayNotify = !notifiedAt || Date.now() - notifiedAt.getTime() > coolMs

  let notified = false
  if (anySignificant && mayNotify) {
    const lines = hits.map(
      (r) => `• ${r.kind} ${r.bucket}: n=${r.n}, win ${pct(r.winRate)} (CI ${pct(r.lo)}–${pct(r.hi)}) vs base ${pct(baseWin)}`,
    )
    const text = [
      '📈 Dev-reputation shadow: evidence is in',
      '',
      ...lines,
      '',
      'Buckets with * now have n>=' + MIN_N + ' and a CI excluding the base rate.',
      'Review: /dev/dev-reputation → then decide on DEV_REPUTATION_MODE=enforce',
      '(no behaviour has changed; the shadow still gates nothing).',
    ].join('\n')
    notified = await notify(text)
  }

  await client.query(
    `UPDATE dev_reputation_soak
     SET last_checked_at = NOW(),
         significant = $1,
         detail = $2,
         notified_at = CASE WHEN $3 THEN NOW() ELSE notified_at END
     WHERE id = 1`,
    [anySignificant, detail, notified],
  )

  if (!anySignificant) {
    console.log(`[soak] no evidence yet (min n=${MIN_N}) — staying in shadow`)
  } else if (!mayNotify && !notified) {
    console.log('[soak] significant but inside the notify cooldown')
  }

  await client.end()
}

main().catch((err) => {
  console.error('[soak] failed:', err.message)
  process.exit(1)
})
