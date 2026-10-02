#!/usr/bin/env bash
# SL/TP closer watchdog — runs ON flowey-vps from the host crontab.
#
# Why it exists: `sltp_monitor` is now the ONLY thing that closes a position. `8ae590a` deleted the
# per-family closers, so if this worker stops, nothing exits — positions sit past their stop and past
# their target, and the only symptom is a stale badge on a dashboard nobody is looking at. Today it
# failed, timed out and had its lock skipped repeatedly while the market moved.
#
# Why it reads Postgres DIRECTLY, through the db container, and never calls the web app:
# **the thing it watches is the web app.** A `sltp_monitor` failure IS a web failure (the cron posts
# to `/api/sl-tp-monitor`), so a watchdog that reported through an API route would go silent in exactly
# the incident it exists to catch. The db container is the one component that has to be alive for any
# of this to matter, and it stays reachable while web is down.
#
# It reports, it never fixes. Exit 0 = healthy, 1 = something is wrong (so cron mail/log makes noise).
#
# Knobs: SLTP_MAX_SUCCESS_AGE_MIN (default 15 — passes run every 60s and a slow one takes ~3 min),
#        SLTP_ALERT_COOLDOWN_MIN (30), SLTP_FRESHNESS_LOG, SLTP_SELF_TEST=1.
set -uo pipefail

DB_CONTAINER="${DB_CONTAINER:-reloadsol-db}"
DB_NAME="${DB_NAME:-reloadsol_db}"
DB_USER="${DB_USER:-reloadsol}"
MAX_AGE_MIN="${SLTP_MAX_SUCCESS_AGE_MIN:-15}"
COOLDOWN_MIN="${SLTP_ALERT_COOLDOWN_MIN:-30}"
LOG_FILE="${SLTP_FRESHNESS_LOG:-$HOME/reloadsol-sltp-closer.log}"
REPO_DIR="${REPO_DIR:-$HOME/reloadsol}"
WATCHDOG_NAME="sltp_monitor"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }

# The decision, isolated so it can be exercised without a database. Exists because this is a bash
# watcher: there is no vitest for it, and the alternative — moving the decision into TypeScript —
# would put the watchdog behind the component whose failure it is supposed to report.
#
# Args: <success_age_min|never> <max_age_min>. Echoes the reason, or nothing when healthy.
decide() {
  local age="$1" max="$2"
  if [ "$age" = "never" ]; then
    echo "the sole closer has NEVER recorded a successful pass"
    return
  fi
  if [ -z "$age" ] || [ "$age" -gt "$max" ]; then
    echo "no successful pass for ${age:-?} min (limit ${max})"
  fi
}

if [ "${SLTP_SELF_TEST:-0}" = "1" ]; then
  fail=0
  check() { # <age> <max> <expect_reason?> <label>
    local got; got="$(decide "$1" "$2")"
    if [ "$3" = "none" ]; then
      [ -z "$got" ] || { echo "FAIL $4: expected healthy, got '$got'"; fail=1; return; }
    else
      case "$got" in *"$3"*) ;; *) echo "FAIL $4: wanted '$3', got '$got'"; fail=1; return;; esac
    fi
    echo "ok   $4"
  }
  check 3     15 none    "a fresh pass is healthy"
  check 14    15 none    "12 min inside the limit is healthy"
  check 16    15 "no successful pass for 16 min" "past the limit alerts"
  check never 15 "NEVER" "never succeeded alerts"
  check ""    15 "no successful pass"           "an unreadable age alerts rather than passing"
  [ "$fail" -eq 0 ] && echo "self-test OK" || echo "self-test FAILED"
  exit "$fail"
fi

q() { docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAF'|' -c "$1"; }

if ! q "SELECT 1" >/dev/null 2>&1; then
  log "CRITICAL db container '$DB_CONTAINER' is unreachable — cannot judge the closer at all"
  exit 1
fi

