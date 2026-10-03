/**
 * Opens reporter: hourly + daily paper-open success/fail percentages and operational alerts, posted to
 * the existing Telegram alert chat (`sendTelegramAlert` -> TELEGRAM_ALERT_CHAT_ID).
 * SPEC: docs/specs/SPEC-open-attempts-reporting-v1.md
 *
 *   success  = simulated positions actually opened (`sl_tp_positions`, the source that cannot lie)
 *   failed   = final `position_open_attempts` rows with outcome 'failed'
 *   skipped  = final rows with outcome 'skipped' (brake / rug / size stand-down) — reported, not in the %
 *   success% = opened / (opened + failed)
 *
 * Alerts (each with its own cooldown in `watchdog_alert_state`, claimed only after a delivered send):
 *   - at cap / no opens for N h  : provider hook (see registerOpenStallProvider); wired to #138's cap-stall
 *                                  monitor after that merges
 *   - stuck job lock             : bot_job_locks row held far longer than any job runs
 *   - stale data feeds           : 1m bars, mcap tracker, copier sweeps
 */
import { query } from '@/utils/db'
import { log } from '@/utils/unified-logger'
import { sendTelegramAlert, isTelegramConfigured } from '@/utils/telegram'

type EnvLike = Record<string, string | undefined>
type QueryFn = typeof query

export type OpenStats = {
  windowHours: number
  opened: number
  failed: number
  skipped: number
  topFailed: Array<{ reason: string; count: number }>
  topSkipped: Array<{ reason: string; count: number }>
  /** false when position_open_attempts is missing/unreadable (stats then cover opens only). */
  attemptsAvailable: boolean
}

export type StallResult = { stalled: boolean; text: string }
export type OpenStallProvider = { name: string; check: () => Promise<StallResult | null> }

const providers = new Map<string, OpenStallProvider>()

/**
 * "At cap, no opens for 6h" hook. #138's `cap-stall-monitor` registers itself here once it merges;
 * until then there is no provider and the alert simply never fires (the report still shows 0 opens).
 */
export function registerOpenStallProvider(p: OpenStallProvider): void {
  providers.set(p.name, p)
}
export function __clearOpenStallProvidersForTests(): void {
  providers.clear()
}

const flagOff = (v: string | undefined) => ['0', 'false', 'off'].includes((v ?? '').trim().toLowerCase())

export const isOpenReportEnabled = (env: EnvLike = process.env) => !flagOff(env.OPEN_REPORT_ENABLED)
const part = (env: EnvLike, name: string) => isOpenReportEnabled(env) && !flagOff(env[name])

