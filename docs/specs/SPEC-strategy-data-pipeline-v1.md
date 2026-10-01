# SPEC — Cross-strategy feature standardization + data pipeline v1

**Status:** to-spec (docs only — no code changed)
**Date:** 2026-10-01
**Purpose (operator-stated):** the standardized data is the **input to the ML pattern / gate**, so it must be clean, versioned and joinable — not a per-strategy blob.
**Related:** [SPEC-rug-pattern-data-v1.md](./SPEC-rug-pattern-data-v1.md) (shares the history layer), [SPEC-token-info-universal-ledger-v1.md](./SPEC-token-info-universal-ledger-v1.md) (the "one writer" precedent)

## 1. Findings — measured on prod, not inferred

**Blob census** (`strategy_outcomes.features`, 2026-10-01):

| Metric | Value |
|---|---|
| Rows with features | 82,861 |
| Distinct **top-level** keys | **113** |
| Key instances | 2,651,612 |
| Total blob size / avg row | **112 MB** / 1,418 bytes |

**Per domain** — row count vs distinct top-level keys:

| domain | rows | top-level keys |
|---|---|---|
| `trending_bot` | 77,431 | 59 |
| `mcap_tracker` | 4,965 | **101** |
| `gmgn` | 362 | 49 |
| `signals` | 52 | 66 |
| `social` | 27 | 49 |
| `dlmm` | 24 | 31 |

One domain carries 101 of the 113 keys — the shape is *per-domain*, not shared.

**The decisive defect — the blob is double-booked.** `domain_features` is not a small extras bag; it is a near-complete **second copy** of the feature object:

| key | present at top level **and** nested | where the two copies **differ** |
|---|---|---|
| `token_symbol` | 79,736 rows | **3,130** |
| `training_class` | 79,841 rows | **3,021** |
| `close_reason` | 2,619 rows | — |

So on ~3% of rows the same field holds two different values and **nothing defines which is authoritative**. Any consumer that reads one copy and not the other is silently wrong on those rows.

**Other structural findings**

- **Standardization is enforced at one choke point only** — `insertStrategyOutcome` (`src/strategies/db.ts:526-697`) canonicalizes; the canonical spine is present on ~82.8k rows. But **9 entry paths** build raw `entry_features` that are never canonicalized (open positions live in `trading_records.data.trading_simulation.entry_features`).
- **The schema is defined 4×** — TS `ml-training-features.ts` (12/17 cols), TS `closed-loop-ml.ts` (13 cols, a *different* set), Python `ml/features.py` (12/17), Python `ml/pattern_features.py` (10) — plus a TS mirror `src/strategies/social/pattern-features.ts`.
- `FEATURE_SCHEMA_VERSION = 1` (`canonical-features.ts:4`) is written to rows but **never compared against a loaded model** — the de-facto runtime contract is `model.meta.json → feature_columns`.
- **Real unit collisions:** `initial_price_usd` is the **LP position's USD value** for `dlmm` and a per-token price everywhere else; `pool_volume` (LP 24h) sits beside `volume_at_entry` (token 5m); `sol_spent` vs `amount_sol`; `mcap_growth_at_exit` (percent) beside `time_to_120_minutes`.
- **Same concept, several names:** `entry_mcap` ≡ `first_mcap` ≡ `entry_market_cap`; `volume_5m` ≡ `volume_at_entry`; social dual-writes `mention_count_30m` ≡ `telegram_mention_count_30m`.
- **History is pruned:** `token_ohlc_bars` 48h inline, social events/rollups 24h, `mcap_social_pattern_24h` 24h, `token_mcap_tracking` 30d manual.
- **Missingness is handled three different ways:** training skips rows with an absent core field; inference zero-fills (`featureVectorToTensorInput` maps missing → `0`); the closed loop substitutes 0.5. A null and a legitimate 0 are indistinguishable downstream.

## 2. Target design — four layers

| Layer | Change |
|---|---|
| **L1 capture** | **One** canonical builder used by *every* entry path (the 11 writer sites in §5.A), stamped with `feature_schema_version`. Modelled on the write-once Token Info ledger's single-writer rule. |
| **L2 contract** | A **feature registry** as the single source of truth (a TS module) → a **generated** Python mirror, and `feature_schema_version` validated against `model.meta.json` **at load, failing loud**. |
| **L3 history** | `token_metrics_history` (from SPEC-rug-pattern-data-v1 §G2) + an explicit retention policy. |
| **L4 backfill** | A committed, re-runnable one-shot normalizer over the 82,861 rows (§6). |

**And the double-booking fix:** `domain_features` stops being a copy. It keeps *only* keys that are genuinely domain-scoped, registered with a type and unit; everything else is top-level and single-sourced. One authority per field.

## 3. Canonical names and units (to lock)