# One row, pipe-separated. `IFS='|'` because a timestamp contains a space
# ("2026-10-02 17:46:07.16875+07"), so splitting on whitespace truncates it and the age reads as
# "since midnight" — the bug that made an earlier version of the copier watchdog blind.
IFS='|' read -r AGE_MIN LAST_SUCCESS LAST_ERROR LAST_SKIP LAST_ERROR_MSG <<<"$(
  q "SELECT COALESCE(FLOOR(EXTRACT(EPOCH FROM (NOW() - last_success_at)) / 60)::int::text, 'never'),
            COALESCE(last_success_at::text, 'never'),
            COALESCE(last_error_at::text, 'never'),
            COALESCE(last_skipped_at::text, 'never'),
            COALESCE(NULLIF(regexp_replace(regexp_replace(left(last_error_msg, 160),
              '(key|secret|token|auth)=[^&[:space:]\"]+', '\\1=REDACTED', 'gi'),
              '[\\n\\r|]+', ' ', 'g'), ''), 'none')
       FROM cron_worker_runtime
      WHERE worker_id = '$WATCHDOG_NAME'"
)"

if [ -z "${LAST_SUCCESS:-}" ]; then
  log "CRITICAL no '$WATCHDOG_NAME' row in cron_worker_runtime — the closer has never reported"
  exit 1
fi

REASON="$(decide "$AGE_MIN" "$MAX_AGE_MIN")"
# The message is truncated and has `key=`/`secret=`/`token=` query values redacted BEFORE it is logged or
# sent to Telegram: the Go worker's own error text embeds the full request URL, including the cron secret.
# `last error msg` names the cause when passes FAIL rather than stop: since the price-outage guard a
# pass that cannot price its book answers 500 ("SL/TP pass unhealthy: ..."), so last_success_at stops
# advancing and this line says why, instead of the closer looking merely quiet.
SUMMARY="last success: ${LAST_SUCCESS}${AGE_MIN:+ (${AGE_MIN}m ago)} | last error: ${LAST_ERROR} | last error msg: ${LAST_ERROR_MSG:-none} | last skip: ${LAST_SKIP}"

if [ -z "$REASON" ]; then
  log "OK ${SUMMARY}"
  exit 0
fi

log "ALERT ${REASON} — ${SUMMARY}"

# Telegram, rate-limited by a cooldown row IN THE DATABASE rather than a file, so an hour-long outage
# sends one message and not sixty, and the cooldown survives a host rebuild.
#
# This writes to the db container directly for the same reason the read does: it has to work while web
# is dead. Credentials come from the app's own .env when present.
if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env" >/dev/null 2>&1 || true; set +a
fi
TOKEN="${TELEGRAM_BOT_TOKEN:-${TELEGRAM_TOKEN:-}}"
# `TELEGRAM_ALERT_CHAT_ID` is the name this stack actually uses — verified by reading the server's
# `.env`, which has exactly `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` and
# `TELEGRAM_WEBHOOK_SECRET`. The other two are kept as fallbacks only. Getting this wrong is silent:
# the watchdog works perfectly and simply never sends anything, which is how the copier watchdog has
# been "alerting" — it looks for TELEGRAM_CHAT_ID / TELEGRAM_CHAT_ID_ALERTS, neither of which exists.
CHAT="${TELEGRAM_ALERT_CHAT_ID:-${TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID_ALERTS:-}}}"

ALERT_DUE="$(q "SELECT CASE
      WHEN to_regclass('watchdog_alert_state') IS NULL THEN 'yes'
      WHEN COALESCE((SELECT NOW() - last_alert_at >= make_interval(mins => $COOLDOWN_MIN)
                       FROM watchdog_alert_state WHERE watchdog = '$WATCHDOG_NAME'), true) THEN 'yes'
      ELSE 'no' END" | tr -d '[:space:]')"

if [ "$ALERT_DUE" != "yes" ]; then
  log "suppressed Telegram alert (within ${COOLDOWN_MIN}m cooldown)"
  exit 1
fi

if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
  SENT=0
  curl -s --max-time 15 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d "chat_id=${CHAT}" \
    --data-urlencode "text=🛡️ SL/TP closer (the ONLY closer): ${REASON}
${SUMMARY}" >/dev/null 2>&1 && SENT=1
  if [ "$SENT" = "1" ]; then
    q "INSERT INTO watchdog_alert_state (watchdog, last_alert_at) VALUES ('$WATCHDOG_NAME', NOW())
       ON CONFLICT (watchdog) DO UPDATE SET last_alert_at = EXCLUDED.last_alert_at" >/dev/null 2>&1 \
      && log "sent Telegram alert and recorded the cooldown" \
      || log "sent Telegram alert but could NOT record the cooldown (will re-alert next tick)"
  else
    log "Telegram send FAILED (not recorded, so it will retry)"
  fi
else
  log "no Telegram credentials in $REPO_DIR/.env — alert logged only"
fi

exit 1
