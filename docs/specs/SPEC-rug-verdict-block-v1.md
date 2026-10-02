# SPEC — One verdict per token, on a fixed 10-minute block

**Status:** To-spec (docs only) — **for review, nothing implemented by this document.**
**Date:** 2026-10-02
**Provenance:** the `/ask` + `/debug` passes of 2026-10-02 — the code reads of `rug-signal.ts`,
`rug-signal-detect.ts`, `ohlc-rug-shadow.ts`, `canonical-features.ts` and the prod inventory/P1 queries
below (read-only). Commits referenced are shipped.
**Related:** [SPEC-rug-signal-v1.md](./SPEC-rug-signal-v1.md) (the scorer this judges with) ·
[SPEC-rug-pattern-data-v1.md](./SPEC-rug-pattern-data-v1.md) (the corpus this feeds) ·
[SPEC-strategy-data-pipeline-v1.md](./SPEC-strategy-data-pipeline-v1.md) (one canonical builder) ·
[SPEC-feature-registry-v1.md](./SPEC-feature-registry-v1.md) (one registry, checked at load)

## Goal

Turn the rug detector into a **labelled, per-token corpus that an ML model can actually learn from**:
one token → one verdict → one immutable feature block → one forward label.

Today it produces the opposite: every sweep re-judges the same token over a moving window, so 4,104
rows are ~2,350 mints, the window at evaluation depends on when a sweep happened to run, and the
validation harness had to bolt on a per-mint dedupe (`dedupeByMint` in `rug-signal-validate.mjs`) to
stop the numbers from lying. That dedupe exists **only because** the flow below does not.

## Decisions locked (this pass)

| decision | value | why |
|---|---|---|
| the clock | **the mint's first held minute** (`MIN(hour_bucket)` + first index of `c_min`) | 100% covered for anything with candles, self-consistent with the block by construction, cannot be revised under us |
| the window | **fixed 10-minute block on 1m bars**, the feature block | a verdict must compare like with like |
| cardinality | **one verdict per token**, never re-judged | independent samples; retires the per-mint workaround |
| the label | unchanged: forward collapse (60% drop within 30 min), env-tunable | already independent of the scorer |

### Rejected on evidence — do not retry blind

**A gate on token age ≤ 10 min, clocked on `token_mcap_tracking.first_seen_at`.** Proposed, then
measured, then withdrawn this same day:

- `first_seen_at` is 100% populated *within its table* (32,252/32,252) but **that table covers only
  ~17% of the corpus** — of 2,353 mints in `rug_signal_shadow`, **1,943 (83%) have no row in
  `token_mcap_tracking`**, because the watch set is a 4-way union (mcap band + trending + recent sim
  buy + social) and most scored mints came from the other three arms.
- 49 mints have a **negative** age by this clock — the first evaluation precedes their first-seen stamp.
- A 10-minute age gate against a 15-minute cadence is arithmetically self-defeating: it admits at most
  ~10/15 of tokens even when the sweep is healthy, and the sweep has not been healthy (see Risks).

The same measurement is why the clock is our own first held minute: the median lag between
first-seen and our first candle is **−18 minutes** — the copier's 501-bar window backfills history, so
our series typically *precedes* first-seen. Anchoring on the series removes the provenance question
entirely.

## Evidence

### Inventory (prod, 2026-10-02, read-only)

```
token_metrics_history      12,987 rows / 4,393 mints   2026-09-15 → 2026-10-02   89% with volume
  held minutes per mint    <5: 2,383 | 5–9: 659 | 10–29: 428 | 30–59: 131 | 60+: 355
rug_signal_shadow           4,104 rows / 2,350 mints   2 days   mcap 97% · liquidity 87% · symbol 48%
  decisions                 pass 2,141 rows / 699 mints
                            no_bars 1,961 / 1,731 mints ← 74% of mints are unjudged
                            would_rug 2 rows / 2 mints
token_mcap_tracking         32,252 rows, first_seen_at 100% present (but see Rejected)
token_rug_list              7,989 rows
ml/artifacts                pattern-gate only — no rug model exists
```

**Count held minutes, not array slots.** An earlier pass of this document used
`SUM(array_length(c_min, 1))` and reported 3,829 mints with 60+ minutes — roughly **10× the truth**.
That expression counts NULL slots, and `NULL` in these arrays means *not observed*, never a minute:
a minute counts only when its close is finite and positive. On the honest basis, **355 mints hold 60+
minutes and 914 hold a complete 10-minute block** — which is the same rule the scorer's own code
documents, and the same rule this SPEC's clock (`firstHeldMinute`) implements.

### P1 — ages under the real schedule

```
age at first evaluation      0–5 min  43 | 5–10  35 | 10–15 21 | 15–30 15 | 30–60 12 | 1–3h 22
                             3–24h 28 | 1d+ 185 | negative 49        (410 mints joined)
caught inside first 10 min   78 / 410  = 19%      ← under the *broken* cadence
buildable block              of the 130 mints caught ≤10 min, 107 hold ≥10 real minutes (82%)
```

So the block is buildable for most caught mints (82%, and that figure is on the *held*-minute basis —
the earlier 98% counted NULL slots), and the catch rate is a scheduling artefact, not a data
one. Anchoring the clock to our first held minute makes the verdict due whenever ten minutes exist —
the cadence then only affects **latency**, never whether a token is judged.

### The fresh-token slice — what T2 was measured on, and what it does NOT cover

Measured 2026-10-02, reproducible across runs (199 mints, one drifting as the window ages):

```
                     judged   noBars   trips
5m basis (shipped)        0      199       0
1m block basis          143       56       4
```

