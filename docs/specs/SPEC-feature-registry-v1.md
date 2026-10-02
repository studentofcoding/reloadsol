# SPEC — Feature registry + schema contract v1

**Status:** implementing (2026-10-01)
**Scope:** P1 of [SPEC-strategy-data-pipeline-v1.md](./SPEC-strategy-data-pipeline-v1.md) — the safety net that must land **before** any key rename.
**Related:** [SPEC-ohlc-own-1m-v1.md](./SPEC-ohlc-own-1m-v1.md) (the reactive spine), `docs/04-machine-learning.md` (ML stages)

## Goal

One declarative **feature registry** as the single source of truth for every feature name a model can consume, a
committed JSON mirror that the Python side reads, and a **load-time check** that refuses to score a model whose
declared columns do not match the registry.

**Non-goals.** This pass **renames nothing**, backfills nothing, unifies no writer, and retrains no model. It only
makes divergence **loud**. The renames (dual-write → alias reads → backfill → retrain) are P2–P6 of the umbrella SPEC.

## Evidence — the drift is live, and silent

`ml/artifacts/pattern-gate/model.meta.json` declares **7** `feature_columns`
(`log_first_mcap · log_mention_count_30m · unique_channels_30m · minutes_to_first_mention ·
smart_wallet_buy_count_1h · has_smart_wallet_buy · source_gmgn_smart_money_fomo`).

`PATTERN_FEATURE_KEYS` (`src/strategies/social/pattern-features.ts:5`) has **10** — it added
`gmgn_activity_score_60m`, `log_gmgn_sm_wallets_60m`, `has_gmgn_hot_before_entry`.

Nothing errors, because `featureVectorToTensorInput` (`src/strategies/entry-ml-scorer.ts:42`) builds the tensor
**in the meta's order and length**:

```ts
const arr = new Float32Array(featureColumns.length)   // length comes from the META
arr[i] = vector[featureColumns[i]] ?? 0
```

So the three newer features are computed, stored, and then **silently dropped** before inference. The model
scores on a 7-feature subset of a 10-feature intent. (`pattern_ready: false`, macro_f1 0.467 — it cannot enforce
anyway, which is the only reason this has been harmless.)

### The two divergence classes

| Class | Example | Consequence if unchecked |
|---|---|---|
| meta ⊂ code (meta lists fewer) | pattern-gate today: 7 vs 10 | newer code features silently ignored |
| meta names something the code does not produce | what a rename would create | that column is silently fed **0** — the model scores on a zero |

### And the schema is defined four times

| Definition | Location |
|---|---|
| TS entry keys | `src/strategies/ml-training-features.ts` (`ML_NUMERIC_FEATURE_KEYS` 20, `ML_SOCIAL_FEATURE_KEYS` 29, `ML_V2_FEATURE_KEYS` 37, `ENTRY_MCAP_BANDS` 9) |
| TS closed-loop columns (a *different* 13) | `src/strategies/closed-loop-ml.ts` (`CLOSED_LOOP_FEATURE_COLUMNS` 26) |
| TS pattern keys | `src/strategies/social/pattern-features.ts` (`PATTERN_FEATURE_KEYS` 5) |
| Python entry (12 / 17) | `ml/features.py` (`NUMERIC_FEATURES` 17, `SOCIAL_FEATURES` 26, `FEATURE_COLUMNS` 36, `FEATURE_COLUMNS_V2` 38) |
| Python pattern (10) | `ml/pattern_features.py` (`PATTERN_FEATURE_COLUMNS` 10) |

`FEATURE_SCHEMA_VERSION = 1` (`src/strategies/canonical-features.ts:4`) is stamped on every row and **never
compared to anything**.

## Design

### 1. Registry — `src/strategies/feature-registry.ts`

Declarative data plus typed getters; no behaviour moves in.

```ts
export const FEATURE_SCHEMA_VERSION = 1          // re-exported from canonical-features for compatibility
export type FeatureStage = 'entry' | 'pattern' | 'closed_loop'
export type FeatureSpec = { key: string; type: 'number' | 'bool' | 'string'; note?: string }
export const FEATURE_REGISTRY: {
  version: number
  stages: Record<FeatureStage, { columns: Record<string, string[]> }>   // named, ordered column sets
}
```

