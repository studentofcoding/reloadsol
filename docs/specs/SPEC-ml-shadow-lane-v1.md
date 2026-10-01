# SPEC — Tidy the ML shadow lane (ML1 gate / ML2 potential / exit overlay) v1

**Status:** to-spec (docs only)
**Date:** 2026-10-01
**Supersedes:** [SPEC-v2-heads-removal-v1.md](./SPEC-v2-heads-removal-v1.md) — **withdrawn.** That SPEC concluded "never used → delete" from env + artifact paths alone. That was wrong: the lane **runs and records**. The correction is below; the deletion plan is off the table.
**North star:** the **rug label** — getting the staircase/ramp pattern labelled `rug` reliably. This lane is one of the consumers that would carry that signal, not a side quest.

## 1. Corrections to the record

| I claimed | Measured reality |
|---|---|
| "Neither head has ever loaded → dead" | True that **no ONNX artifact exists** (`v2-gate` / `v2-potential` are absent from web, cron and host — only `pattern-gate` exists), **but the lane is wired, runs, and records**. |
| "Nothing consumes it" | `ml_exit_overlay_*` is written on **2,493 rows** — tier, moon score, p_winner, source, and base-vs-effective exit parameters. It runs on the live sim-open paths. |
| "Remove it" | Wrong shape of fix. The lane is the *measurement* half of a measure-then-enforce design. The defect is that it is **starved and untuned**, not that it is unused. |

## 2. As-is, measured in prod (2026-10-01)

| Surface | State | Evidence |
|---|---|---|
| Attach point (`ml-entry-shadow.ts`) | **runs** at sim open | on the mcap + signals live paths |
| ML1 gate (ONNX) | **cannot load** | no `v2-gate` anywhere; **no `ML_GATE_*` env at all** |
| ML2 potential (ONNX) | **cannot load** | `ML_POTENTIAL_ARTIFACT_DIR=/ml/artifacts/v2-potential` — path does not exist (missing `/app`); no `v2-potential` dir anywhere |
| Skip accounting | **conflated** | `ml_skipped='no_model_or_incomplete_features'` × **2,621**; `'incomplete_token_features'` × **3** — the mass hides which one it is |
| ML2 exit overlay | **runs, shadow, no-op** | 2,493 rows, **100% `source='identity'`**, `tier` null, `applied=0`, `sl_changed=0`, `tp_changed=0` |
| Head scores in the data | **absent** | **zero** `ml_gate_*` and **zero** `ml_potential_*` keys across 82,861 rows → the heads are unevaluable even if they ran |
| Overlay config | **never persisted** | no `strategy_definitions['ml2_exit_overlay']` row → `loadPotentialExitOverlayConfig()` always falls through to defaults |
| Closed-loop model | **live and acting** | `ML_CLOSED_LOOP=1`, logistic, n=**3,616** (1,310 pos / 2,306 neg), accuracy **0.6377** |
| Sizing knob | **live** | `ml_size_mult` on 1,629 rows (0.27–0.34) |

**One sentence:** the lane measures a head that isn't there, tuned by a config that doesn't exist, and records a
no-op as though it were a result — 2,493 rows that look like "the overlay would have changed nothing" but are
actually "the overlay had nothing to say".

## 3. The parameters — what exists to tune

**ML2 exit overlay config** (`src/strategies/potential-exit-overlay-config.ts`), all currently **defaults only**:

| Parameter | Default | Meaning |
|---|---|---|
| `clamps.tpMin / tpMax` | 50 / 500 | TP clamp |
| `clamps.slMin / slMax` | −80 / −20 | SL clamp |
| `moonScorePromote.tier3 / tier4` | 0.45 / 0.65 | moon-score → tier promotion |
| `pWinnerNudge.min / tpBonus / minTier` | 0.6 / +25 / 2 | p_winner ≥ min nudges TP |
| `tiers.1` | TP ≤ 100, SL tighter −35 | weakest tier: cap the upside, tighten the stop |
| `tiers.2` | — | identity |
| `tiers.3` | TP ≥ 250, hold +24h (cap 120) | let it run |
| `tiers.4` | TP ≥ 350, SL wider −60, hold +48h (cap 144) | let it run further, tolerate more heat |
| `exitModeOverride` | `null` → `ML_POTENTIAL_EXIT_MODE` → unset → **`shadow`** | never applies |

**Env:** `ML_GATE_MODE` unset (→ `shadow`), `ML_GATE_P_BAD_MAX` unset (→ 0.5), `ML_POTENTIAL_EXIT_MODE` unset
(→ `shadow`), `ML_PATTERN_MODE=shadow`, `ML_PATTERN_P_WINNER_MIN=0.5`, `ML_CLOSED_LOOP=1`.
**Admin surface:** `Ml2ExitOverlayPanel` exists and edits the `strategy_definitions` row — a row that has never
been created, so the panel has only ever shown defaults.

