# Cron interval `.env` fix — prepared, NOT applied

Status: **prepared for operator review. Nothing in this change touches the VPS.** The `.env` was only
read (the `*_INTERVAL` lines, nothing else) on 2026-10-03 (Asia/Jakarta) to build the *before* column.

## What is wrong

A dozen cron jobs report `interval_sec: 900` (four more report 600). The Go code never defaulted to 900
except for the metrics copier (intentional). The values come from an uncommented block of
`*_INTERVAL=` lines in `/home/ubuntu/reloadsol/.env` (lines ~162-176), which `docker-compose.yml` feeds to
the cron container through `env_file: .env`. It is a manual load-shed that nothing recorded. Evidence and
the code-side hardening (loud overrides, no silent fallback) are in the cron-interval PR (`cron_intervals.go`).

The fix is a **`.env` edit + a cron container restart**. No rebuild is needed: the env var names below are
read by the *currently deployed* `main.go` as well as by the interval-table version.

## Worker → env var (exact names, from `main.go` / `cron_intervals.go` `intervalSpecs`)

| worker id | env var | Config field |
|---|---|---|
| signals_refresh | `SIGNAL_REFRESH_INTERVAL` *(singular `SIGNAL`)* | `SignalRefreshInterval` |
| signals_sim_track | `SIGNALS_SIM_INTERVAL` | `SignalsSimInterval` |
| gmgn_sim_track | `GMGN_SIM_INTERVAL` | `GmgnSimInterval` |
| gmgn_activity_poll | `GMGN_ACTIVITY_POLL_INTERVAL` | `GmgnActivityPollInterval` |
| dlmm_sim_track | `DLMM_SIM_TRACK_INTERVAL` | `DLMMSimTrackInterval` |
| dlmm_manage | `DLMM_MANAGE_INTERVAL` | `DLMMManageInterval` |
| rh_clmm_manage | `RH_CLMM_MANAGE_INTERVAL` | `RhClmmManageInterval` |
| rh_lp_screen | `RH_LP_SCREEN_INTERVAL` | `RhLpScreenInterval` |
| sol_arb_scan | `SOL_ARB_SCAN_INTERVAL` | `SolArbScanInterval` |
| gmgn_roster_watch | `GMGN_ROSTER_WATCH_INTERVAL` | `GmgnRosterWatchInterval` |
| gmgn_wallet_digger | `GMGN_WALLET_DIGGER_INTERVAL` | `GmgnWalletDiggerInterval` |
| gmgn_radar_digest | `GMGN_RADAR_DIGEST_INTERVAL` | `GmgnRadarDigestInterval` |
| strategy_search | `STRATEGY_SEARCH_INTERVAL` | `StrategySearchInterval` |

## Before / after (seconds)

"Before" is what `/home/ubuntu/reloadsol/.env` held on 2026-10-03. "After" is the intended cadence
(`intervalSpecs` default).

| worker | env var | before | after | direction | note |
|---|---|---:|---:|---|---|
| signals_refresh | `SIGNAL_REFRESH_INTERVAL` | 900 | **60** | 15× more often | **flagged — human review** |
| signals_sim_track | `SIGNALS_SIM_INTERVAL` | 900 | **120** | 7.5× | |
| gmgn_sim_track | `GMGN_SIM_INTERVAL` | 900 | **120** | 7.5× | |
| gmgn_activity_poll | `GMGN_ACTIVITY_POLL_INTERVAL` | 900 | **180** | 5× | |
| dlmm_sim_track | `DLMM_SIM_TRACK_INTERVAL` | 900 | **300** | 3× | |
| dlmm_manage | `DLMM_MANAGE_INTERVAL` | 900 | **60** | 15× | **flagged — human review** |
| rh_clmm_manage | `RH_CLMM_MANAGE_INTERVAL` | 900 | **300** | 3× | |
| rh_lp_screen | `RH_LP_SCREEN_INTERVAL` | 900 | **300** | 3× | |
| sol_arb_scan | `SOL_ARB_SCAN_INTERVAL` | 900 | **60** | 15× | **flagged — human review** |
| gmgn_roster_watch | `GMGN_ROSTER_WATCH_INTERVAL` | 600 | **75** | 8× | |
| gmgn_wallet_digger | `GMGN_WALLET_DIGGER_INTERVAL` | 600 | **14400** | 24× *less* often | |
| gmgn_radar_digest | `GMGN_RADAR_DIGEST_INTERVAL` | 600 | **86400** | 144× *less* often | a "daily" digest was running every 10 min |
| strategy_search | `STRATEGY_SEARCH_INTERVAL` | 600 | **21600** | 36× *less* often | |