- `entry` → named sets `v1` (12: numeric + `band_*`) and `v2` (17: + social).
- `pattern` → `default` (10).
- `closed_loop` → `default` (13).

Every existing constant site becomes **derived** from the registry, so no importer changes:
`ML_NUMERIC_FEATURE_KEYS`, `ML_SOCIAL_FEATURE_KEYS`, `ML_V2_FEATURE_KEYS`, `PATTERN_FEATURE_KEYS`,
`CLOSED_LOOP_FEATURE_COLUMNS` keep their names and values.

### 2. Mirror — `ml/feature-schema.json` (committed)

Emitted by `npm run ml:export-schema` (`scripts/export-feature-schema.ts`, `tsx`, matching the repo's other
`npx tsx scripts/*.ts` entries):

```json
{ "version": 1, "stages": { "entry": { "v1": [...], "v2": [...] }, "pattern": { "default": [...] }, "closed_loop": { "default": [...] } } }
```

Committed on purpose: prod must not depend on a build ordering to have a contract.

### 3. Python loader — `ml/feature_schema.py`

Loads the JSON (path relative to the module, env-overridable) and exposes `stage_columns(stage, set='default')`.
`ml/features.py` and `ml/pattern_features.py` keep their **public constant names** but build them from the loader,
so `export_training_data.py`, `export_pattern_data.py`, `check_dataset.py`, `check_pattern_dataset.py` and the
trainers need no change.

### 4. Load-time check — refuse, don't guess

`feature_schema_version` is added to `MlModelMeta` and `PatternModelMeta`, and validated in the two readers
(`entry-ml-scorer.server.ts:35 readMeta`, `pattern-artifact-meta.server.ts:59 readPatternModelMeta`):

1. `meta.feature_schema_version === FEATURE_REGISTRY.version`
2. `meta.feature_columns` must equal **one named set** for that stage (set equality — order is irrelevant because
   inference is name-keyed).

On failure the reader returns **no usable model** plus a *named* reason (which columns are unknown / missing, or
the version mismatch) instead of today's bare `null`.

**Loud, never fatal.** A structured `console.warn` (the production `removeConsole` config strips `info`/`debug`,
so `warn` is the level that survives) and the verdict is exposed on the existing status payloads:
`patternRuntimeStatus()` and `/api/ml/pattern/reload` gain `schema_ok` / `schema_error`; the gate path gets the
same through `getGateModelReady()`.

## Test plan

1. **Registry sanity** — three stages present, non-empty, keys unique within a set, version a positive integer.
2. **Parity (the teeth)** — re-emit the JSON from the registry in memory and assert it equals the committed
   `ml/feature-schema.json`; drift in the mirror fails CI.
3. **Meta validation** — a matching meta passes; a version mismatch refuses and names it; an unknown column
   refuses and names the column; a subset (the 7-column pattern meta) refuses.
4. **Real file** — validate the committed `ml/artifacts/pattern-gate/model.meta.json` and assert it is **reported
   as mismatched**, pinning today's defect so it cannot silently return.
5. **Status** — `patternRuntimeStatus` carries the `schema_ok` axis (extends `entry-pattern-scorer.test.ts:40`).

## Acceptance

- One registry; the JSON mirror equals it; Python's lists come from the mirror (so no second hand-edited source).
- A drifted meta is refused **by name** at load — proven against the real in-repo pattern meta.
- Every existing constant keeps its name and value; no importer, exporter or trainer changes.
- `npm run ml:export-schema` is idempotent (two runs → no diff).

## Open items

1. Whether `closed_loop` should be its own stage or a derived projection over `entry` (it is a different 13-column view today).
2. Where the **gate** schema verdict is surfaced for operators — `/api/ml/pattern/reload` covers the pattern stage only.
3. Retraining `pattern-gate` onto the 10-column vector (S3) requires the pattern dataset to clear `MIN_PATTERN_ROWS` / `MIN_PATTERN_MACRO_F1`.
