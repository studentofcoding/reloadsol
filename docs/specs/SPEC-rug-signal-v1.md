# SPEC — Rug signal: staircase / manufactured-ramp score v1

**Status:** implementing (2026-10-01)
**Provenance:** `strategies/RUG_SIGNAL.md` (doc-only since forever — `rugScore` / `calculateRugScore` / `staircase` have zero matches in code). This SPEC builds its Phase-1 rule engine and wires it to the shared rug list.
**Related:** [SPEC-ohlc-rug-spine-v1.md](../../docs/SPEC-ohlc-rug-spine-v1.md) (the 10×1m trip), [SPEC-potential-rug-labels-tracker-honesty-v1.md](./SPEC-potential-rug-labels-tracker-honesty-v1.md) (label stores)

## Why

Two copycat tokens (MINDX, SpaceX) printed a flat thin-volume base then a vertical staircase up, and every surface called them inconclusive:

- `dev inconclusive · 39/100 · High holder correlation, Copycat token (shadow)` is the **RugCheck + dev-reputation chip** (`chipFromRow`). `39/100` is RugCheck's `score_normalised`, the risk words are RugCheck's own, and `inconclusive` is `scoreDevReputation()` firing its `sample N < min 5` gate. **None of it is our candle rules.**
- Our OHLC spine is silent on that shape. `dump_10m` needs a drop that has not happened; `wick_reject` needs tall upper wicks a staircase does not have; `volume_death` inverts (volume *expands* into the ramp); and `up_only_10` requires `n === 10` **and all 10 bars green**, which a staircase (steps with pauses) structurally fails — pinned by `ohlc-rug-rules.test.ts:166`.
- Even on a trip, the spine is shadow-only: `attachOhlcRugShadow` writes `ohlc_rug_trip` into entry features and logs a counterfactual. The only automated rug writers are `concentration` (>65%) and `gmgn-radar-dump`.

So the honest summary of today: **no code path can call a live up-only ramp a rug.**

## Reopened lock (read this)

`SPEC-ohlc-rug-spine-v1.md` locks: *"OHLC rug rules are a **reactive short-window filter**, not a predictive rug oracle"*, with `changing dump/wick/vol thresholds` out of scope v1. This SPEC **reopens that on purpose**: a staircase is a *pre-dump* shape, so scoring it is predictive by definition. It is built as a **separate** module and a **separate** rug source (`rug-signal`) so the reactive spine's semantics are untouched.

## Locked decisions

| # | Lock |
|---|---|
| 1 | On trip, the verdict writes **`rug` immediately** via `markTokenRug({ source: 'rug-signal' })`. It does not wait for a dump. |
| 2 | `'rug-signal'` is an **automated** source (`AUTOMATED_RUG_SOURCES`) — its verdicts must never count toward a dev's `user_rug_count`. |
| 3 | Every threshold is **env-tunable**. Nothing is hardcoded that a soak would want to move. |
| 4 | The whole module ships behind `RUG_SIGNAL_ENABLED` (default **off**) with `RUG_SIGNAL_MODE=shadow\|enforce` (default **enforce** — enabling the flag gets the immediate write the request asked for). Off means zero behavior change. |
| 5 | Scoring is **structural**, no new upstream: 5m bars from our own 24h 1m cache / `token_ohlc_bars`, mcap from the tracker, liquidity from `token_risk_features`, age from first-seen/created-at. |
| 6 | Reasons are always emitted (`rug staircase: 30/40 …`, `rug volume: 29/30 (expansion … risk 1.00)`) so a verdict is auditable from the row alone. |
| 7 | **Static vs band:** staircase and dump score pro-rata over boolean sub-conditions; volume and liquidity are continuous bands from 0 (safest) to their max (riskiest). |

## Components — A40 B30 C20 D10 = 0–100

Two kinds of component:

- **Static** (A staircase, D dump): pro-rata over boolean sub-conditions, as in the doc.
- **Band** (B volume, C liquidity): a continuous 0 → max that scales the *degree* of risk. 0 is the
  safest end, the component max the riskiest. No hard gate, so a merely flat-ish ramp lands part-way.

`RUG_SIGNAL_MAX_SCORE` is the weight sum (100), so nothing is truncated.

