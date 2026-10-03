#!/usr/bin/env bash
# Rewrite the *_INTERVAL block of the VPS .env to the intended cron cadences.
#
# Why: a manual load-shed left a dozen jobs at 900s (and four at 600s) in .env. The Go code defaults were
# never wrong; the overrides were. See docs/ops/cron-interval-env-fix.md for the evidence, the
# before/after table, and the three values that were flagged for human review.
#
# SAFE BY DEFAULT:
#   * no flag        -> DRY RUN. Prints the before/after table and a diff of the changed lines. Writes nothing.
#   * --apply        -> backs up the file to <env>.bak-<date>, rewrites ONLY the *_INTERVAL lines listed
#                       below, prints the diff, re-reads the file and verifies. It does NOT restart anything:
#                       the restart command is printed for the operator to run.
#   * --skip A,B     -> leave those env vars exactly as they are (e.g. hold a flagged job back).
#   * --env-file P   -> default $ENV_FILE or $HOME/reloadsol/.env
#
# Only lines of the form  KEY=value  (optionally quoted / with a trailing comment) for the KEYS in
# INTENDED are touched. A key that is missing is REPORTED, never appended (the code default applies and,
# after the interval-table change, that default equals the intended value). Nothing else in the file is
# read into the output: the diff is filtered to *_INTERVAL lines so secrets next to them cannot leak.
#
# Test without touching anything real:  APPLY_CRON_INTERVALS_SELF_TEST=1 bash scripts/apply-cron-intervals.sh
set -euo pipefail

# KEY|intended seconds|worker id|note
INTENDED=(
  "SIGNAL_REFRESH_INTERVAL|60|signals_refresh|FLAGGED for human review"
  "SIGNALS_SIM_INTERVAL|120|signals_sim_track|"
  "GMGN_SIM_INTERVAL|120|gmgn_sim_track|"
  "GMGN_ACTIVITY_POLL_INTERVAL|180|gmgn_activity_poll|"
  "DLMM_SIM_TRACK_INTERVAL|300|dlmm_sim_track|"
  "DLMM_MANAGE_INTERVAL|60|dlmm_manage|FLAGGED for human review"
  "RH_CLMM_MANAGE_INTERVAL|300|rh_clmm_manage|"
  "SOL_ARB_SCAN_INTERVAL|60|sol_arb_scan|FLAGGED for human review"
  "GMGN_WALLET_DIGGER_INTERVAL|14400|gmgn_wallet_digger|"
  "GMGN_RADAR_DIGEST_INTERVAL|86400|gmgn_radar_digest|"
  "STRATEGY_SEARCH_INTERVAL|21600|strategy_search|"
)
# Deliberately NOT touched (listed so the output is a complete picture):
#   SOCIAL_SIM_INTERVAL=900 (intentional, docs/03), METRICS_COPY_INTERVAL=900 (intentional),
#   SLTP_MONITOR_INTERVAL, STRATEGY_REPORT_INTERVAL, REPORT_PRECOMPUTE_INTERVAL, DLMM_SCREEN_INTERVAL,
#   MCAP_TRACKER_SIM_INTERVAL, OHLC_SAMPLE_INTERVAL.
#   (GMGN_ROSTER_WATCH_INTERVAL, RH_LP_SCREEN_INTERVAL and MCAP_TRACKER_SIM_OPEN_INTERVAL were removed with their workers.)

RESTART_CMD='cd ~/reloadsol && docker compose up -d cron'

APPLY=0
SKIP=","
ENV_FILE="${ENV_FILE:-$HOME/reloadsol/.env}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --skip) shift; SKIP=",${1:-},"; ;;
    --env-file) shift; ENV_FILE="${1:?--env-file needs a path}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# Current value of KEY in FILE: the last assignment wins (that is what docker's env_file does).
current_value() { # <file> <key>
  grep -E "^$2=" "$1" | tail -n1 | sed -E "s/^$2=//; s/[[:space:]]*#.*$//; s/^[\"']//; s/[\"']$//" || true
}

