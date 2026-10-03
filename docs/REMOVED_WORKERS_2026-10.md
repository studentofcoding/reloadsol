# Removed Go cron workers (2026-10)

Five workers were dead or no-ops in production and were removed together with their schedule, manual trigger,
env knob, worker-registry row and (where nothing live calls it) their web route.

| Worker | Why it was dead (prod, 2026-10-04) | Removed |
|---|---|---|
| `fomo_ws` | `FOMO_WS_ENABLED=false`; last success 2026-09-07, WS handshake returned 301 afterwards | `fomo_ws*.go`, `/trigger/fomo-ws`, `FOMO_*` env |
| `gmgn_roster_watch` | `GMGN_ROSTER_WATCH_INTERVAL=0` (GMGN key tier cannot serve it, see `GMGN_RATE_BUDGET.md`) | Go job + `/trigger/gmgn-roster-watch`, web `POST /api/gmgn/roster-watch`, `src/strategies/wallet-digger/watch.ts`, `GMGN_ROSTER_WATCH_INTERVAL` |
| `rh_lp_screen` | `RH_LP_SCREEN_INTERVAL=0`; indexer host is NXDOMAIN | Go job + `/trigger/rh-lp-screen`, web `POST /api/dlmm/rh-lp-screen`, `runRhLpScreen` + paper-LP helpers, `RH_LP_SCREEN_INTERVAL` |
| `filtered_trending` | every 2 min it POSTed to a handler that returns "nothing to do" (Discord list removed) | Go job, web `POST /api/trending/filtered` (the public `GET` stays) |
| `mcap_tracker_sim_open` | no cron entry since the open phase moved into the `phase=all` job; only a manual trigger remained | `runMcapTrackerSimOpen`, `/trigger/mcap-tracker-sim-open`, `MCAP_TRACKER_SIM_OPEN_INTERVAL` |

## Kept on purpose (live callers)
* `unfiltered_trending` (real trending-cache refresh + mcap tracking) and `GET /api/trending/filtered`.
* `POST /api/mcap-tracking/sim-track` (`phase=open` logic runs inside `phase=all`).
* `GET/PATCH /api/gmgn/roster` (RosterTab, BulkTokenBuyer/Seller), `scoreRhPools` + `/api/dlmm/lp-terminal-pools`.
* `POST /api/fomo/ingest` (+ `FomoMirrorPanel` `GET`, `/dev/fomo`, `fomo-demand`/`fomo-fills` readers used by social
  sim-track and signals): the route has no cron caller any more, but it is still the read path for existing
  `fomo_*` tables and an external ingest endpoint. Candidate for a follow-up removal once those tables are retired.
* Orphaned helpers whose only caller was `watch.ts` (`wallet-digger/db.ts` roster-buy queries, `concurrence.ts`) are
  left in place; delete them in a follow-up once the `alpha_*` tables are retired.

## Ship notes
* The Go service changed: **rebuild and recreate `cron`** (`docker compose -f docker-compose.yml -f docker-compose.prod.yml build cron`
  then `up -d --no-deps cron`). Until then the old binary keeps running the (harmless) old schedule.
* Optional `.env` cleanup on the VPS (ignored by the new binary): `FOMO_WS_ENABLED`, `FOMO_WS_URL`, `FOMO_REST_BASE`,
  `FOMO_WS_KEEPALIVE_MS`, `FOMO_WS_RECONNECT_MS`, `FOMO_MAX_FILLS_PER_BATCH`, `FOMO_LAG_ALERT_SECONDS`,
  `GMGN_ROSTER_WATCH_INTERVAL`, `RH_LP_SCREEN_INTERVAL`, `MCAP_TRACKER_SIM_OPEN_INTERVAL`.
* `cron_worker_runtime` keeps stale rows for the five worker ids. Optional cleanup (not run by this PR):
  `DELETE FROM cron_worker_runtime WHERE worker_id IN ('fomo_ws','gmgn_roster_watch','rh_lp_screen','filtered_trending','mcap_tracker_sim_open');`
  (this also removes the one row that still holds an unredacted `?key=` URL, see `RUNBOOK_SCRUB_CRON_ERROR_SECRETS.md`).