### A. Staircase — 40, static
Over the last `RUG_SIG_WINDOW` 5m bars (default 20), 10 points per sub-condition met:
- bullish ratio (bars with `c > o`) `> RUG_SIG_STAIR_BULLISH` (default 0.70)
- mean gain on green bars `< RUG_SIG_STAIR_AVG_GAIN` (default 0.05)
- price gain over the window (first close → last close) `> RUG_SIG_STAIR_PRICE_GAIN` (0.80)
- upper-wick variance `< RUG_SIG_STAIR_WICK_VAR` (default 0.02) — "low wick variance"

A staircase with pauses (4 of 20 bars not green) still scores the full 40 — the exact shape the
reactive `up_only_10` rule misses.

### B. Volume manipulation — 30, band (0 = safest → 30 = riskiest)

Two continuous sub-signals, averaged with `RUG_SIG_VOL_EXPANSION_W` (default 0.5):

| Sub-signal | Formula | Reads |
|---|---|---|
| `expansion` | `clamp01(1 − volGrowth / priceGain)` | volume growing as fast as price is organic (risk 0); flat volume under a ramp is risk 1 |
| `dispersion` | `clamp01(1 − cv / RUG_SIG_VOL_CV_SAFE)` (0.35) | dead-flat volume is the manufactured tell |

`volGrowth` = mean volume of the last third ÷ mean of the first third, minus 1. `cv` = stdev/mean.

`points = round(30 × risk01)`. **No rise → 0.** If the window's price gain is ≤ 0 there is no ramp to
manipulate, so the band returns 0 (`price not rising`) rather than charging an inert token for flat
dispersion. Unknown volume → 0 points + `volume unknown` (never assumed safe).

### C. Liquidity risk — 20, band (0 = safest → 20 = riskiest)

`risk01 = clamp01(1 − (liquidityUsd / mcap) / RUG_SIG_LIQ_SAFE_RATIO)`, anchor default **0.10**.
`points = round(20 × risk01)`:

| liq / mcap | risk01 | points |
|---|---|---|
| ≥ 10% (deep) | 0 | 0 |
| 5% | 0.50 | 10 |
| 4% | 0.60 | 12 |
| 1.5% | 0.85 | 17 |
| → 0% | 1 | 20 |

Unknown liquidity → 0 points + `liquidity unknown` (never assumed safe).

### D. Dump — 10, static
Already-dumped confirmation (so a confirmed rug still scores, and a post-dump retrip is stable):
- single 5m bar drop `> RUG_SIG_DUMP_BAR` (default 0.40) → 5
- max drawdown across any 5 consecutive bars `> RUG_SIG_DUMP_DRAWDOWN` (default 0.60) → 5

### Trip rule

`staircase 40 + flat volume 30 + liq/mcap 1.5% 17 = 87 ≥ RUG_SIG_THRESHOLD (80)` → immediate `rug`.

A live ramp reaches **A + B + C = 90**, so the default threshold of **80** clears with headroom while
still requiring most of the shape. Named boundaries, pinned by tests:

| Case | Score | vs 80 |
|---|---|---|
| staircase 4/4 + volume 30 + liquidity 17 (1.5%) | 87 | rug |
| staircase 4/4 + volume 30 + liquidity 12 (4%) | 82 | rug |
| staircase 4/4 + volume 30 + liquidity 10 (5%) | 80 | rug (exactly) |
| staircase 4/4 + volume 30 + liquidity 0 (≥10%) | 70 | not rug |
| organic pump, volume expands with price | ~30 | not rug |

## Guardrails (from `RUG_SIGNAL.md` §6)

Evaluate only when `ageHours < RUG_SIG_MAX_AGE_H` (default 48) **or** `liquidityUsd < RUG_SIG_MAX_LIQ_USD` (default 100k). Outside both, skip — an old liquid token is not this shape's target.

## Inputs and their seams

| Input | Source |
|---|---|
| 1m bars → 5m | `getCachedTokenOhlc24h1m` (first), then `loadOwn1mBars` (`token_ohlc_bars`, **no volume** — see Calibration) |
| volume | per-bar `v` from the cached series only; the own-1m fallback has none |
| mcap | `info.market_cap` / `token_mcap_tracking.current_mcap` |
| liquidityUsd | `token_risk_features.rugcheck_lp_locked_usd`, fallback `gmgn_liquidity_usd` |
| ageHours | `token_mcap_tracking.first_seen_at`, fallback `info.create_timestamp` |