run() {
  local file="$1"
  [ -r "$file" ] || { echo "cannot read $file" >&2; return 2; }

  local tmp; tmp="$(mktemp)"
  trap 'rm -f "$tmp" "${tmp}.out"' RETURN
  cp "$file" "$tmp"

  printf '%-30s %-20s %7s  %7s  %s\n' "ENV VAR" "WORKER" "BEFORE" "AFTER" "NOTE"
  local row key want worker note cur changed=0 missing=0 dup
  for row in "${INTENDED[@]}"; do
    IFS='|' read -r key want worker note <<<"$row"
    if [[ "$SKIP" == *",$key,"* ]]; then
      printf '%-30s %-20s %7s  %7s  %s\n' "$key" "$worker" "$(current_value "$file" "$key")" "(skip)" "--skip given${note:+; $note}"
      continue
    fi
    if ! grep -qE "^$key=" "$file"; then
      printf '%-30s %-20s %7s  %7s  %s\n' "$key" "$worker" "(unset)" "(unset)" "absent from file - NOT added; code default applies${note:+; $note}"
      missing=$((missing + 1)); continue
    fi
    dup="$(grep -cE "^$key=" "$file")"
    cur="$(current_value "$file" "$key")"
    # Keep any trailing comment; replace only the value (quotes dropped - these are bare integers).
    sed -E "s/^($key=)[^#[:space:]]*/\\1$want/" "$tmp" >"${tmp}.out" && cat "${tmp}.out" >"$tmp"
    if [ "$cur" = "$want" ]; then
      printf '%-30s %-20s %7s  %7s  %s\n' "$key" "$worker" "$cur" "$want" "already intended${note:+; $note}"
    else
      changed=$((changed + 1))
      printf '%-30s %-20s %7s  %7s  %s\n' "$key" "$worker" "$cur" "$want" "${note}$([ "$dup" -gt 1 ] && echo " (WARNING: $dup duplicate lines, all rewritten)")"
    fi
  done

  echo
  echo "--- diff (changed lines only; *_INTERVAL keys are the only lines this script can alter) ---"
  local d; d="$(diff -U0 "$file" "$tmp" | grep -E '^[-+][^-+]' || true)"
  if [ -z "$d" ]; then echo "(no changes)"; else
    # one -/+ pair per key, in table order, rather than diff's hunk order
    for row in "${INTENDED[@]}"; do
      IFS='|' read -r key want worker note <<<"$row"
      grep -qxF -- "-$(grep -E "^$key=" "$file" | tail -n1)" <<<"$d" 2>/dev/null || continue
      grep -E "^$key=" "$file" | sed 's/^/- /'
      grep -E "^$key=" "$tmp" | sed 's/^/+ /'
    done
  fi
  # Belt and braces: nothing but *_INTERVAL lines may differ.
  if grep -vE '^[-+][A-Z_]+_INTERVAL=' <<<"$d" | grep -q .; then
    echo "ABORT: the rewrite would change a non-interval line" >&2; return 3
  fi
  echo
  echo "$changed line(s) to change, $missing key(s) absent."
  if [ "$APPLY" != 1 ]; then
    echo "DRY RUN - nothing written. Re-run with --apply to back up and write."
    return 0
  fi
  if [ "$changed" -eq 0 ]; then echo "nothing to apply."; return 0; fi

  local bak="${file}.bak-$(date +%Y%m%d)"
  [ -e "$bak" ] && bak="${bak}-$(date +%H%M%S)"
  cp -p "$file" "$bak"
  cat "$tmp" >"$file"            # write in place: keeps owner, mode and inode
  echo "backed up to $bak"

  local bad=0
  for row in "${INTENDED[@]}"; do
    IFS='|' read -r key want worker note <<<"$row"
    [[ "$SKIP" == *",$key,"* ]] && continue
    grep -qE "^$key=" "$file" || continue
    [ "$(current_value "$file" "$key")" = "$want" ] || { echo "VERIFY FAILED: $key" >&2; bad=1; }
  done
  [ "$bad" = 0 ] || { echo "restore with: cp -p '$bak' '$file'" >&2; return 4; }
  echo "verified. NOT restarted. To take effect, run on the VPS:"
  echo "  $RESTART_CMD"
  echo "rollback: cp -p '$bak' '$file' && $RESTART_CMD"
}

