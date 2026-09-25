# SPEC — Postgres index hygiene v1

**Status:** Shipped. Migration [`db/init/40-index-hygiene.sql`](../../db/init/40-index-hygiene.sql) applied to prod `reloadsol_db` 2026-09-25.
**Evidence base:** live `pg_stat_user_indexes` / `pg_stat_user_tables` / `pg_stat_database` plus `pg_get_indexdef` compared against the actual SQL in `src/`.

## 1. Problem

**178 indexes / 807 MB. 88 had never been scanned once (`idx_scan = 0`) and held 519 MB — 64% of all index space** — while four real query shapes seq-scanned a table with no support.

The counters are trustworthy: `SELECT stats_reset FROM pg_stat_database` returns **`never`**, so `idx_scan` spans the database's whole life, not a recent window.

The single biggest offender was `idx_trading_records_data_gin` — **438 MB, zero scans**, i.e. 54% of all index space on the hottest table (`trading_records`: 675 MB total, 160,366 rows, 638k index scans).

## 2. Root cause: the indexed expression does not match the predicate

`db/init/28-search-indexes.sql` created it for *"Q7: token containment in trading_records.jsonb `data` (sim activity poll)"*:

```sql
CREATE INDEX idx_trading_records_data_gin ON trading_records USING gin (data);
```

The only containment query in the codebase is [`token-map-activity.ts`](../../src/strategies/token-map-activity.ts):

```sql
WHERE wallet_address = ANY($1::text[])
  AND timestamp >= $2::timestamptz
  AND data->'tokens' @> jsonb_build_array(jsonb_build_object('mintAddress', $3))
ORDER BY timestamp DESC LIMIT $4
```

The predicate is `data->'tokens' @>`, the index is on `(data)`. Postgres can only use a GIN index when the indexed **expression** matches — so it never could, and the index was never scanned once in the database's lifetime. The planner instead used `idx_trading_records_timestamp` and filtered 66,161 rows to return nothing (159 ms).

The same class of bug explains the two `fomo_fills` indexes: [`fomo-demand.ts`](../../src/utils/fomo-demand.ts) filters on `lower(token_address)`, so a btree on the plain column could only be scanned end-to-end and then filtered.

## 3. Changes — `db/init/40-index-hygiene.sql`

All statements are `CONCURRENTLY` + `IF [NOT] EXISTS`: re-runnable, and no write lock on the hot tables. Applied with `psql -f` (auto-commit) — a `CONCURRENTLY` statement cannot run inside a transaction.

| Action | Index | Table | Reason |
|---|---|---|---|
| DROP | `idx_trading_records_data_gin` | trading_records | 438 MB, gated on `(data)` vs a `data->'tokens' @>` predicate — unmatchable |
| CREATE | `idx_trading_records_tokens_gin` `gin ((data->'tokens') jsonb_path_ops)` | trading_records | indexes the expression the query actually uses |
| CREATE | `idx_fomo_fills_token_lower_ts` `(lower(token_address), occurred_at DESC)` | fomo_fills | the query filters `lower(token_address)` |
| CREATE | `idx_fomo_fills_occurred` `(occurred_at DESC)` | fomo_fills | fomo/ingest `ORDER BY occurred_at DESC LIMIT n` had no index at all |
| DROP | `idx_fomo_fills_token_ts` | fomo_fills | superseded by the expression index; 0 scans |
| DROP | `idx_fomo_fills_wallet_ts` | fomo_fills | no query reads fomo_fills by wallet (all four call sites verified); 0 scans |
| CREATE | `idx_alpha_wallet_roster_score` `(score DESC, updated_at DESC)` | alpha_wallet_roster | the unfiltered top-N roster read had no support |

`db/init/28-search-indexes.sql` was also corrected at the source, so a fresh database no longer builds the unusable whole-`data` GIN just to have `40` drop it.

## 4. Measured result (prod, `EXPLAIN ANALYZE, BUFFERS`)

