# SPEC — Sizing Level 2: per-trade weighting by P(win) v1

**Status:** To-spec (docs only) — **deferred, blocked**. Do not implement until the unlock in §4 is demonstrated on real closes.
**Date:** 2026-10-01
**Provenance:** [docs/diagrams/09-pnl-sizing.html](../../docs/diagrams/09-pnl-sizing.html) (what `ml_size_mult` is) · [10-knob-poker.html](../../docs/diagrams/10-knob-poker.html) (the two knobs) · [12-proposal-register.html](../../docs/diagrams/12-proposal-register.html) (P10, the rejection)
**Related:** [SPEC-strategy-data-pipeline-v1.md](./SPEC-strategy-data-pipeline-v1.md) (the feature standardization a probability model would need) · [SPEC-jev-soft-gate-shadow-v1.md](./SPEC-jev-soft-gate-shadow-v1.md) (the shadow-beside-a-code-path pattern this would follow)

## Why this SPEC exists at all

Level 2 — size each trade by how likely it is to win — is the intuitive design, and it is already
half-built: `ml_size_mult` **is** the closed-loop probability, used directly as the stake fraction.

It was tested twice and rejected both times. This SPEC exists so the rejection is recorded with its
evidence and its *unlock condition*, rather than being re-proposed every few weeks by whoever notices
that a per-trade knob looks better than a flat stake. **The verdict is "not yet", not "never"** — the
missing ingredient is a probability with rank power, and the moment one exists this document is the
build order.

## 1. What is actually wired today

| Fact | Evidence |
|---|---|
| `ml_size_mult` **is** `cl_p`, the closed-loop win probability | exact match on **748 / 748** rows (`features.ml_size_mult` vs `features.domain_features.cl_p`) |
| `cl_p` is applied as a haircut, never an up-size | `mult = max(0.25, cl_p)`, `cl_p ∈ [0,1]` ⇒ `mult ≤ 1`. The ceiling is the flat stake |
| The ML risk head the code documents is dead on this path | `ml_p_bad` stamped on **0 of 800** rows; `stampTargetMachineCl` calls `stampMlSize(features, sized)` with no `pBad` extra, and `sizeFromClosedLoop` passes `pBad: 1 − p`, collapsing `(1 − pBad)` back to `p` |
| A missing model is priced as *high* confidence | fail-soft `cl_p = 0.5`, the **largest** multiplier in the working band (0.27–0.42). Those rows win **16.2%**; 15 of social's 26 rows are in them, and every mcap family has zero |
| The spine is four days old | `cl_p` first appears **09-25** (0.8% coverage), 50.1% on 09-29, 94.6% on 09-30, 98.5% on 10-01 |

## 2. What was measured — the cliff

Four passes, all read-only, all on production `strategy_outcomes`. The sample is the **spine era**
(2026-09-30 → 10-01, Asia/Bangkok) because that is the only window where the score exists at all;
row counts move as the open window grows, so each figure states its snapshot.

### 2.1 Within a strategy the score does not rank trades

The claim that reopened this design was a within-strategy gradient of **+87% → +138%** in average PnL.
It was **four trades**:

| `cl_p` | Trades | Avg PnL % | Sum | Share of the bucket |
|---|---|---|---|---|
| 0.383 | 4 | +1157.9 | +4,632 | **34.9%** |
| 0.388 | 4 | +38.5 | +154 | 1.2% |
| 0.389 | 88 | +96.6 | +8,501 | 64.0% |
| *bucket average* | *96* | *+138.4* | *+13,287* | — |

The honest comparison is the two tiers that carry mass:

| `cl_p` | Trades | Avg PnL % | Std error |
|---|---|---|---|
| 0.341 | 73 | +87.0 | 31.2 |
| 0.389 | 88 | +96.6 | 22.1 |

Difference 9.6 points against a standard error of 38.2 — **t ≈ 0.25, i.e. noise.**

### 2.2 Across strategies the level is not comparable, and inverts

