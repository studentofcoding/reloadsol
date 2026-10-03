# SPEC — Evidence bar archive (R2) v1

**Status:** Implemented behind `EVIDENCE_ARCHIVE_ENABLED` (default off). Map: [#140](https://github.com/studentofcoding/reloadsol/issues/140), snapshot ticket #144, decision #142 ("reported data must be provable").
**Surface:** `src/strategies/evidence-archive*.ts`, `src/utils/r2-store.ts`, `src/utils/s3-sigv4.ts`, `POST /api/evidence/archive`, Go worker `evidence_archive`, `scripts/evidence-archive-restore.ts`, `db/init/63-evidence-archive-runs.sql`.

## Problem (measured 2026-10-04)

`token_ohlc_bars` is a rolling window (`OHLC_BARS_RETENTION_HOURS`, default 48): 737 k rows / 539 MB covering exactly 2026-10-02 02:57 → 10-04 02:51 WIB, ~440 k rows per full day. Everything older is deleted by the sampler. The paper-trading verdicts (map #140) depend on the bars that existed around each entry, and 44 of 50 orphan cycles in the contamination study had no bars left to replay. Postgres is the working set; it cannot also be the audit trail on a 3.6 GiB VPS.

## Decision

A daily job copies every **complete UTC day** of 1m bars, plus the related evidence tables, to Cloudflare R2 as gzip NDJSON. The archive is append-only and is the durable copy.

| Dataset | Table | Day column | Note |
|---|---|---|---|
| `token_ohlc_bars` | `token_ohlc_bars` | `timestamp` | the point of the job |
| `token_info_detect` | same | `created_at` | frozen Token Info tiles |
| `token_detect_snapshots` | same | `detected_at` | OHLC detect captures |
| `strategy_outcomes` | same | `created_at` | closes + features |
| `sl_tp_positions` | same | `updated_at` | mutable: state of rows last touched that day |
| `trading_records` | same | `timestamp` | paper + live ledger rows |
| `token_entry_context` | same | `created_at` | optional — added by the entry-freeze PR; skipped while the table is absent |
| `position_open_attempts` | same | `created_at` | optional — added by the open-attempts PR |

### Object layout (never overwritten)

```
<R2_ARCHIVE_PREFIX>/<dataset>/YYYY/MM/DD/<dataset>-YYYY-MM-DD.ndjson.gz     one row = to_jsonb(table row)
<R2_ARCHIVE_PREFIX>/manifests/YYYY/MM/DD/manifest-<runStamp>.json           per run, per day
```

- Written with `If-None-Match: *`. R2 answers 412 for an existing key and the bytes are untouched. A re-run that finds the key compares the stored `x-amz-meta-sha256`: identical → done; different → `conflict` (recorded loudly, **not** overwritten).
- A day is exported only when it is complete: `day end + EVIDENCE_ARCHIVE_GRACE_HOURS` (default 2 h) ≤ now. So an object is final when written. Late rows for an archived day would need a new object; the job logs nothing for them — the DB-side `COUNT(*)` vs manifest `rows` is the audit (the restore script's `verify` re-hashes the stored object).
- Manifest per dataset: `rows`, `min_ts`, `max_ts`, `bytes_gz`, `bytes_raw`, `sha256_gz`, `sha256_raw`, `status`, `object_key`. Manifests use a run stamp in the key so they are never overwritten either.
- `evidence_archive_runs` (db/init/63) is the attempt log; a `ok|empty` row per (dataset, day) is unique and is the prune-safety signal.

### Retention

Default retention is **unchanged** (48 h). With the archive on, set `OHLC_PRUNE_REQUIRES_ARCHIVE=1`: the sampler's prune is clamped to the start of the oldest complete day (inside `EVIDENCE_ARCHIVE_LOOKBACK_DAYS`, default 3) that has no done row, and keeps everything if the ledger cannot be read. Nothing is lost while R2 is down; the table just grows until it recovers.

Extending retention to 72 h is safe on the VPS if wanted (measured 2026-10-04: 539 MB for 48 h ≈ 270 MB/day; disk 13 GB free of 59 GB; table is index-only on `timestamp`). It is not needed once the archive runs, so the default stays 48 h. `OHLC_BARS_RETENTION_HOURS=72` is the knob.

### Scheduling

Go cron worker `evidence_archive` (`EVIDENCE_ARCHIVE_INTERVAL`, default 86400, 0 disables) → `POST /api/evidence/archive?key=<TRENDING_TRACKER_SECRET>`. Same shape as `metrics_copier`: `409`/`{skipped:true}` is a skip, a 5xx is a failure on the worker row. Scheduling it is safe: the route answers `{skipped:true}` until `EVIDENCE_ARCHIVE_ENABLED=1`, and answers `503 {missing_env:[…]}` (names only) if enabled without credentials. Per run it handles at most `EVIDENCE_ARCHIVE_MAX_DAYS_PER_RUN` (3) days and refuses to build an object over `EVIDENCE_ARCHIVE_MAX_OBJECT_MB` (128) so it cannot exhaust container memory.

### Restore / replay

`npm run evidence:archive -- list|verify|replay|restore-bars` (`scripts/evidence-archive-restore.ts`). Read-only except `restore-bars --yes`, which does `INSERT … ON CONFLICT (token_address, interval, timestamp) DO NOTHING`. `--dir=` reads a local mirror of the bucket (e.g. `rclone sync`), so analysis works offline.

## Env (all optional until enabled)

| Name | Purpose |
|---|---|
| `EVIDENCE_ARCHIVE_ENABLED` | `1` to run the job |
| `EVIDENCE_ARCHIVE_KILL_SWITCH` | `1` stops it without redeploying |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | **secrets to add** (R2 S3 API token with object read/write on the bucket) |
| `R2_ENDPOINT` | override host (EU jurisdiction / tests) |
| `R2_ARCHIVE_PREFIX` | default `reloadsol-evidence/v1` |
| `EVIDENCE_ARCHIVE_GRACE_HOURS` / `_LOOKBACK_DAYS` / `_MAX_DAYS_PER_RUN` / `_PAGE_SIZE` / `_MAX_OBJECT_MB` / `_DATASETS` | tuning |
| `OHLC_PRUNE_REQUIRES_ARCHIVE` | `1` = never prune an un-archived day |
| `EVIDENCE_ARCHIVE_INTERVAL`, `EVIDENCE_ARCHIVE_TIMEOUT_SEC` | Go worker |

## Out of scope

Deleting from R2 (no delete path exists by design); lifecycle rules (set in the Cloudflare dashboard if wanted); archiving mutable "current" tables that are re-derivable (`token_mcap_tracking`); compaction into Parquet.

## Acceptance

- [x] Object key includes the date; `If-None-Match: *`; a differing existing object is a loud `conflict`, never overwritten
- [x] Manifest with rows, min/max ts, sha256
- [x] Inert without flag; names missing secrets without leaking values
- [x] Prune cannot delete an un-archived day when `OHLC_PRUNE_REQUIRES_ARCHIVE=1`
- [x] Restore/replay reader with sha256 verification
- [x] AWS SigV4 vector test; idempotent re-run test; Go interval table pins the new worker
