#!/usr/bin/env bash
# Copier freshness watchdog — runs ON flowey-vps from the host crontab.
#
# Why it exists: the metrics copier completed 4 of ~56 scheduled runs over 14 hours and left a
# seven-hour hole in the 1m series, and nothing said so. Its failures lived in the cron's stdout, and
# the recorder that would have written them to the DB went through the web app — the thing that was
# down. So this reads Postgres **directly through the db container**, which is the one component that
# has to be alive for any of it to matter, and it works while web is dead.
#
# It reports, it never fixes. Exit 0 = healthy, 1 = something is wrong (so cron mail/log makes noise).
#
# Knobs: COPIER_MAX_AGE_MIN (default 40 — ~2.7 missed 15-minute ticks), COPIER_STUCK_MIN (15),
#        COPIER_WINDOW_MIN (180), COPIER_ALERT_COOLDOWN_MIN (60), COPIER_FRESHNESS_LOG.
set -uo pipefail

DB_CONTAINER="${DB_CONTAINER:-reloadsol-db}"
DB_NAME="${DB_NAME:-reloadsol_db}"
DB_USER="${DB_USER:-reloadsol}"
MAX_AGE_MIN="${COPIER_MAX_AGE_MIN:-40}"
STUCK_MIN="${COPIER_STUCK_MIN:-15}"
WINDOW_MIN="${COPIER_WINDOW_MIN:-180}"
COOLDOWN_MIN="${COPIER_ALERT_COOLDOWN_MIN:-60}"
LOG_FILE="${COPIER_FRESHNESS_LOG:-$HOME/reloadsol-copier-watchdog.log}"
COOLDOWN_FILE="${COPIER_COOLDOWN_FILE:-/tmp/reloadsol-copier-watchdog.cooldown}"
REPO_DIR="${REPO_DIR:-$HOME/reloadsol}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }

# The table is created on first use by the app, so its absence is "not armed yet", not a failure.
q() {
  docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAF'|' -c "$1" 2>/dev/null
}

if ! q "SELECT 1" >/dev/null 2>&1; then
  log "CRITICAL db container '$DB_CONTAINER' is unreachable — cannot judge the copier at all"
  exit 1
fi

if [ "$(q "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'copier_runs'")" != "1" ]; then
  log "WARN copier_runs does not exist yet — the outcome recorder has never run (deploy the build that writes it)"
  exit 1
fi

read -r LAST_COMPLETED COMPLETED FAILED STUCK ATTEMPTS <<<"$(
  q "SELECT COALESCE((SELECT MAX(finished_at)::text FROM copier_runs WHERE outcome = 'completed'), 'never'),
            (SELECT COUNT(*) FROM copier_runs WHERE outcome = 'completed' AND started_at > NOW() - make_interval(mins => $WINDOW_MIN)),
            (SELECT COUNT(*) FROM copier_runs WHERE outcome = 'failed'    AND started_at > NOW() - make_interval(mins => $WINDOW_MIN)),
            (SELECT COUNT(*) FROM copier_runs WHERE outcome = 'running'   AND started_at < NOW() - make_interval(mins => $STUCK_MIN)),
            (SELECT COUNT(*) FROM copier_runs WHERE started_at > NOW() - make_interval(mins => $WINDOW_MIN))" | tr '|' ' '
)"

AGE_MIN=""
if [ "$LAST_COMPLETED" != "never" ]; then
  AGE_MIN="$(q "SELECT FLOOR(EXTRACT(EPOCH FROM (NOW() - TIMESTAMPTZ '$LAST_COMPLETED')) / 60)::int")"
fi

STATUS=0
REASON=""
if [ "$LAST_COMPLETED" = "never" ]; then
  STATUS=1; REASON="no completed sweep has ever been recorded"
elif [ -z "$AGE_MIN" ] || [ "$AGE_MIN" -gt "$MAX_AGE_MIN" ]; then
  STATUS=1; REASON="last completed sweep was ${AGE_MIN:-?} min ago (limit ${MAX_AGE_MIN})"
fi
if [ "$STUCK" -gt 0 ]; then
  STATUS=1
  REASON="${REASON:+$REASON; }$STUCK sweep(s) stuck in 'running' for over ${STUCK_MIN} min (killed mid-flight)"
fi

SUMMARY="window ${WINDOW_MIN}m: attempts ${ATTEMPTS}, completed ${COMPLETED}, failed ${FAILED} | last completed: ${LAST_COMPLETED}${AGE_MIN:+ (${AGE_MIN}m ago)}"

if [ "$STATUS" -eq 0 ]; then
  log "OK ${SUMMARY}"
  exit 0
fi

log "ALERT ${REASON} — ${SUMMARY}"

# Optional Telegram, rate-limited by a cooldown file so a long outage sends an occasional reminder
# rather than a message every tick. Credentials come from the app's own .env when present.
if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env" >/dev/null 2>&1 || true; set +a
fi
TOKEN="${TELEGRAM_BOT_TOKEN:-${TELEGRAM_TOKEN:-}}"
CHAT="${TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID_ALERTS:-}}"
if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
  NOW=$(date +%s)
  LAST_ALERT=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST_ALERT)) -ge $((COOLDOWN_MIN * 60)) ]; then
    curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT}" \
      --data-urlencode "text=⚠️ metrics copier: ${REASON}
${SUMMARY}" >/dev/null 2>&1 && echo "$NOW" > "$COOLDOWN_FILE" \
      && log "sent Telegram alert (cooldown ${COOLDOWN_MIN}m)"
  else
    log "suppressed Telegram alert (within ${COOLDOWN_MIN}m cooldown)"
  fi
fi

exit 1