## 4. The five defects, in order of what they cost

| # | Defect | Cost |
|---|---|---|
| **D1** | **Starved input.** The overlay's tier/p_winner come from a head that cannot load, so every row is `identity`. | the lane cannot learn anything; 2,493 rows of silence |
| **D2** | **Skip reasons conflated.** `no_model_or_incomplete_features` covers both. | a real data regression (the 3 `incomplete_token_features`) is invisible inside 2,621 |
| **D3** | **Head outputs are never recorded.** Zero `ml_gate_*` / `ml_potential_*` keys exist. | even with a model, neither head could be evaluated against outcomes |
| **D4** | **Config never persisted / never tuned.** No `strategy_definitions` row. | the whole tier table is asserted, not measured; the admin panel is decorative |
| **D5** | **No counterfactual.** The overlay records base == effective and nothing else. | the tier→exit mapping cannot be scored against outcomes even in principle |

## 5. How to tidy it (ranked, cheapest first)

1. **Split the skip reason** (D2). One-line change: emit `no_model` when the artifact is absent and
   `incomplete_features` when the vector is short. Immediately tells us whether the lane is model-less or
   data-broken — today we cannot tell.
2. **Persist the config** (D4). Write the `ml2_exit_overlay` `strategy_definitions` row from the code defaults so
   the panel becomes a real control surface and every later change is a diff, not a code edit.
3. **Record what the heads would have said** (D3). Write `ml_gate_p_bad` / `ml_potential_tier` (or an explicit
   `ml_gate_skipped` reason) so the lane is evaluable the day a model exists. This is the same
   *counterfactual-first* shape already used for `ohlc_rug_*`.
4. **Give the overlay a signal it can actually use** (D1) — the decision, §6.
5. **Record the per-tier counterfactual** (D5). On a sample, store the exit the overlay *would* have chosen per
   tier, so §7 can score the mapping instead of asserting it.

## 6. How to make it beneficial — pick a real signal

The overlay needs a tier source. Three candidates, cheapest first:

| Option | Signal | Cost | Honest caveat |
|---|---|---|---|
| **(a) Re-point at the closed-loop score** | `mlScore` from the live logistic (n=3,616) | no new model; the signal exists today | it is a 0–1 win-probability, so tier cut-points must be chosen — a new parameter to tune |
| **(b) Restore the potential head** | regenerate `v2-potential` artifacts + fix `ML_POTENTIAL_ARTIFACT_DIR` | a training run + a deploy | the head was archived 2026-07-05 and its entry feature set is exactly what P2 is standardising |
| **(c) Feed it the rug / ramp signal** | the ramp score's components (`SPEC-rug-signal-v1`) | needs the rug-pattern data collection (`SPEC-rug-pattern-data-v1`) | ties the lane to the north star; not available until volume + metrics history land |

**Recommendation: (a) now, (c) as the goal.** (a) turns a dead lane into a measured one this week using a model we
already trust enough to have in prod; (c) is the reason the lane should exist at all — the ramp/rug signal is what
we actually want an exit overlay to react to. (b) is the most expensive and trains on a schema about to change.

## 7. Evaluation plan (what "beneficial" has to be proven with)

Once (a) or (c) supplies a tier, and D3/D5 record the inputs:

- **Does the tier predict the outcome?** Score distribution + mean/median pnl + win rate per tier on closed rows;
  CIs and an explicit `inconclusive` below a minimum-sample floor.
- **Does the overlay beat the base exit?** Replay base-vs-effective on the recorded counterfactual; report
  Δpnl per tier, and say plainly when it is a wash.
- **Is the mapping monotone in tier?** A tier table whose tiers do not order by outcome is asserting structure
  the data does not have.
- **Kill criterion:** if no tier separates after the sample floor, set `exitModeOverride = 'off'` and stop
  paying for the lane — that is a legitimate, documented outcome.

## 8. Acceptance / open items

**Acceptance:** the lane's skip reason names a specific cause; the config exists as a row; the head inputs and the
per-tier counterfactual are recorded; the tier→outcome table is published with CIs and an `inconclusive` state.

**Open**
1. Which tier source — (a) closed-loop, (b) restore the potential head, (c) the rug/ramp signal?
2. If (a): the tier cut-points on `mlScore` — a new parameter, and it must not be fitted on the same rows it is evaluated on.
3. Whether `Ml2ExitOverlayPanel` should stay exposed while the lane is `identity` (it currently implies a control that does nothing).
4. The three `incomplete_token_features` rows — a real data gap, or the tail of an old writer? Worth 5 minutes before D2 hides them again.