function intEnv(env: EnvLike, name: string, fallback: number): number {
  const n = Number(env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export async function loadOpenStats(hours: number, q: QueryFn = query): Promise<OpenStats> {
  const opened = await q(
    `SELECT COUNT(*)::int AS n FROM sl_tp_positions
      WHERE is_simulation = true AND created_at >= NOW() - make_interval(hours => $1)`,
    [hours],
  )
  const stats: OpenStats = {
    windowHours: hours,
    opened: Number(opened.rows[0]?.n ?? 0),
    failed: 0,
    skipped: 0,
    topFailed: [],
    topSkipped: [],
    attemptsAvailable: true,
  }
  try {
    const { rows } = await q(
      `SELECT outcome, COALESCE(reason, '(none)') AS reason, COUNT(*)::int AS n
         FROM position_open_attempts
        WHERE is_final = true AND outcome IN ('failed','skipped')
          AND created_at >= NOW() - make_interval(hours => $1)
        GROUP BY 1, 2 ORDER BY n DESC`,
      [hours],
    )
    for (const r of rows as Array<{ outcome: string; reason: string; n: number }>) {
      const item = { reason: r.reason, count: Number(r.n) }
      if (r.outcome === 'failed') {
        stats.failed += item.count
        stats.topFailed.push(item)
      } else {
        stats.skipped += item.count
        stats.topSkipped.push(item)
      }
    }
    stats.topFailed = stats.topFailed.slice(0, 3)
    stats.topSkipped = stats.topSkipped.slice(0, 3)
  } catch {
    stats.attemptsAvailable = false
  }
  return stats
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')

export function formatOpenReport(label: string, s: OpenStats): string {
  const attempted = s.opened + s.failed
  const lines = [`<b>📊 Paper opens — ${esc(label)}</b>`]
  lines.push(`Opened <b>${s.opened}</b> · Failed <b>${s.failed}</b> · Skipped (brake/gate) ${s.skipped}`)
  lines.push(
    attempted > 0
      ? `Success <b>${pct(s.opened, attempted)}</b> · Fail <b>${pct(s.failed, attempted)}</b>  (${s.opened}/${attempted})`
      : 'No open attempts in this window.',
  )
  if (s.topFailed.length) lines.push(`Top fail: ${s.topFailed.map((x) => `${esc(x.reason)} ×${x.count}`).join(', ')}`)
  if (s.topSkipped.length) lines.push(`Top skip: ${s.topSkipped.map((x) => `${esc(x.reason)} ×${x.count}`).join(', ')}`)
  if (!s.attemptsAvailable) lines.push('⚠️ position_open_attempts unreadable — apply db/init/65. Failed/skipped counts are missing.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------

export type AlertItem = { key: string; text: string; cooldownMin: number }

export async function checkStuckLocks(env: EnvLike = process.env, q: QueryFn = query): Promise<AlertItem[]> {
  const limitMin = intEnv(env, 'OPEN_REPORT_STUCK_LOCK_MIN', 45)
  const ignore = new Set((env.OPEN_REPORT_LOCK_IGNORE ?? '').split(',').map((x) => x.trim()).filter(Boolean))
  const { rows } = await q(
    `SELECT job_name, locked_by,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - locked_at)) / 60)::int AS held_min
       FROM bot_job_locks
      WHERE expires_at > NOW() AND locked_at < NOW() - make_interval(mins => $1)
      ORDER BY locked_at ASC`,
    [limitMin],
  )
  return (rows as Array<{ job_name: string; locked_by: string | null; held_min: number }>)
    .filter((r) => !ignore.has(r.job_name))
    .map((r) => ({
      key: `stuck_lock:${r.job_name}`,
      cooldownMin: 60,
      text: `🔒 <b>Stuck job lock</b> <code>${esc(r.job_name)}</code> held ${r.held_min} min (limit ${limitMin}) by <code>${esc(r.locked_by ?? '?')}</code> and still being renewed.`,
    }))
}

export async function checkStaleFeeds(env: EnvLike = process.env, q: QueryFn = query): Promise<AlertItem[]> {
  const items: AlertItem[] = []
  const feeds: Array<{ key: string; label: string; sql: string; limitMin: number }> = [
    {
      key: 'ohlc_bars',
      label: '1m OHLC bars (token_ohlc_bars)',
      limitMin: intEnv(env, 'OPEN_REPORT_STALE_BARS_MIN', 15),
      // bounded to 2 h so it uses idx_token_ohlc_retention (timestamp) and never scans the table
      sql: `SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))) / 60)::int AS age_min
              FROM token_ohlc_bars WHERE timestamp > NOW() - INTERVAL '2 hours'`,
    },
    {
      key: 'mcap_tracker',
      label: 'mcap tracker (token_mcap_tracking.last_updated_at)',
      limitMin: intEnv(env, 'OPEN_REPORT_STALE_TRACKER_MIN', 30),
      sql: `SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(last_updated_at))) / 60)::int AS age_min
              FROM token_mcap_tracking WHERE last_updated_at > NOW() - INTERVAL '6 hours'`,
    },
    {
      key: 'copier',
      label: '1m volume copier (copier_runs completed)',
      limitMin: intEnv(env, 'OPEN_REPORT_STALE_COPIER_MIN', 45),
      sql: `SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(finished_at))) / 60)::int AS age_min
              FROM copier_runs WHERE outcome = 'completed' AND finished_at > NOW() - INTERVAL '12 hours'`,
    },
  ]
  for (const f of feeds) {
    try {
      const { rows } = await q(f.sql, [])
      const age = rows[0]?.age_min
      // null = no row inside the lookback window at all = at least that stale
      if (age == null || Number(age) > f.limitMin) {
        items.push({
          key: `stale_feed:${f.key}`,
          cooldownMin: 60,
          text: `🕸️ <b>Stale data feed</b>: ${esc(f.label)} — ${age == null ? 'no fresh row in lookback window' : `last update ${age} min ago`} (limit ${f.limitMin} min).`,
        })
      }
    } catch (error) {
      // An unreadable feed is not proof it is stale (table may not exist on this deploy): log, don't page.
      log.warn('error_handling', 'open-report stale-feed check failed', {
        feed: f.key,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return items
}

export async function checkStallProviders(): Promise<AlertItem[]> {
  const items: AlertItem[] = []
  for (const p of providers.values()) {
    try {
      const r = await p.check()
      if (r?.stalled) items.push({ key: `stall:${p.name}`, cooldownMin: 6 * 60, text: `🧱 ${r.text}` })
    } catch (error) {
      log.warn('error_handling', 'open-report stall provider failed', {
        provider: p.name,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return items
}

// ---------------------------------------------------------------------------------------------
// Cooldown (watchdog_alert_state: a failed send must NOT update it, so the next tick retries)
// ---------------------------------------------------------------------------------------------

async function cooledDown(key: string, cooldownMin: number, q: QueryFn): Promise<boolean> {
  const { rows } = await q(
    `SELECT (last_alert_at < NOW() - make_interval(mins => $2)) AS due FROM watchdog_alert_state WHERE watchdog = $1`,
    [`open_report:${key}`, cooldownMin],
  )
  return rows.length === 0 || rows[0].due === true
}
async function markAlerted(key: string, q: QueryFn): Promise<void> {
  await q(
    `INSERT INTO watchdog_alert_state (watchdog, last_alert_at) VALUES ($1, NOW())
     ON CONFLICT (watchdog) DO UPDATE SET last_alert_at = NOW()`,
    [`open_report:${key}`],
  )
}

export function jakartaHour(now: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(now)
  return Number(h)
}

export type OpenReportMode = 'auto' | 'hourly' | 'daily' | 'alerts'
export type OpenReportRun = {
  enabled: boolean
  telegram: boolean
  dry: boolean
  posts: Array<{ key: string; sent: boolean; text: string }>
  skipped: string[]
}

export async function runOpenReport(
  mode: OpenReportMode,
  opts: {
    dry?: boolean
    now?: Date
    env?: EnvLike
    q?: QueryFn
    send?: (text: string) => Promise<boolean>
    telegramConfigured?: boolean
  } = {},
): Promise<OpenReportRun> {
  const env = opts.env ?? process.env
  const q = opts.q ?? query
  const now = opts.now ?? new Date()
  const dry = opts.dry === true
  const telegram = opts.telegramConfigured ?? isTelegramConfigured()
  const send = opts.send ?? ((text: string) => sendTelegramAlert(text, { parseMode: 'HTML' }))
  const run: OpenReportRun = { enabled: isOpenReportEnabled(env), telegram, dry, posts: [], skipped: [] }
  if (!run.enabled) return run
  if (!telegram && !dry) {
    run.skipped.push('telegram_not_configured')
    return run
  }

  const post = async (key: string, cooldownMin: number, text: string) => {
    if (!dry && !(await cooledDown(key, cooldownMin, q))) {
      run.skipped.push(`${key}:cooldown`)
      return
    }
    if (dry) {
      run.posts.push({ key, sent: false, text })
      return
    }
    const ok = await send(text)
    if (ok) await markAlerted(key, q)
    run.posts.push({ key, sent: ok, text })
    if (!ok) log.warn('error_handling', 'open-report Telegram send failed', { key })
  }

  const doHourly = (mode === 'hourly' || mode === 'auto') && part(env, 'OPEN_REPORT_HOURLY')
  const dailyHour = intEnv(env, 'OPEN_REPORT_DAILY_HOUR_WIB', 8)
  const doDaily = (mode === 'daily' || (mode === 'auto' && jakartaHour(now) === dailyHour)) && part(env, 'OPEN_REPORT_DAILY')
  const doAlerts = (mode === 'alerts' || mode === 'auto') && part(env, 'OPEN_REPORT_ALERTS')

  if (doHourly) await post('hourly', 50, formatOpenReport('last 1h', await loadOpenStats(1, q)))
  if (doDaily) await post('daily', 20 * 60, formatOpenReport('last 24h', await loadOpenStats(24, q)))
  if (doAlerts) {
    const items = [
      ...(await checkStallProviders()),
      ...(await checkStuckLocks(env, q).catch(() => [])),
      ...(await checkStaleFeeds(env, q)),
    ]
    for (const it of items) await post(`alert:${it.key}`, it.cooldownMin, it.text)
  }
  return run
}
