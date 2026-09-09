#!/usr/bin/env bash
# Deploy the Goldsky RH wallet ledger pipelines (tail + one-time backfill).
#
# Renders the YAML templates in goldsky/pipelines + goldsky/jobs with real
# wallets/host/tip, validates them, and (with --apply) applies them.
#
# Requirements: goldsky CLI + turbo extension installed and logged in
#   (curl https://goldsky.com | sh && curl https://install-turbo.goldsky.com | sh && goldsky login)
#
# Env (from .env or shell):
#   GMGN_BOUND_EVM_ADDRESS   required — the bound RH wallet to track
#   RH_TRACKED_PARENT_ADDRESS optional — Rabby parent wallet to track
#   APP_HOST                 required — public host, e.g. https://reloadsol.your.domain
#   RH_LEDGER_WEBHOOK_SECRET required — must match the app env var
#   RH_LEDGER_WEBHOOK_SECRET_NAME optional — Goldsky secret name from `goldsky
#                            secret list` (defaults to RH_LEDGER_WEBHOOK_SECRET)
#
# Usage:
#   bash scripts/goldsky-rh-ledger-deploy.sh            # render + validate only
#   bash scripts/goldsky-rh-ledger-deploy.sh --apply    # validate + apply backfill, then tail
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/goldsky/.rendered"
PIPELINE_TMPL="$ROOT/goldsky/pipelines/rh-wallet-ledger.yaml"
JOB_TMPL="$ROOT/goldsky/jobs/rh-wallet-ledger-backfill.yaml"
RPC_URL="${RPC_URL_4663:-${RPC_4663:-https://edge.goldsky.com/standard/evm/4663?key=gs_edge_cmti61jetiu4h01u9hwq1huk7}}"

fail() { echo "✗ $*" >&2; exit 1; }

# --- inputs ---------------------------------------------------------------
BOUND="${GMGN_BOUND_EVM_ADDRESS:-}"
PARENT="${RH_TRACKED_PARENT_ADDRESS:-}"
APP_HOST="${APP_HOST:-}"
SECRET="${RH_LEDGER_WEBHOOK_SECRET:-}"
GS_SECRET_NAME="${RH_LEDGER_WEBHOOK_SECRET_NAME:-RH_LEDGER_WEBHOOK_SECRET}"

[[ -n "$BOUND" ]] || fail "GMGN_BOUND_EVM_ADDRESS is required"
[[ -n "$APP_HOST" ]] || fail "APP_HOST is required (public host that reaches /api/rh/ledger/ingest)"
[[ -n "$SECRET" ]] || fail "RH_LEDGER_WEBHOOK_SECRET is required (must match the app's env)"
command -v goldsky >/dev/null || fail "goldsky CLI not found — run: curl https://goldsky.com | sh"

BOUND="$(printf '%s' "$BOUND" | tr '[:upper:]' '[:lower:]')"
PARENT="$(printf '%s' "$PARENT" | tr '[:upper:]' '[:lower:]')"

# Wallet filter clause for the transform SQL. Parent wallet is optional; when
# unset we track the bound wallet alone (an empty IN-list would be invalid SQL).
if [[ -n "$PARENT" ]]; then
  WALLET_WHERE="(sender IN ('$BOUND', '$PARENT') OR recipient IN ('$BOUND', '$PARENT'))"
else
  WALLET_WHERE="(sender = '$BOUND' OR recipient = '$BOUND')"
fi

# --- tip block for the backfill job --------------------------------------
TIP="$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC_URL" \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"],16))')" \
  || fail "could not fetch RH chain tip from $RPC_URL"
echo "ℹ RH chain tip: $TIP"

# --- render ---------------------------------------------------------------
mkdir -p "$OUT_DIR"
render() {
  local tmpl="$1" out="$2" tip="${3:-}"
  sed -e "s|<WALLET_WHERE>|$WALLET_WHERE|g" \
      -e "s|<APP_HOST>|${APP_HOST#https://}|g" \
      -e "s|<WEBHOOK_SECRET_NAME>|$GS_SECRET_NAME|g" \
      -e "s|<TIP_BLOCK>|$tip|g" "$tmpl" > "$out"
}
render "$PIPELINE_TMPL" "$OUT_DIR/rh-wallet-ledger.yaml"
render "$JOB_TMPL" "$OUT_DIR/rh-wallet-ledger-backfill.yaml" "$TIP"

echo "ℹ rendered to $OUT_DIR"

# --- validate -------------------------------------------------------------
goldsky turbo validate "$OUT_DIR/rh-wallet-ledger.yaml"
goldsky turbo validate "$OUT_DIR/rh-wallet-ledger-backfill.yaml"

if [[ "${1:-}" != "--apply" ]]; then
  echo ""
  echo "Validation OK. Re-run with --apply to deploy, e.g.:"
  echo "  bash scripts/goldsky-rh-ledger-deploy.sh --apply"
  echo "(The ingest route must already be live on $APP_HOST with the DB migration applied.)"
  exit 0
fi

echo "ℹ applying backfill job (history from genesis to $TIP)…"
goldsky turbo apply "$OUT_DIR/rh-wallet-ledger-backfill.yaml"
echo "ℹ applying live tail pipeline…"
goldsky turbo apply "$OUT_DIR/rh-wallet-ledger.yaml"
echo "✔ Deployed. Monitor with: goldsky turbo list"
