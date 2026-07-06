#!/usr/bin/env bash
# Install daily Pattern ML cron (03:00 UTC) for the current user.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAILY_SCRIPT="$ROOT/scripts/ml-pattern-daily.sh"
CRON_MARKER="ml-pattern-daily.sh"
CRON_LINE="0 3 * * * cd $ROOT && bash scripts/ml-pattern-daily.sh >> logs/ml-pattern-daily.log 2>&1"

if [[ ! -f "$DAILY_SCRIPT" ]]; then
  echo "Missing $DAILY_SCRIPT"
  exit 1
fi

chmod +x "$DAILY_SCRIPT"
mkdir -p "$ROOT/logs"

EXISTING="$(crontab -l 2>/dev/null || true)"
if echo "$EXISTING" | grep -Fq "$CRON_MARKER"; then
  echo "Crontab already contains Pattern ML daily job:"
  echo "$EXISTING" | grep -F "$CRON_MARKER"
  exit 0
fi

{
  echo "$EXISTING"
  echo "# reloadSOL Pattern ML — export/train daily 03:00 UTC (24h cohort)"
  echo "$CRON_LINE"
} | crontab -

echo "Installed Pattern ML daily cron (03:00 UTC)."
echo ""
echo "Entry:"
echo "  $CRON_LINE"
echo ""
echo "Verify: crontab -l"
echo "Test now: bash scripts/ml-pattern-daily.sh --dry-run"
echo "Full run: bash scripts/ml-pattern-daily.sh"
echo "Logs:     tail -f logs/ml-pattern-daily.log"
