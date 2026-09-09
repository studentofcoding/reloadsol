# Goldsky RH Ledger — rollout checklist

## ✅ Done (agent) — code, configs, tests
- [x] `db/init/30-rh-ledger.sql` — ledger tables (applied to VPS `reloadsol_db`)
- [x] `goldsky/pipelines/rh-wallet-ledger.yaml` + `goldsky/jobs/rh-wallet-ledger-backfill.yaml`
- [x] `scripts/goldsky-rh-ledger-deploy.sh` — render + validate + apply
- [x] Ingest route `/api/rh/ledger/ingest` (Bearer, idempotent) + history API + ledger utils/tests
- [x] `/api/rh/wallet-tokens` ledger tier 0 (indexer ladder = fallback)
- [x] RH PnL pinned by tests; docs; env example
- [x] Verified: tsc/lint clean, 842/844 tests (2 pre-existing env/network), `next build` passes

## ✅ Done (agent) — deployment
- [x] Committed + pushed (73e8cd7, 41a4350) — incl. fix moving price/meta helpers to server-only module after VPS build caught a client-bundle break
- [x] VPS env: `RH_LEDGER_WEBHOOK_SECRET` + `RH_TRACKED_PARENT_ADDRESS=0x795b…603d` (the wallet found from real RH fills)
- [x] VPS DB migration applied; app deployed & healthy (`reloadsol-web` Up)
- [x] Goldsky `httpauth` secret `HTTPAUTH_SECRET_CMTU6VNUZ0` created (Bearer …)
- [x] Ingest live: 401 without secret / 200 with (https://reloadsol.app/api/rh/ledger/ingest)
- [x] Backfill job applied (bounded genesis-skip → tip 58,623,740); E2E proven: **74 ledger rows already inserted** via webhook
- [ ] Tail pipeline `reloadsol-rh-wallet-ledger` — **auto-applies when the backfill finishes** (background watcher; Starter plan = 1 pipeline at a time)

## ⏳ In flight (no action needed)
- [ ] Backfill `reloadsol-rh-wallet-ledger-backfill` Running (~2.8k blocks/s, at ~17.5M of 58.6M; ETA ~4 h on the Starter s-size worker). On completion the watcher applies the tail; rows keep streaming.

If the watcher dies (session closed) and the job is gone, finish manually:
```bash
export PATH="$PATH:$HOME/.goldsky/bin"
GMGN_BOUND_EVM_ADDRESS=0x795b5c0c89fc5d3b0de6c04141c3f1b6c340603d \
RH_LEDGER_WEBHOOK_SECRET=<token> \
RH_LEDGER_WEBHOOK_SECRET_NAME=HTTPAUTH_SECRET_CMTU6VNUZ0 \
APP_HOST=https://reloadsol.app \
bash scripts/goldsky-rh-ledger-deploy.sh --apply
```

## ☐ YOU / acceptance (after backfill completes)
- [ ] `/api/rh/wallet-tokens?wallet=0x795b…603d&fresh=1` → `"source":"ledger"`, tokens match the wallet, no stale tokens, USD > 0
- [ ] `/api/rh/ledger/history?wallet=0x795b…603d&limit=10` returns recent transfers
- [ ] Next real RH trade appears in the list immediately (fresh=1) and in history
- [ ] Optional: `POST /api/pnl/update?key=…` → RH wallet `trade_pnl` moves
