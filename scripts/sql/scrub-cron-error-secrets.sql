-- Redact credentials that older cron builds wrote into cron_worker_runtime.last_error_msg.
--
-- The Go cron used to log/persist the raw request URL (".../api/...?key=<TRENDING_TRACKER_SECRET>") in its
-- error text. Newer builds redact at write time (redactSecrets in main.go); this script cleans rows that were
-- written before that.
--
-- Safe by default: DRY RUN (prints the affected rows with the secret already masked, then ROLLBACKs).
--   dry run : psql -U reloadsol -d reloadsol_db -f scripts/sql/scrub-cron-error-secrets.sql
--   apply   : psql -U reloadsol -d reloadsol_db -v apply=1 -f scripts/sql/scrub-cron-error-secrets.sql
-- Idempotent: already-redacted rows no longer match. Only last_error_msg changes; updated_at and every
-- other column are left untouched. See docs/RUNBOOK_SCRUB_CRON_ERROR_SECRETS.md.
--
-- Pattern: query/form parameters named key | password | token | secret | auth | api_key | apikey
-- (case-insensitive), value = everything up to & whitespace quote < > ) or end of string.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

\echo '--- rows that will be changed (value masked in this preview) ---'
SELECT worker_id,
       last_error_at,
       length(last_error_msg) AS msg_len,
       regexp_replace(
         last_error_msg,
         '([?&](?:key|password|token|secret|auth|api_key|apikey)=)[^&\s"''<>)]+',
         '\1[REDACTED]',
         'gi'
       ) AS preview
  FROM cron_worker_runtime
 WHERE last_error_msg ~* '[?&](key|password|token|secret|auth|api_key|apikey)=[^&\s"''<>)]+'
   AND last_error_msg !~* '[?&](key|password|token|secret|auth|api_key|apikey)=\[REDACTED\]($|[&\s"''<>)])'
 ORDER BY worker_id;

UPDATE cron_worker_runtime
   SET last_error_msg = regexp_replace(
         last_error_msg,
         '([?&](?:key|password|token|secret|auth|api_key|apikey)=)(?!\[REDACTED\])[^&\s"''<>)]+',
         '\1[REDACTED]',
         'gi'
       )
 WHERE last_error_msg ~* '[?&](key|password|token|secret|auth|api_key|apikey)=(?!\[REDACTED\])[^&\s"''<>)]+';

\echo '--- rows still containing an unredacted credential parameter (expect 0) ---'
SELECT count(*) AS remaining
  FROM cron_worker_runtime
 WHERE last_error_msg ~* '[?&](key|password|token|secret|auth|api_key|apikey)=(?!\[REDACTED\])[^&\s"''<>)]+';

\if :{?apply}
  \echo 'apply=1 -> COMMIT'
  COMMIT;
\else
  \echo 'DRY RUN -> ROLLBACK (re-run with -v apply=1 to persist)'
  ROLLBACK;
\endif