Deliberately **unchanged**:

| worker | env var | value | why |
|---|---|---:|---|
| social_sim_track | `SOCIAL_SIM_INTERVAL` | 900 | docs say 900 on prod is intentional (30-minute burst window) — `docs/03-strategies-and-automation.md` |
| metrics_copier | `METRICS_COPY_INTERVAL` | 900 | the one intentional 900 (GMGN candle endpoint returns a series) |
| sltp_monitor | `SLTP_MONITOR_INTERVAL` | 60 | already right (was 900 until 2026-10-02) |
| strategy_report | `STRATEGY_REPORT_INTERVAL` | 86400 | already right |
| dlmm_screen | `DLMM_SCREEN_INTERVAL` | 300 | already right |
| mcap_tracker_sim_track | `MCAP_TRACKER_SIM_INTERVAL` | 120 | already right |
| — | `MCAP_TRACKER_SIM_OPEN_INTERVAL` | 120 | leave alone; code default 15, and after the interval-table change this knob schedules nothing |
| report_precompute, ohlc_sampler | `REPORT_PRECOMPUTE_INTERVAL`, `OHLC_SAMPLE_INTERVAL` | 21600, 15 | already right |

## Flagged for human review — kept at the intended value, but look first

`sol_arb_scan`, `dlmm_manage` and `signals_refresh` go from 900 s to **60 s: a 15× increase in call rate**.
They are set to the intended cadence as asked, but they were raised to 900 during a manual load-shed, and
nobody recorded why. Before applying, a human should confirm:

- **`signals_refresh` (60)** — drives GMGN reads; check the budget in `docs/GMGN_RATE_BUDGET.md`.
- **`dlmm_manage` (60)** — manages DLMM LP positions; confirm the manage path is safe to run every minute
  (it was `86400` on 2026-09-23 and `900` since).
- **`sol_arb_scan` (60)** — quote/RPC traffic every minute; check provider quota.
- The cron container has `memory: 128M` (`docker-compose.yml`); the shed may have been memory/CPU relief.
  Watch `docker stats reloadsol-cron` after the restart.

To apply everything *except* the flagged three and decide on them separately:

```bash
scripts/apply-cron-intervals.sh --apply --skip SIGNAL_REFRESH_INTERVAL,DLMM_MANAGE_INTERVAL,SOL_ARB_SCAN_INTERVAL
```

## How to apply (operator, on the VPS)