| Strategy | Median `cl_p` | Win % |
|---|---|---|
| search_mcap_first_seen_sl_30_tp150_h48 | 0.389 | 55.0 |
| search_mcap_first_seen_sl_30_tp300_h48 | 0.341 | 55.2 |
| mcap_enter_at_80 | 0.319 | 33.3 |
| **gmgn_sm_kol_combined** | **0.389** | **13.2** |
| **gmgn_kol_momentum** | **0.422** | **12.2** |
| **social_only_fomo_gt7** | **0.500** | **19.2** |

Same score, opposite outcome, no cross-strategy ordering. A raw level cannot be a book-wide multiplier.

### 2.3 The modelled consequence

Every scheme scored on identical rows at the same 0.005 SOL base:

| Scheme | Snapshot | PnL (SOL) | ROI / SOL staked |
|---|---|---|---|
| today (`mult = cl_p`) | 667 closes | +0.822 | 64.7% |
| flat | 667 closes | +2.353 | 70.6% |
| **Level 2 — normalized tilt, `0.5 + percentile_rank(cl_p)`** | 651 closes | **+1.896** | **66.8%** |
| flat, with the four losing families folded | 667 closes | +2.497 | 84.6% |

The tilt loses to a flat stake, and loses *worse* when composed with a combination that works
(2.026 vs 2.383 SOL on the 646-close snapshot). The paired excess is **−10.7 points per trade**; on the
independent-trades assumption t = −4.54, and clustered by token it stays negative and significant at
**t = −2.52 over 332 clusters**. It does not fail for want of power.

### 2.4 The structural reason

`mult = max(0.25, cl_p)` with `cl_p ∈ [0,1]` means the function **cannot** express conviction — its
maximum is the flat stake, so "size up the good ones" is not a reachable state. It is a volume knob
wearing a risk control's name. And the poker arithmetic says the same thing from the other side: with
average win **+173.7%**, average loss **−31.8%** and a **47.2%** hit rate, the break-even hit rate is
**15.5%** — the book sits at **3.05× its requirement**. The edge is the payoff ratio, which is an
*exit* property. It is not something a P(win) can amplify.

## 3. Why it is deferred rather than built

Not a lack of effort and not a lack of plumbing — the plumbing exists today. It is deferred because
**the probability it would consume does not discriminate**, and a weighting applied to a
non-discriminating score adds variance without adding equity. Building it shadow-first would be the
right *process* for a promising candidate; this one is not a candidate on the current score.

## 4. The unlock condition (the only way this moves)

Implement only when **all four** hold, measured on real closes, not on a fixture:

1. **Rank power within a strategy.** Bucketing a candidate probability into at least five bins, the
   realized win rate and mean PnL are **monotone** in the bin, and the top-vs-bottom-bin difference
   clears a 95% confidence interval.
2. **Sample floor.** Every bin carries ≥ `READINESS_MIN_SAMPLE` closes (default 30). Below the floor the
   verdict is `insufficient`, never "promising".
3. **Cross-strategy comparability, or explicit normalization.** Either the score's level is comparable
   across strategies, or the build normalizes within strategy (§5) — a raw level is already known to
   invert across families (§2.2).
4. **Lift over flat on the same rows.** The normalized weighting beats a flat stake on ROI per SOL
   staked, clustered by token, on the identical row set.

If 1–4 hold, this SPEC becomes an implementation order by editing the Status line. If any fails, the
build stays unstarted and the register's P10 stands.

## 5. Locked decisions for the eventual build