| Today | Canonical |
|---|---|
| `initial_price_usd` (price **or** LP value) | `entry_price_usd` (per-token) **and** `entry_value_usd` (LP position) |
| `exit_price_usd` | `exit_price_usd` / `exit_value_usd` (same split) |
| `volume_5m`, `volume_at_entry` | `entry_volume_5m_usd` (one name, one unit) |
| `pool_volume`, `fee_tvl_ratio_24h` | `domain_features.dlmm.pool_volume_24h_usd`, `...fee_tvl_ratio_24h` |
| `sol_spent`, `amount_sol` | `entry_stake_sol` |
| `sol_received` | `exit_proceeds_sol` |
| `first_mcap`, `entry_market_cap` | read alias for `entry_mcap` only |
| `mention_count_30m` + `telegram_mention_count_30m` | one name |
| implicit imputation | `<field>_source` provenance (generalize `volume_at_entry_source`) |
| missing vs zero | `null` = unknown, `0` = measured zero; never conflated |

## 4. Migration mechanics — staged, never big-bang

The repo already does this: social features are **dual-written** (`mention_count_30m` + `telegram_mention_count_30m`, `canonical-features.ts:232-237`) and read through an alias map. Reuse the pattern:

1. **Dual-write** — the builder emits canonical **and** legacy names.
2. **Alias reads** — readers resolve via the alias map; no reader breaks.
3. **Backfill** — normalize the 82,861 historical rows (§6).
4. **Drop legacy** — a later, separate pass, only after (3) is verified.

Nothing may be deployed between a rename and the model retrain (see the risk in §8).

## 5. Blast radius (detailed)

### 5.A Writers that must adopt the canonical builder

| # | Site | Note |
|---|---|---|
| 1 | `src/strategies/db.ts:526-697` `insertStrategyOutcome` | the existing choke point |
| 2 | `src/strategies/outcomes.ts` ×6 wrappers (`recordTrendingBotOutcome` 11, `recordSignalsOutcome` 36, `recordDlmmOutcome` 73, `recordMcapTrackerOutcome` 134, `recordGmgnOutcome` 174, `recordSocialOutcome` 211) | DLMM writes nested `domain_features.dlmm` |
| 3 | `src/strategies/trending-bot-rh-sim.ts:274-285` | raw entry_features, no schema version |
| 4 | `src/strategies/eval-execution.ts:184-204` | camelCase `eval*` keys |
| 5 | `src/strategies/gmgn-open-sim.ts:40-54,119-124` | `gmgn_*` keys survive top-level |
| 6 | `src/app/api/social/sim-track/route.ts:223-228` | passthrough |
| 7 | `src/app/api/mcap-tracking/sim-track/route.ts:253-291,372,708,847` | **skips** the builder when `scoredEntryFeatures` is pre-supplied |
| 8 | `src/strategies/telegram-alpha-sim.ts:61` | passthrough |
| 9 | `src/strategies/gmgn-comeback-sim.ts:83,121`, `src/strategies/gmgn-live-boost.ts:181-229`, `src/strategies/trending-track/entry-features.ts:113` | ad-hoc overlay |
| 10 | `src/utils/dlmm/actions.ts:275-299`, `src/strategies/outcomes.ts:496-519` | DLMM close + backfill |
| 11 | `scripts/replay-mcap-first-seen-14d-standalone.mjs:296` | **bypasses the choke point** — direct INSERT |

### 5.B Key-name literals (every renaming touch point)

- **TS:** `canonical-features.ts` (`CORE_KEYS` 74-106, `OHLC_FEATURE_KEYS` 60-72, alias lists 140-163) · `ml-training-features.ts` (`ML_NUMERIC_FEATURE_KEYS` 20-27, `ML_SOCIAL_FEATURE_KEYS` 29-35, `ML_V2_FEATURE_KEYS` 37-40, `ML_CORE_RAW_FIELDS` 189-194, `readSocialFeatures` 137-164) · `closed-loop-ml.ts` (`CLOSED_LOOP_FEATURE_COLUMNS` 26-40, `bandOneHot` 178-196, `readStoredScore` 221-227) · `outcome-features.ts` (~30 read keys, 35-222) · `social/pattern-features.ts` (`PATTERN_FEATURE_KEYS` 5-16) · `social/pattern-training-export.ts:170-193` · `ml-shadow-log.ts` · `pattern-shadow-log.ts` · `ml-entry-shadow.ts:71-76`
- **Python:** `ml/features.py` (`NUMERIC_FEATURES` 17-24, `SOCIAL_FEATURES` 26-32, `canonicalize_row` 176-200) · `ml/pattern_features.py` (`PATTERN_FEATURE_COLUMNS` 10-21) · `export_training_data.py:201-204` · `export_pattern_data.py:47-49` · `check_dataset.py:55-81` · `check_pattern_dataset.py:32`
- **Tests asserting the literals:** `canonical-features.test.ts`, `ml-training-features.test.ts`, `outcome-features.test.ts`, `closed-loop-ml.test.ts`, `entry-ml-scorer.test.ts`, `entry-pattern-scorer.test.ts`, `social/pattern-features.test.ts`, `combined-score-load.test.ts`