```bash
cd ~/reloadsol   # the script must be on the host (merge this PR and pull, or copy the one file)

# 1. Dry run (default). Prints the before/after table and the changed lines. Writes nothing.
bash scripts/apply-cron-intervals.sh

# 2. Apply. Backs up to .env.bak-<YYYYMMDD> first, rewrites ONLY the 13 *_INTERVAL lines above,
#    prints the diff, re-reads the file and verifies. Does not restart anything.
bash scripts/apply-cron-intervals.sh --apply

# 3. Restart only the cron container so it re-reads env_file.
docker compose up -d cron
#    On prod use the same -f flags your last deploy used, e.g.
#    docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d cron
#    `up -d` recreates the container when the resolved env changed. If `docker exec reloadsol-cron env |
#    grep _INTERVAL` still shows the old numbers, add --force-recreate.
```

Rollback: `cp -p .env.bak-<date> .env && docker compose up -d cron` (the script prints this exact line).

The script's own test (`APPLY_CRON_INTERVALS_SELF_TEST=1 bash scripts/apply-cron-intervals.sh`) runs against a
fixture `.env`, never the real one: dry run is byte-identical, secrets are never printed, trailing comments
are kept, absent keys are reported not added, `--skip` works, a second apply is a no-op.

## Verify after the restart

1. **Effective intervals** — the registry row reports them (the table `cron_worker_runtime` stores run
   timestamps, not intervals, so the interval itself comes from the cron service):

   ```bash
   curl -s http://127.0.0.1:8080/workers | python3 -c 'import sys,json; [print("%-26s %6s" % (w["id"], w["interval_sec"])) for w in json.load(sys.stdin)["workers"]]'
   # with the interval-table PR deployed, the startup log also prints "cron intervals (effective / default)":
   docker logs reloadsol-cron 2>&1 | grep -A30 'cron intervals (effective'
   ```

2. **Are they actually running at that cadence** — `cron_worker_runtime` (run it on the host through the db
   container, like `scripts/check-sltp-closer-freshness.sh`). It deliberately does **not** select
   `last_error_msg`: that column can hold request URLs.

   ```bash
   docker exec reloadsol-db psql -U reloadsol -d reloadsol_db -c "
   WITH expected(worker_id, interval_sec) AS (VALUES
     ('signals_refresh',60),('signals_sim_track',120),('gmgn_sim_track',120),('gmgn_activity_poll',180),
     ('dlmm_sim_track',300),('dlmm_manage',60),('rh_clmm_manage',300),('rh_lp_screen',300),
     ('sol_arb_scan',60),('gmgn_roster_watch',75),('gmgn_wallet_digger',14400),
     ('gmgn_radar_digest',86400),('strategy_search',21600),
     ('social_sim_track',900),('metrics_copier',900))
   SELECT e.worker_id,
          e.interval_sec                                                   AS expected_s,
          ROUND(EXTRACT(EPOCH FROM (NOW() - r.last_started_at)))::int      AS since_start_s,
          ROUND(EXTRACT(EPOCH FROM (NOW() - r.last_success_at)))::int      AS since_success_s,
          ROUND(EXTRACT(EPOCH FROM (NOW() - r.last_error_at)))::int        AS since_error_s,
          CASE WHEN r.worker_id IS NULL THEN 'NO ROW'
               WHEN r.last_started_at IS NULL THEN 'NEVER STARTED'
               WHEN r.last_started_at < NOW() - make_interval(secs => e.interval_sec * 2 + 60) THEN 'STALE'
               WHEN r.last_error_at IS NOT NULL
                AND (r.last_success_at IS NULL OR r.last_error_at > r.last_success_at) THEN 'LAST RUN FAILED'
               ELSE 'ok' END                                               AS status
     FROM expected e LEFT JOIN cron_worker_runtime r USING (worker_id)
    ORDER BY (CASE WHEN r.worker_id IS NULL THEN 0 ELSE 1 END), e.interval_sec, e.worker_id;"
   ```

   Healthy: every row `ok` and `since_start_s` below `expected_s` (plus the job's stagger and runtime).
   Wait at least one `expected_s` (the 86400 / 21600 / 14400 jobs will not show a fresh run for hours — judge
   those on the registry value in step 1, not on `since_start_s`). `STALE` right after the restart just
   means the job has not fired yet. Re-run after ~5 minutes; any `LAST RUN FAILED` on a job whose cadence
   you raised (the three flagged above first) is the signal to roll back that key.

3. **Load** — `docker stats --no-stream reloadsol-cron` and the web container's CPU, before and ~10 minutes
   after (the call rate of ten jobs goes up).