| # | Lock |
|---|---|
| 1 | **Normalize within strategy.** `q_s` = the percentile rank of the probability inside its own strategy's distribution. The raw level is never the multiplier (§2.2). |
| 2 | **Bounded and mean-1.** `mult = clamp(lo + q_s × (hi − lo), lo, hi)`, centred so `E[mult] = 1`. Shape must be separable from level: the weighting redistributes a given bankroll, it does not change how much is at risk. |
| 3 | **Never a hard gate.** This is a weighting, not a skip. Removal decisions are selection (fold), which is binary and already shipped as P3. |
| 4 | **Missing model is neutral or reduced — never the largest multiplier.** The current fail-soft `cl_p = 0.5` is a defect (§1); any successor maps "no score" to `1.0` at most. |
| 5 | **Ship shadow-first.** `SIZE_MODE=down\|normalized`, default `down` (today's behaviour). `normalized` logs what it *would* have staked on every open and changes no stake. |
| 6 | **Enforce only on significance.** `enforce` refuses to act unless §4 is satisfied at the current sample; the decision function returns `no_evidence` rather than a weight when the test is inconclusive. |
| 7 | **The shadow sink needs a reader.** It ships with a route that reports the counterfactual, or it is another dead store. |
| 8 | **Every threshold env-tunable**, and the base stake is decided with — not after — any change that raises average exposure. |

## 6. Formula (the eventual shape, not shipped)

```
# per open
p      = probability that the trade wins            # must clear §4 before this is wired
q_s    = percentile_rank(p) within strategy s       # 0..1
mult   = clamp(LO + q_s * (HI - LO), LO, HI)        # bounded; centred so E[mult] = 1
stake  = SIM_BASE_POSITION_SOL * marketScalar * mult # marketScalar is Level 1, separate

# missing / unscored
mult   = 1.0                                        # never the largest value in the band
```

## 7. Env

| Key | Default | Meaning |
|---|---|---|
| `SIZE_MODE` | `down` | `down` = today's behaviour. `normalized` = the shadow weighting. |
| `SIZE_TILT_LO` | `0.5` | Bottom of the bounded range. |
| `SIZE_TILT_HI` | `1.5` | Top of the bounded range. |
| `SIZE_MIN_SAMPLE` | = `READINESS_MIN_SAMPLE` | Floor per bin before a verdict may be `candidate`. |
| `SIZE_KILL_SWITCH` | `0` | Forces `shadow` regardless of `SIZE_MODE`. |
| `SIM_BASE_POSITION_SOL` | `0.005` | Unchanged; the level dial, decided with this change, not after it. |

## 8. Non-goals

- **Not** a re-tune of `cl_p`. The score itself is someone else's problem; this SPEC is about whether a
  probability may size a trade.
- **Not** an entry filter, a hard gate, or a skip. Folds are selection (§5.3).
- **Not** a Level 1 replacement. The market scalar is a different axis, is exactly linear, and is
  blocked on a *signal* (§ the register's P6) — not on this.
- **Not** a reason to keep the current multiplier alive while waiting. Today's `mult = cl_p` is a
  measured drag on its own and is removed by P1 regardless of what happens here.
- **Not** a change to any live execution path. Paper only, and gated as in §5.5.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Shipping the weighting on a score that merely *looked* monotone in one bucket | §4.1 requires a monotone five-bin curve with a CI, and §4.2 a per-bin sample floor |
| Amplifying a right tail — one +1158% trade decides a bin | Cluster by token, report the CI, and never rank by mean alone (the +138% bucket is the cautionary case, §2.1) |
| Mean-1 normalization silently raising gross exposure | §5.2 separates shape from level; the base stake is decided with the change |
| Re-introducing the fail-soft inversion | §5.4, pinned by test |
| The window is two days and one regime | §4 must be re-run on a held-out window before `enforce` |

## 10. Verification gate (when it is eventually built)

1. `npm run verify:no-raw-useeffect` · `npm run verify:no-hardcoded-sol-price` · `npx tsc --noEmit` — clean.
2. Unit: the mapping is bounded, mean-1, monotone in `q_s`, and returns neutral for an unscored trade.
3. Replay: the normalized weighting and flat are scored on the **identical** row set, clustered by
   token, with the CI reported; `enforce` refuses when the CI crosses zero.
4. Shadow soak: `SIZE_MODE=normalized` for a full window, with the reader route showing the
   counterfactual, before any `enforce`.
5. A production build, and the reader route returns the counterfactual on prod.

## 11. Open items

1. **Nothing here is implementable yet** — §4 is the whole document. Treat this as a parked handoff.
2. The probability this would consume is not named. `cl_p` is the incumbent and fails §4.1. A successor
   is most likely a *later-street* read (the exit models already in shadow) rather than an entry score.
3. The current fail-soft defect is **independent of this SPEC** and worth fixing on its own: a missing
   model maps to 0.5, the largest value in the working band. See the register's P2 / C-2.
