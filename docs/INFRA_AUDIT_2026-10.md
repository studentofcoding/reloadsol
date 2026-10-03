# Infra trim + harden audit — 2026-10-04 (read-only evidence; prod untouched)

Evidence is from the repo at `origin/main` 68487b5 and read-only probes of the VPS. Implemented items are marked
**DONE (PR …)**; everything else is a decision/follow-up with the reason it was not done.

## Implemented
| Item | Evidence | Change |
|---|---|---|
| `signals_sim_track` blocked ~15 min after each web restart | `withJobLock('signals_sim_track', 900)` stored a 900 s lease with no heartbeat; a recreated container has a new hostname so `sweepOrphanedLocks` can't prove the owner dead. Cron log: `Signals sim track skipped (job lock held)` every 2 min for 15 min after both ships (01:21 and 01:49 WIB). | **DONE**: `withJobLock` stores a 90 s lease (`BOT_JOB_LOCK_LEASE_SEC`) renewed every 30 s; the route ttl is now the *max hold*. Affects signals/gmgn/mcap/social sim-track + strategy_search. |
| GMGN IP-ban state held only in web memory | `gmgn-api.ts` `const ipBan` module variable; a web ship during a ban sent the first request straight into it (each extra request extends the ban). | **DONE**: ban persisted to Redis (`gmgn:ip-ban`, fail-open) and hydrated once per process before the first request. |
| `?key=` secret in cron logs | Go `makeRequest` redacts the "Making request" line and errors, but the 409 skip line (`… skipped: previous run still in progress`) and `Worker runtime persist failed` logged the raw URL; old `cron_worker_runtime.last_error_msg` rows also hold a plaintext key. | **DONE (Go; needs a cron rebuild to take effect)**: both lines redacted. Stored old rows: see decisions. |
| Price V3 429s on the keyed bucket | see `docs/JUPITER_API_MAP.md` | **DONE** (separate PR). |
| Unbounded container logs | `docker inspect … LogConfig` = `json-file {}` on web/cron/nginx/social-ingest/db; no `/etc/docker/daemon.json`. | **DONE**: compose `x-logging` 20 MB × 5. |
| nginx has no healthcheck | `docker ps` shows no health state for `reloadsol-nginx`. | **DONE**: wget `/api/health` with `Host: reloadsol.app`. |
| Web killed mid-cycle | default 10 s stop grace. | **DONE**: `stop_grace_period: 30s` on web. |
| Dead one-off scripts | 8 files under `scripts/` with zero references anywhere (package.json, docs, scripts, workflows), last touched ≤ Jul 2026: `check-duplicates.js`, `db-client.js`, `fix-invalid-prices.js`, `replace-img-tags.js`, `sync-existing-positions.js`, `test-cors.js`, `test-puppeteer-capture.js`, `toggle-trading-mode.js`. | **DONE** (deleted). |

## Needs a decision (not implemented)
1. **Open API surface.** `getApiAccessTier` defaults to `'open'`: 53 of 194 `route.ts` files resolve open for at least one
   method, ~33 with no in-route auth, including `shyft/transaction/send_rpc|send_txn|send_many_txns` (POST → 400 from
   the VPS with no credentials, i.e. reachable), `gmgn/trade/swap`, `gmgn/roster` (PATCH), `rh/rpc`,
   `solanatracker/send|swap`, `kyber/build`, `sol-arb/scan` (POST). `send_rpc` is called from the browser
   (`swap-executor.ts:612`), so it needs the *wallet-session* tier, not a secret. Recommended: flip the default tier to
   `wallet` and list public routes explicitly — a behaviour change that needs a front-end pass, hence a decision.
2. **Cron secret = committed default.** `TRENDING_TRACKER_SECRET` falls back to a literal in ~20 routes and
   `.env.docker.example`, and the prod value equals it (visible as `key=` in cron logs). Rotate on the VPS `.env`
   (web + cron + bouncer all read it) and delete the code fallbacks. Also `DLMM_API_PASSWORD` falls back to a literal
   in `api-auth.ts`. Moving cron from `?key=` to `Authorization: Bearer` is supported by `hasMatchingSecret` for some
   routes but the sim-track routes use `isAuthorizedRequest(key, …)` — needs a route sweep + cron rebuild.
3. **Scrub old `cron_worker_runtime.last_error_msg` rows** that contain a plaintext key (prod DB write).
4. **Go workers that are dead or no-ops (each needs a cron rebuild):**
   - `fomo_ws` — disabled, last success 2026-09-07, `ws handshake status 301`.
   - `gmgn_roster_watch` — `GMGN_ROSTER_WATCH_INTERVAL=0` in prod (disabled).
   - `rh_lp_screen` — `RH_LP_SCREEN_INTERVAL=0` (disabled; last error `API error 500: fetch failed`).
   - `filtered_trending` — POST `/api/trending/filtered` is now an authenticated no-op (Discord removed, #137).
   - `mcap_tracker_sim_open` — `next_run_at` empty, last success 2026-09-29 (superseded by `phase=all`); shows "stale".
   Matching routes (`/api/gmgn/roster-watch`, `/api/dlmm/rh-lp-screen`, …) can go with them.
5. **`mutil_window_token_info` soft 429s.** ~4 per 10 min (`windowMisses`), already negatively cached
   (`WINDOW_SOFT_COOLDOWN_MS`) and treated as a soft miss — working as designed; leave unless GMGN window data stops mattering.
6. **Remaining `acquireJobLock` callers without a heartbeat** (`trending_rh_sim` 1800 s, `trending_track` 600 s,
   `rh_clmm_manage` 300 s, `dlmm_manage`, `sltp_monitor` 120 s, `ohlc_sampler` 60 s): same dead-owner wait after a
   restart, up to their TTL. Convert to `withJobLock`-style leases one at a time.
7. **`social-ingest` has no healthcheck** (the image's liveness signal is unknown here) and **memory limits**: cron 128 MiB
   (using ~10 MiB — could be 64 MiB), web 768 MiB (~280 MiB). Right-sizing is a prod-config change.
8. **`DATABASE_STATEMENT_TIMEOUT_MS`** is in `.env.docker.example` but referenced nowhere in src/go/scripts/compose.
9. **Remaining unreferenced scripts** kept on purpose (recent, operational): `verify-*.ts`, `update-pnl.js`,
   `check-open-price-pubsub.sh`, `run-*-on-vps.sh`.