## Integration

- **Detector:** `src/strategies/rug-signal-detect.ts` — resolve inputs, evaluate, on trip `markTokenRug({ source: 'rug-signal' })` (which syncs `trading_signals`, `token_mcap_tracking.label`, and the OHLC corpus through the existing single write path).
- **Seam:** the GMGN pipeline beside `attachRiskShadow` (`src/strategies/gmgn-pipeline.ts`), so the `token_risk_features` row (liquidity/creator) is already written when the detector reads it, and the score lands before UI exposure as the doc requires.
- **Pure scorer:** `src/strategies/rug-signal.ts` (no IO) — the whole decision is unit-testable from fixtures.

## Calibration — what we measured (and could not)

The band anchors above are **chosen, not fitted**. Three read-only passes against prod
(2026-10-01) show why:

**1. `token_ohlc_bars` has no volume — at all.** 875,535 of 875,535 rows have `volume IS NULL`.
The 15s sampler upserts a Jupiter spot price into `open`/`high`/`low`/`close` and never writes
volume (`src/app/api/ohlc/sample/route.ts`). Consequence: whenever the scorer falls back to our own
1m series, the 30-point volume band is **inert** (0 points), so a ramp tops out at 40 + 20 = 60 < 80
and can never trip on that path. Fix is small: record realised traded volume/turnover in the sampler,
then re-run this calibration.

**2. Absolute thinness does not track rug.** `volume_at_entry / entry_mcap` over 4,407 outcomes —
p50 by outcome bucket:

| crash ≤ −50% | loss | flat | win < 100% | win ≥ 100% |
|---|---|---|---|---|
| 0.695 | 0.340 | 0.242 | 0.437 | 0.750 |

Thin volume tracks *flat*, not *risky*: both tails (crash and big win) are the *most* active. A
"low volume = high risk" band would be backwards, so the band is built on the *shape* of volume vs
price instead.

**3. Neither volume sub-signal separated rug from rising on the labelled corpus.**
`signal_ohlc_labels` (1,712 rug / 3,359 rising cards with ≥8 bars and volume):

| signal | rug p50 | rising p50 | rug mean | rising mean |
|---|---|---|---|---|
| `expansionRisk` (`1 − volGrowth/priceGain`) | 0.880 | 0.955 | 0.538 | 0.615 |
| `volCv` | 0.900 | 0.859 | 0.851 | 0.871 |

Directionally *inverted* (rising cards look more "manipulated" than rug cards) and the distributions
overlap almost completely. Caveat on the corpus itself: its rug cards are anchored at the label event,
so a rug card's window **ends in the dump** — ramp cards (price +80% & >70% green) are 1% of rug cards
vs 14% of rising cards. The corpus therefore cannot represent a *live pre-dump* ramp, which is exactly
what this scorer decides on.

**4. Liquidity is not back-validatable either.** `liq/mcap` against *current* mcap is confounded for
labelled rugs (rugged p50 0.35 vs non-rugged 0.075) because a rugged token's mcap has collapsed, so
the ratio inflates. No entry-time liquidity feature exists in `strategy_outcomes`. The band is
meaningful *live* (both numerator and denominator are "now"), but its anchor cannot be fitted from
history until entry-time liquidity is recorded.

**What would make this honest:** populate volume in `token_ohlc_bars`, record entry-time liquidity,
and snapshot ramp windows *before* the dump (not at the label event). Then re-run the same three
passes and fit `RUG_SIG_VOL_CV_SAFE`, `RUG_SIG_VOL_EXPANSION_W` and `RUG_SIG_LIQ_SAFE_RATIO` instead
of asserting them.

## Test plan