### 5.C Readers / surfaces

- **API:** `src/app/api/strategies/outcomes/route.ts` (CSV header + readers + `resolvePnlFilter`) · `ml/dataset-stats` · `ml/eval-report` · `ml/backfill-features` (`volumeFromMonitorSnapshots` 45-56, `classifyVolumeFill` 58-87) · `analytics/token` · `mcap-patterns/*`
- **UI:** `OutcomeReviewModal.tsx`, `AlgoTester*`, `TradeWindowChart.tsx`, `PnL*`, tracker/analytics chips
- **Charting:** `sim-monitor-snapshots.ts` (`fetchOutcomeMonitorPriceHistory` 99-143) · `token-map-chart.ts` · `loadOutcomeTradeWindowChart` (`db.ts:1243`)

### 5.D Models & artifacts — the retrain triggers

`ml/artifacts/v2-gate/model.meta.json`, `v2-potential/model.meta.json`, `pattern-gate/model.meta.json` each hold `feature_columns` (the de-facto runtime schema), plus `data/ml-closed-loop/model.json`. **Any rename invalidates them → retrain.** Drift already exists and is documented (`docs/04-machine-learning.md:38`: the on-disk pattern meta lists an older 7-column vector than the 10-column code).

### 5.E Data at rest

`strategy_outcomes.features` — 82,861 rows / 112 MB to normalize; nested `domain_features`, `domain_features.dlmm`, `exec`, `monitor_snapshots[]`. `trading_records.data.trading_simulation.entry_features` — the same shape for open positions.

### 5.F External / ops

CSV consumers: `exports/export_live_csv.sh`, `exports/build_token_pnl_workbook.py`, `exports/build_workbook.py`. Retention jobs if retention changes: `ohlc/sample/route.ts:140`, `social/db.ts:677,690`, `mcap-tracker.ts:1378`, `mcap-patterns-24h.ts:27-28`.

## 6. The backfill (L4)

A committed, re-runnable script — same safety shape the repo already uses for data repairs:

- **dry-run by default**, `--apply` to write; batched (e.g. 500 rows/statement).
- **backup of only the rows/column being changed, taken before the write** (`features` for the selected ids).
- **idempotent** — a second `--apply` must be a provable no-op.
- normalizes: collapse duplicate copies to one authority, apply the §3 renames via the alias map, flatten registered domain keys to their canonical home, stamp `feature_schema_version: 2`.
- leaves genuinely unknown values as `null` (never fabricated) and reports the counts it could not resolve.

**Expected scale:** 82,861 rows / 112 MB → a batched rewrite; report the dry-run counts (rows changed, bytes delta, unresolved count) before applying.

## 7. Phasing

| Phase | Work | Gate |
|---|---|---|
| P1 | `feature-registry.ts` + generated Python mirror + `feature_schema_version` validation at model load | registry tests green |
| P2 | One canonical builder adopted by the 11 writer sites; dual-write canonical + legacy | writer tests green; no reader changed |
| P3 | Alias-map reads across §5.B/§5.C | full suite + build |
| P4 | `token_metrics_history` + sampler volume + cron + retention | rows landing; volume non-null |
| P5 | Backfill (§6) dry-run → apply → re-run no-op | counts reported |
| P6 | Retrain gate / potential / pattern against the new schema | `ml:check-dataset` / `ml:check-pattern` pass |
| P7 | Rug backtest harness (SPEC-rug-pattern-data-v1) | both label arms + CIs |
| P8 | Docs + diagram + indexes aligned | `self_check.py` OK |

**Ordering constraint:** P1 **before** P2. If a model loads between a rename and the retrain it reads renamed features and silently zero-fills them — a wrong inference with no error.

## 8. Acceptance

- One builder, one registry, one authority per field — assertable by a test that no row carries two values for the same logical field.
- `feature_schema_version` mismatched against a model's `feature_columns` **fails loudly** at load.
- The backfill is idempotent, backed up, and reports unresolved counts.
- Every reader in §5.B/§5.C resolves canonical-first and still reads pre-backfill rows via the alias map.
- Models retrained and their `feature_columns` match the registry.

## 9. Risks / non-goals / open items

**Risks**
- Silent zero-fill at inference (see the P1 ordering constraint) — the highest-severity risk here.
- Deploying a rename before the retrain leaves the gate/pattern scorers degraded without an error.
- `token_metrics_history` growth — size it from the watch set before enabling retention.

**Non-goals**
- Changing any strategy's decision logic; this is a data-shape change only.
- Rebuilding the ML models' math (only their input contract).
- Touching the reactive OHLC spine.

**Open items**
1. Whether `domain_features` is dropped entirely or kept as a registered, typed namespace.
2. Metrics-history cadence (reuse the 120s tick vs a new worker) and retention (90 vs 180 days).
3. Whether the per-minute volume source needs a new integration (there is no free per-minute traded-volume feed in the stack today).