| Query | Before | After |
|---|---|---|
| trading_records token containment | 159 ms · Index Scan on `timestamp` + **66,161 rows removed by filter** | **1.8–4.4 ms** · `BitmapAnd(idx_trading_records_tokens_gin, idx_trading_records_wallet)` |
| fomo_fills demand (`lower(token_address)`) | 187 ms · whole-index scan then filter | **0.055 ms** · Index Cond on `idx_fomo_fills_token_lower_ts` |
| fomo/ingest `ORDER BY occurred_at DESC LIMIT 50` | 427 ms · Parallel Seq Scan + top-N sort | **1.6 ms** · Index Scan on `idx_fomo_fills_occurred` |
| alpha_wallet_roster unfiltered top-50 | Seq Scan + sort of 51k rows | **0.287 ms** · Index Scan on `idx_alpha_wallet_roster_score` |

Space: **807 MB → 384 MB of indexes (−423 MB, −52%)**. Never-scanned index space: **519 MB → 96 MB**.

## 5. Deliberately rejected (measurement, not taste)

- **`(wallet_address, timestamp DESC)` on trading_records** — the EXPLAIN shows the existing `idx_trading_records_wallet` already serves the wallet bitmap AND `idx_trading_records_wallet_chain_ts` has `wallet_address` as its leftmost prefix. Adding it would be a third overlapping index.
- **`(status, score DESC, updated_at DESC)` on alpha_wallet_roster** — the status-filtered roster query already measures **2 ms** using the partial follow index plus a 57-row sort. No measured need.
- **Partial index on `signal_ohlc_labels` for `jsonb_array_length(bars) > 0`** — its 47k seq scans are mostly the by-design whole-table dedup in `ENSURE_SQL`; the table is 18 MB. No measured slow path.
- **Indexing the tiny tables** — `cron_worker_runtime` (555k seq scans over **29 rows**, 176 kB), `strategy_definitions` (133k over **26 rows**), `strategy_ml_predictions` (37k over **400 rows**). A `seq_scan` counter is not a missing-index signal; adding an index here makes lookups slower.
- **Bulk-dropping all 88 zero-scan indexes** — **39 of them (65 MB) are constraint-backed** (PK/unique: `strategy_episodes_pkey`, `fomo_fills_pkey`, `token_rug_list_pkey`, `trading_signals_pkey`, `social_token_events_pkey`, `alpha_wallet_dig_hits_pkey`, …). Dropping those changes semantics. `idx_scan = 0` also covers index-on-a-table-created-after-stats-reset (`token_ohlc_bars_pkey` reads 0 only because the table was empty until 2026-09-25).
- **`idx_social_token_rollups_chain_token` kept** — 0 scans and only 2.2 MB, but `social/db.ts` has a live `WHERE chain = $2` branch; 0 scans reflects a rarely-taken branch, not dead code. Not worth a regression on Robinhood reads for 2 MB.

Out of scope (needs its own ticket): **bloat** rather than indexes — `alpha_wallet_dig_hits` is 174 MB for 5,228 rows and `strategy_episodes` 210 MB for 77,851 rows.

## 6. Verification

```bash
docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db -v ON_ERROR_STOP=1 < db/init/40-index-hygiene.sql   # re-run = no-ops
npm run verify:schema        # tables + increment_operation_counts still present
npm run lint && npm run verify:no-raw-useeffect && npm run build && npm run start
```

`scripts/verify-schema.sh` checks **tables and one function, not indexes**, so index changes cannot break the gate.

**Caveat worth knowing:** GIN query keys must be extractable at plan time. The app's `pg` parameterised queries use unnamed prepared statements → **custom plans with real values**, which is why the GIN is used (verified: the plan with bound literals picks `Bitmap Index Scan on idx_trading_records_tokens_gin`). A **generic** plan (forced prepared statement) could not extract `jsonb_build_object('mintAddress', $3)` as a query key and would fall back to `idx_trading_records_timestamp`. A test query using a scalar *subquery* instead of a bound parameter shows exactly that fallback — do not benchmark this query that way.