1. **Staircase fixture** built from the screenshots (20× 5m: step-up, >70% green, <5% mean bar gain, +82% window, tiny flat volume) → 40 + 30 + 17 = 87, `isRug` at the default threshold 80.
2. **Organic pump** (same rise but volume expands with price, tall wicks, high dispersion) → volume band 0, not rug.
3. **Healthy / no ramp** → volume band returns `price not rising` (0), not rug.
4. **Guardrail skip** (old + liquid) → evaluated but skipped with a reason.
5. **Liquidity band boundaries** — 4% → 82 (rug), 5% → 80 (exactly the threshold, rug), ≥10% → 70 (not rug).
6. **Volume band monotonicity** — flatter volume scores strictly higher on the same ramp; 0 when price is not rising.
7. **Confirmed dump** (single 5m −40%) → 5 of 10; confirmation, never a standalone trip.
8. `aggregateTo5m` bucket boundaries + partial last bucket.

## Out of scope v1

- The doc's Phase 2/3 (ML visual classifier, on-chain behavioural detection).
- Changing the reactive spine's rules or thresholds.
- Feeding the score into an ML corpus / closed-loop training.
- Auto-closing sim positions on a `rug-signal` (that is `closeOpenSimsForRadarDump`'s job today); v1 labels only.
- Populating `token_ohlc_bars.volume` from the sampler — required before the volume band can be calibrated, but it is a sampler/data change, not this scorer.

## Open items

1. **Unblock the volume band.** Record realised volume/turnover in the OHLC sampler (`src/app/api/ohlc/sample/route.ts`) so the 30-point band is not inert on the own-1m path. Without it, a ramp sourced from `token_ohlc_bars` scores at most 60.
2. **Fit the band anchors** (`RUG_SIG_VOL_CV_SAFE`, `RUG_SIG_VOL_EXPANSION_W`, `RUG_SIG_LIQ_SAFE_RATIO`) once (1) lands and entry-time liquidity is recorded — the measured passes above do not support the current values.
3. **Snapshot pre-dump ramps.** The label corpus anchors rug cards at the dump, so it cannot validate a pre-dump signal; capture ramp windows before the rug to build a usable calibration set.
4. Whether the trip should also `closeOpenSimsForRadarDump` (needs the dump, so probably not — revisit with data).

## Reviewer note (2026-10-01) — an outside read

Appended by a separate workstream that did **not** write or change the body above. Nothing here overrides the
author's decisions; it is a review, and the two items marked **blocking** are the ones to argue with.

**What is unusually good, and should be protected.** §Calibration refutes the module's own premise with data
(`volume_at_entry / entry_mcap` — thin volume tracks *flat*, not risky: 0.695 at the crash tail against 0.750
at the big-win tail) and states plainly that every band anchor is **chosen, not fitted**. Most modules in this
repo would have shipped the intuitive "low volume = dangerous" band and never looked. The `unknown → 0 points`
convention also fails *open* rather than assuming safety, which is the right default for a filter.

**B-1 (blocking) — `MODE` defaults to `enforce`, which collapses two decisions into one flag.** `RUG_SIGNAL_ENABLED=1`
alone produces an immediate `markTokenRug({source:'rug-signal'})` write, on anchors the SPEC itself says are
unfitted, from a corpus that cannot represent the case being decided. Everything in §Calibration argues that the
first arm should be observation only. Recommend the flag pair be re-cut as *arm* + *mode*, with the shipped
default `shadow` and an explicit second key to enforce — so enabling the detector and enforcing its verdict are
never the same keystroke.

**B-2 (blocking) — the labelled corpus is leaky by construction, not merely small.** §Calibration says a rug
card's window *ends in the dump* (ramp cards: 1% of rug cards vs 14% of rising). For a **pre-dump** signal that
is not a sample-size problem to be fixed with more rows — it is the wrong window, and no amount of re-fitting
inside it can validate the decision. §Open item 3 (snapshot pre-dump ramps) is therefore a **prerequisite for
enforce**, not an open item. Until then the scorer's accuracy is unknown in both directions, and the honest
status is "unmeasured", not "unfitted".

**The real decision rule is narrower than the score suggests.** Reachable maximum is `A + B + C = 90` against a
threshold of `80`, and `D` only arrives after the drop. So a trip requires a **full staircase (all 40)** plus
**at least 40 of the 60 band points** — in practice full volume *and* liq/mcap ≲ 5%. Worth stating explicitly in
§Trip rule, because it means this is overwhelmingly a **staircase detector with two vetoes**, not a weighted
score. It also means the module's recall is governed almost entirely by the staircase sub-conditions (four
booleans), which is a much smaller surface to get wrong — and to test.