if [ "${APPLY_CRON_INTERVALS_SELF_TEST:-0}" = "1" ]; then
  unset APPLY_CRON_INTERVALS_SELF_TEST
  d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
  cat >"$d/.env" <<'FIX'
API_KEY=super-secret-do-not-print
SIGNAL_REFRESH_INTERVAL=900
SLTP_MONITOR_INTERVAL=60
SIGNALS_SIM_INTERVAL=900
GMGN_SIM_INTERVAL=900
SOCIAL_SIM_INTERVAL=900
GMGN_ACTIVITY_POLL_INTERVAL=900
GMGN_RADAR_DIGEST_INTERVAL=600
GMGN_WALLET_DIGGER_INTERVAL=600  # shed
DLMM_SIM_TRACK_INTERVAL=900
DLMM_MANAGE_INTERVAL=900
RH_CLMM_MANAGE_INTERVAL=900
STRATEGY_SEARCH_INTERVAL=600
METRICS_COPY_INTERVAL=900
OTHER_SECRET=hunter2
FIX
  cp "$d/.env" "$d/.env.orig"
  fail=0
  ck() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
  out="$(ENV_FILE="$d/.env" bash "$0")"
  ck "dry run leaves the file byte-identical" 'cmp -s "$d/.env" "$d/.env.orig"'
  ck "dry run never prints a secret" '! grep -q "super-secret\|hunter2" <<<"$out"'
  ck "dry run reports SOL_ARB_SCAN_INTERVAL as absent, not added" 'grep -q "SOL_ARB_SCAN_INTERVAL.*absent" <<<"$out"'
  ENV_FILE="$d/.env" bash "$0" --apply >"$d/apply.out"
  ck "apply writes a dated backup identical to the original" 'cmp -s "$d"/.env.bak-* "$d/.env.orig"'
  ck "apply never prints a secret" '! grep -q "super-secret\|hunter2" "$d/apply.out"'
  ck "signals_refresh 900 -> 60" 'grep -qx "SIGNAL_REFRESH_INTERVAL=60" "$d/.env"'
  ck "wallet_digger keeps its trailing comment" 'grep -qx "GMGN_WALLET_DIGGER_INTERVAL=14400  # shed" "$d/.env"'
  ck "radar digest 600 -> 86400" 'grep -qx "GMGN_RADAR_DIGEST_INTERVAL=86400" "$d/.env"'
  ck "social sim stays 900" 'grep -qx "SOCIAL_SIM_INTERVAL=900" "$d/.env"'
  ck "metrics copier stays 900" 'grep -qx "METRICS_COPY_INTERVAL=900" "$d/.env"'
  ck "sltp stays 60" 'grep -qx "SLTP_MONITOR_INTERVAL=60" "$d/.env"'
  ck "non-interval lines untouched" 'grep -qx "API_KEY=super-secret-do-not-print" "$d/.env" && grep -qx "OTHER_SECRET=hunter2" "$d/.env"'
  ENV_FILE="$d/.env" bash "$0" --apply >"$d/again.out"
  ck "second apply is a no-op" 'grep -q "nothing to apply" "$d/again.out"'
  cp "$d/.env.orig" "$d/.env"
  ENV_FILE="$d/.env" bash "$0" --apply --skip DLMM_MANAGE_INTERVAL,SOL_ARB_SCAN_INTERVAL >/dev/null
  ck "--skip leaves a flagged key alone" 'grep -qx "DLMM_MANAGE_INTERVAL=900" "$d/.env"'
  [ "$fail" = 0 ] && echo "self-test OK" || { echo "self-test FAILED"; exit 1; }
  exit 0
fi

run "$ENV_FILE"
