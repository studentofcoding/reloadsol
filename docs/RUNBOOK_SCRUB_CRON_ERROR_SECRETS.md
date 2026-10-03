# Runbook: scrub credentials from `cron_worker_runtime.last_error_msg`

**Status: NOT run on prod by the author of this PR. Operator-run, after ship.**

## Why
Older cron builds persisted the raw request URL, including `?key=<TRENDING_TRACKER_SECRET>`, in
`cron_worker_runtime.last_error_msg` (and in the Docker logs). Current builds redact at write time
(`redactSecrets` in `main.go`), but rows written earlier still hold the value, and the web `/api/workers/runtime`
route returns them to cron-secret holders. The secret *value is intentionally not rotated* (decision), so the
exposure is cleaned up rather than invalidated.

Read-only check on prod (2026-10-04): 31 rows in the table, 1 contained a credential parameter
(`mcap_tracker_sim_open`, a worker that is removed in the dead-worker PR). A scan of text/json columns whose names
look like error/log/message columns found no other table with `key=`/`token=`/`secret=`/`password=` values.
(`trending_token_tracker.logo_url` matches the pattern because of a legitimate URL parameter; leave it alone.)

## What the script does
`scripts/sql/scrub-cron-error-secrets.sql`

* Replaces the value of `key | password | token | secret | auth | api_key | apikey` query parameters with
  `[REDACTED]` (case-insensitive) in `last_error_msg` only. `updated_at` and all other columns are untouched.
* Idempotent: rows already containing `=[REDACTED]` are skipped.
* **Dry run by default** (everything runs inside a transaction that is rolled back unless `-v apply=1` is passed).
  The preview masks the value, so the output never prints a secret.
* Tested against a throwaway `postgres:16` container with synthetic rows (not against prod).

## Steps (on the VPS, `~/reloadsol`)
1. Take a quick backup of the table (small, 31 rows):
   ```bash
   docker exec reloadsol-db psql -U reloadsol -d reloadsol_db -c "\copy cron_worker_runtime to '/tmp/cron_worker_runtime.bak.csv' csv header"
   ```
   Note: the backup still contains the secret. Delete it after verifying (step 4).
2. Dry run (shows affected `worker_id`s, masked; expects `remaining = 0` then `ROLLBACK`):
   ```bash
   docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < scripts/sql/scrub-cron-error-secrets.sql
   ```
3. Apply:
   ```bash
   docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db -v apply=1 < scripts/sql/scrub-cron-error-secrets.sql
   ```
4. Verify (expect `0`) and clean up the backup:
   ```bash
   docker exec reloadsol-db psql -U reloadsol -d reloadsol_db -At -c \
     "select count(*) from cron_worker_runtime where last_error_msg ~* '[?&](key|password|token|secret|auth|api_key|apikey)=(?!\[REDACTED\])[^&\s\"<>)]+'"
   docker exec reloadsol-db rm -f /tmp/cron_worker_runtime.bak.csv
   ```
5. Do this **after** the cron container has been rebuilt with the redaction change; otherwise a fresh error can
   re-introduce a raw URL (`docker compose -f docker-compose.yml -f docker-compose.prod.yml build cron && ... up -d --no-deps cron`).

## Still exposed after the scrub (not covered by this script)
* Old `docker logs reloadsol-cron` output (json-file driver, rotated by the `x-logging` anchor) and any
  `.env.bak.*` files on the VPS, which contain the live secrets. Delete or lock down those backups.
* Git history: the old default value is committed. Since the value is not rotated, treat it as known to anyone
  with repo access; rotating `TRENDING_TRACKER_SECRET` (and `DLMM_API_PASSWORD`) later is the real fix.