**The own-1m inertness should be a loud guard, not a silent no-op.** With `token_ohlc_bars.volume` NULL the
volume band is 0, so a ramp on that path tops out at **60 < 80**: the scorer is not degraded, it is structurally
incapable of tripping. A reader who sets a threshold and sees no trips will conclude "no rugs found". Recommend
(i) the detector logs once at startup when its only reachable series has no volume, and (ii) the test plan pins
the cap explicitly — a case asserting `own-1m ramp ⇒ score ≤ 60 ⇒ not rug`, so the inertness is a documented
expectation rather than a discovery.

**A standing rule this module argues for.** Three "knobs wired but uncalibrated" now exist in this repo at once:
`ml_size_mult` (= `cl_p`, no rank power), the market scalar (`brain_size_scale`, pinned at 0.25 for the whole
window and applied to only one of four families), and this scorer. The difference is that this one *documents*
its uncertainty — which is why it is the best-behaved of the three. Suggest the repo adopt the rule explicitly:
**a scored gate ships with its calibration evidence, or it ships shadow.** See
[SPEC-sizing-level-2-probabilistic-v1.md](./SPEC-sizing-level-2-probabilistic-v1.md) §4 for the same gate written
from the sizing side.

**Minor.** The guardrail (`age < 48h` **or** `liquidity < 100k`) is an *or*, so it admits any young token
regardless of liquidity — which is probably intended, but it is the widest possible reading and worth one line
confirming. And the 15 documented `RUG_SIG_*` keys are a large tuning surface for a module whose anchors are
unfitted; nothing should move until B-2 lands, or the soak will be fitting noise.

---

## As built — 2026-10-01 (later the same day): measurement before enforcement

**B-1 is resolved, as recommended.** `RUG_SIGNAL_MODE` now defaults to **`shadow`**: arming the detector
(`RUG_SIGNAL_ENABLED=1`) can no longer write a `rug`, and enforcing requires the explicit
`RUG_SIGNAL_MODE=enforce`. Arming and enforcing are two keystrokes, as the review asked. Zero production effect
today — the feature ships off and there are no `RUG_*` keys in prod.

**B-2's prerequisite now exists.** The pre-dump windows the review called a *prerequisite for enforce* are
constructible: `token_metrics_history` holds per-minute **market-cap** candles (`o_min`/`h_min`/`l_min`/`c_min`,
`db/init/55-token-metrics-ohlcv.sql`, unit corrected in `db/init/56-token-metrics-candle-unit.sql`) plus USD
volume, and the validation harness labels each verdict by looking **forward** from its own timestamp — never
backward from the dump, which is what made the old corpus circular.

**The volume band is no longer inert.** The detector now reads the series first (`load1mOhlcv` →
`ohlcvMinutesToRugBars`), so the own-1m path is no longer the only reachable source and the 30-point band can
contribute. Measured on a real series: 268/268 5m bars carrying volume, against 0 before. The
`own-1m ramp ⇒ score ≤ 60` cap still holds on the fallback path, and that is now pinned by a test rather than
left to be discovered.

**Observation is now durable and readable.** Every evaluation — trips *and* non-trips — lands in
`rug_signal_shadow` (`src/strategies/rug-signal-shadow.ts`), surfaced at
`GET /api/rug-signal/shadow?limit=&token=&decision=`. The `console.info` verdict was not queryable and is
stripped from the production bundle entirely. Non-trips are recorded because they are the **control cohort**:
without them there is no base rate, and the radar-only call site (`gmgn-pipeline.ts`) can never produce one.
The metrics sweep scores the whole watch set for exactly this reason, and it never calls `markTokenRug`, so an
`enforce` mode cannot turn a measurement sweep into a decision.

**The harness and the acceptance rule.** `scripts/rug-signal-validate.mjs` (+
`scripts/run-rug-signal-validate-on-vps.sh`) reports, per cohort: base rate, precision and recall at the
threshold with Wilson intervals, per-day agreement, and a **minimum-sample floor below which the verdict is
`inconclusive`** — not a number, and never "no effect". Per the operator's rule, an anchor may be called
*fitted* only when the validation days agree. **Enforce stays gated on that:** if precision does not clear the
base rate, the script says so and enforcement does not happen.
