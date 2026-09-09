# Goldsky RH Ledger — rollout checklist

End-to-end build for RH token **holdings + history + PnL** backed by a Goldsky
Turbo ledger (see `GOLDSKY_RH_LEDGER.md` for architecture). Code is done and
tested; the open items are the deploy steps that need **your** VPS / Goldsky
credentials.

## ✅ Done (agent) — code, configs, tests

- [x] `db/init/30-rh-ledger.sql` — `rh_ledger_transfers`, `rh_token_meta`, `tracked_rh_wallets`
- [x] `goldsky/pipelines/rh-wallet-ledger.yaml` + `goldsky/jobs/rh-wallet-ledger-backfill.yaml` (validated against real dataset `robinhood_mainnet.erc20_transfers` v1.1.0)
- [x] `scripts/goldsky-rh-ledger-deploy.sh` — render + validate + `--apply` (fills wallets/host/tip from env)
- [x] `src/app/api/rh/ledger/ingest/route.ts` — webhook ingest (Bearer-secret, idempotent upsert, batch-tolerant)
- [x] `src/app/api/rh/ledger/history/route.ts` — ledger history API
- [x] `src/utils/rh-ledger.ts` + tests — event expansion, chunked upsert, holdings netting, metadata, history
- [x] `/api/rh/wallet-tokens` — **ledger is now tier 0** (old GMGN→Blockscout→RPC ladder = fallback only); `source:"ledger"` in response
- [x] PnL — RH fills confirmed price-marked; daily cron already covers all chains; RH PnL pinned by tests (`pnl-wallet-rh.test.ts`)
- [x] Docs — `GOLDSKY_RH_LEDGER.md`, `goldsky/README.md`, `.env.docker.example` (+ `.gitignore` for rendered configs)
- [x] Verified: `tsc --noEmit` clean · eslint clean · 844 tests / 842 pass (2 pre-existing env/network failures: live Blockscout test — Blockscout CF-403s servers — and an env-dependent executor test)
- [x] Goldsky toolchain on this machine: CLI v13.10.2 logged in (project `reloadsol`), turbo extension installed

## ☐ YOU — pre-deploy (one-time)

- [ ] **1. Bound wallet confirmed** — `GMGN_BOUND_EVM_ADDRESS` set in your VPS `.env` (already used by RH swaps). Decide if you also track the **Rabby parent** wallet: if yes, set `RH_TRACKED_PARENT_ADDRESS=<0x…>` in the VPS `.env`. No parent = bound-wallet mode only (list will be correct there; parent-mode holdings need parent added).
- [ ] **2. Webhook secret** — add to the VPS `.env` (both must match):
      `RH_LEDGER_WEBHOOK_SECRET=<long-random-token>` (web container reads `.env` via `env_file`).
- [ ] **3. Create the Goldsky `httpauth` secret** (on this machine or the VPS):
      `goldsky secret create RH_LEDGER_WEBHOOK_SECRET` → type `httpauth`, header `Authorization`, value `Bearer <same-token>`.
- [ ] **4. Apply the DB migration** on the VPS (existing DB; fresh deploys auto-run `db/init/*`):
      `docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < db/init/30-rh-ledger.sql`
- [ ] **5. Deploy the app code** to the VPS (push → `flowey-vps` `git pull` → docker rebuild) so the ingest/history routes and env land.

## ☐ YOU — deploy Goldsky pipelines

- [ ] **6. Render + validate:** `bash scripts/goldsky-rh-ledger-deploy.sh` (env: `GMGN_BOUND_EVM_ADDRESS`, optional `RH_TRACKED_PARENT_ADDRESS`, `APP_HOST` = your public host, `RH_LEDGER_WEBHOOK_SECRET`).
- [ ] **7. Apply (backfill first, then tail):** `bash scripts/goldsky-rh-ledger-deploy.sh --apply`
- [ ] **8. Watch it run:** `goldsky turbo list` — backfill job completes and self-deletes; tail stays ACTIVE.

## ☐ YOU — acceptance checks (live)

- [ ] **9. Holdings from the ledger:** `curl "https://<host>/api/rh/wallet-tokens?wallet=<bound>&fresh=1"` → `"source":"ledger"`, tokens match real wallet, **no stale/old tokens**, USD > 0.
- [ ] **10. Live update:** do a real RH buy/sell → within seconds `fresh=1` reflects it (no 20 s cache wait). Rows also visible at `/api/rh/ledger/history?wallet=<wallet>&limit=10`.
- [ ] **11. PnL includes RH:** `curl -X POST "https://<host>/api/pnl/update?key=$PNL_UPDATE_SECRET"` → RH wallet's `token_operations.trade_pnl` moves.
- [ ] **12. Failover sanity:** (optional) stop/break GMGN keys → list still served from ledger; truncate `rh_ledger_transfers` → old ladder still answers (no regression).

## Optional / backlog

- [ ] Track an additional wallet later: add address to the tail YAML `IN (...)` + run the backfill job once (see `goldsky/README.md`).
- [ ] If your holdings include RH "stock tokens" that aren't plain ERC-20, add Goldsky's stock-token transfer dataset as a second source (verify with `goldsky dataset list --output json | grep robinhood`).