Both bases are handed the **same `freshBars` array for the same mint**, so this is a paired
comparison: ten 1m bars collapses to two 5m bars, below the floor of five, while the same minutes
clear the 1m floor of six. Nothing else differs, which is why the result survives the sampling
caveat below.

**The caveat, stated rather than implied.** The slice is a **sample of ~400 replayed shadow rows**
(~200 distinct mints), and the replay skips rows with no bars, so it is biased toward mints that
*have* minutes. Counting the same window directly on the held-minute basis:

```
mints in the 3-day window with a held minute     2,459
of which hold >=10 real minutes                    642   (26%)
```

The slice covers **199 of those 2,459 (~8%)**. So:

- **"72% judged" is a rate within the sample, not the population.** The population figure is **26%**
  (642/2,459) — and that is the number that governs how much corpus T3 will actually produce.
- **The 0-vs-143 finding is unaffected**, because it is paired per mint and does not depend on which
  mints were sampled.
- The gap between 72% and 26% is the bias doing the work: the sample excludes every mint the replay
  had to skip for having no bars.

## Data contract

`rug_verdicts` — created on first use (the `rug_signal_shadow` / `copier_runs` pattern), one row per
`(token_address, chain)`, written **once**:

| column | meaning |
|---|---|
| `token_address`, `chain` | PK; the don't-re-judge guard |
| `first_minute_at` | the clock: the mint's first held minute |
| `verdict_at` | when the verdict was taken (first tick holding ≥10 minutes) |
| `minutes_used` | minutes actually in the block — `10` is complete; a short block is recorded, not silently padded |
| `features` (jsonb) | the **snapshot** at verdict time (the scorer's `breakdown` + the raw `staircase/volume/liquidity/dump` inputs + `bars_scored`) |
| `score`, `decision` | the scorer's verdict (`would_rug` / `pass` / `no_bars`) |
| `mcap`, `liquidity_usd` | as read at verdict time |
| `label` , `label_at` | the forward outcome, filled later by the existing forward rule; NULL until the window closes |
| `source` | which caller (`metrics_sweep` today) |

Invariants: **features are written once and never recomputed**; a verdict with a short block is
recorded as short; `no_bars` is an unknown and must not enter a training set as a negative.

## Tasks

**T1 — the clock helper.** A pure function returning a mint's first held minute from its stored
minutes. Test: an array whose first entries are null/0 must yield the first *valid* minute, not index 0.

**T2 — the 1m basis.** `RUG_SIG_WINDOW` → 10 on a 1m basis, `RUG_SIG_MIN_BARS` → ~6, keeping the 5m
view alongside until the new one is validated (a parallel field, not a replacement). Gate: the
replay (`/api/rug-signal/calibrate`) reports both bases side by side, so the change is measurable.

**T3 — the verdict writer.** `rug_verdicts` + the "due when ≥10 minutes held" rule + the
don't-re-judge guard. Fail-open in every direction (the `copier-runs.ts` precedent): a failed write
must never fail the sweep.

**T4 — the label join.** Fill `label` from the existing forward rule once the window closes; the
training set is `features` joined to `label`, excluding `no_bars`.

**T5 — the reader.** A panel section on `/dev/rug-signal` (verdicts by day, block completeness,
features → label agreement) so the corpus is visible where it is questioned, and `rug_verdicts` is not
another dead store.

**T6 — enforce, separately and later.** Only on the harness's existing acceptance rule: precision above
the base rate **and** per-day agreement.

## Env

| key | default | meaning |
|---|---|---|
| `RUG_VERDICT_WINDOW_MIN` | 10 | minutes required before a verdict is due |
| `RUG_VERDICT_MIN_MINUTES` | 6 | fewer than this is a short block, recorded as such |
| `RUG_SIG_WINDOW` / `RUG_SIG_MIN_BARS` | 10 / 6 | the 1m block basis (was 20 / 5 on 5m) |
| `RUG_EVENT_DROP` / `RUG_EVENT_WINDOW` | 0.6 / 30 | the forward label (unchanged, tunable) |

## Non-goals

- **The entry-gate `ohlc_rug_*` keys stay untouched and separate.** `ohlc-rug-shadow.ts` attaches them
  to entry/paper-open records via `attachOhlcRugShadow` — a different mechanism from this detector. The
  verdict's block gets its **own** keys; a key name must not come to mean two things.
- No model training in this SPEC (no rug model exists; `ml/artifacts` carries only `pattern-gate`).
- No enforcement (T6 is gated, and is a separate change).
- Not fixing the copier itself — but see Risks; this design depends on it.

## Risks

1. **The copier is the prerequisite, and it is not healthy.** 4 completions of ~56 scheduled runs, a
   7-hour hole in the series (`copier_runs` + the watchdog now measure this). A verdict needs ten
   *contiguous* minutes, which is exactly what the copier's 501-bar backfill provides — so this SPEC
   lands after the copier survives deploys, not before.
2. **`no_bars` is 74% of mints today.** The 1m basis is what fixes that for fresh tokens (ten 1m bars
   vs five 5m bars needing 25 minutes of life) — if T2 is skipped, T3 produces non-verdicts.
3. **A 30-minute label window may be too short** for slower dumps; it is env-tunable, so this is a
   measurement, not a rewrite.

## Verification

- `rug_verdicts` has **one row per mint** and no mint is judged twice (the guard, asserted, not assumed).
- Block completeness is reported, not implied: the share of verdicts with a full 10 minutes.
- The per-mint rate on `rug_verdicts` equals the per-row rate (they are the same population by
  construction) — i.e. the harness's dedupe becomes a no-op, which is the test that this worked.
- The replay shows both bases (5m legacy vs 1m block) until the new one is accepted.
