# SPEC — Exit optimisation: the stop sweep and the shadowed exit overlays (P4 + P5)

**Status:** To-spec (docs only) — **for review, nothing implemented**. No code changed by this document.
**Date:** 2026-10-01
**Provenance:** [docs/diagrams/12-proposal-register.html](../../docs/diagrams/12-proposal-register.html) (P4 = the ranked #2 lever, P5 = #5) · [10-knob-poker.html](../../docs/diagrams/10-knob-poker.html) (the payoff-ratio arithmetic that makes P4 the large one)
**Related:** [SPEC-sizing-level-2-probabilistic-v1.md](./SPEC-sizing-level-2-probabilistic-v1.md) (the same evidence-gate shape, applied to size) · [SPEC-ohlc-own-1m-v1.md](./SPEC-ohlc-own-1m-v1.md) (the bar series both replays read)

## Why these two, and why together

Every lever currently under discussion is an **entry** lever, and the entry is not where this book's edge lives. Measured on the spine era: average win **+173.7%**, average loss **−31.8%**, hit rate **47.2%** — so the break-even hit rate is **15.5%** and the desk sits at **3.05× its requirement** with a payoff ratio R of **5.46**. An edge that is that far above its break-even *cannot be improved by hitting more often*; it moves only through the payoff ratio, which is an **exit** property.

And the exit has been treated asymmetrically:

| axis | state | evidence |
|---|---|---|
| **take-profit** | swept three ways, inert | TP 142 / 189 / 283 → win rate **56.7 / 55.2 / 57.1%** |
| **stop** | **never swept** | every mcap strategy runs **−31.7%**, unchanged across all variants |
| **dynamic exit** | built, shadowed, never applied | `ml_exit_overlay` present on **1136** rows, `shadow` on **1136**, applied on **0** |

So the probe is: the one axis with no test behind it (P4), and the machinery that would make the exit dynamic, sitting inert (P5). They belong in one SPEC because P5's first measurement changes what P4 should sweep — see §P5.

## What is measured today (read-only, prod, 2026-10-01)

**The replay is feasible.** `token_ohlc_bars`, last 2 days:

| trades | ≥20 bars covering entry→exit | ≥5 bars | avg bars per trade | bars stored | bars with volume |
|---|---|---|---|---|---|
| 796 | **679** | 756 | 81.8 | 875,648 | **0** |

Retention is ~48h (`OHLC_BARS_RETENTION_HOURS`), which is exactly the spine era — so a first sweep is a same-window comparison rather than a long backtest.

**The overlays are wired and inert.** From `strategy_outcomes` (3 days, 1322 rows):

- `ml_exit_overlay_mode` present on **1136**; **shadow** on 1136; **applied on 0**.
- `gmgn_exit_boost_mode` present on **243**.
- Where an overlay fired, its own `ml_exit_effective_take_profit_pct` differs from `ml_exit_base_take_profit_pct` on **1136 / 1136** rows — while the stop-loss pair differs on **0**. **The overlay is a take-profit modifier only.**

That last line is the important one and it cuts against P5's value: a shadow layer that only moves take-profit is pushing the axis we have already measured as inert. P5's job is to confirm or kill that, not to promote it by default.

## P4 — the stop sweep

### The arithmetic that motivates it

| stop | avg loss | R | break-even hit rate | headroom over 47.2% |
|---|---|---|---|---|
| **−31.7 (as-is)** | −31.8 | 5.46 | **15.5%** | 3.05× |
| **−16** | −13.4 | 12.96 | **7.2%** | **6.6×** |

The +0.247 SOL in the register is an **upper bound**, obtained by clamping realised losses. Clamping assumes no trade that fell past −16 ever recovered — which is false by construction. This SPEC exists to replace that bound with a replay.

### Method

1. For each of the 679 trades with adequate bars, load its `[entry_at, exit_at]` window from `token_ohlc_bars` (1m).
2. Re-simulate the exit under each candidate stop in `{ −16, −20, −25, −31.7 }`, walking bars forward from entry and taking the **first** bar whose `low` breaches the stop; otherwise the recorded exit.
3. Score per SOL staked, on the identical row set, **paired** against the recorded outcome for the same trade.

### The honest caveat, stated up front

`token_ohlc_bars` is built from **15s Jupiter spot samples** folded into 1m (open/high/low/close = sampled extremes), so its `low` is a *sampled* low, not a traded low. A real intrabar wick can be missed, which means the replay **under-triggers tight stops** — biasing results *in favour of* the tighter stop.

This does not invalidate the comparison, because **the recorded outcomes came from the same sampled series** — so the replay and the baseline are apples-to-apples on identical bars and the sampling bias largely cancels in the *difference*. It does invalidate any claim about absolute PnL, and it is why the SPEC's verdict is stated as a direction with a confidence interval, never a headline number.

**Second caveat:** the replay cannot see a stop that was never reached in *any* sample but was reached in reality. Any candidate stop whose advantage rests on a handful of trades is `inconclusive`, not a winner.

### Tasks

1. `scripts/replay-stop-sweep.mjs` — read-only, `--apply`-free (it writes nothing): pull trades + bars, replay the four stops, emit per-stop PnL / ROI / win-rate / drawdown **and a per-token clustered confidence interval** on the difference against as-is.
2. Report the **distribution of stop hits per candidate**, not just the total — a stop that only helps because it truncates three trades is not a stop, it is a lottery ticket.
3. Re-run with the trades restricted to **mcap/search only** (the family that carries the book) as a robustness check; if the direction flips between the whole book and that family, say so.
4. Only then decide whether `stopLoss` moves, and by how much — and record the number in the register as *measured* rather than bounded.

## P5 — the shadowed exit overlays

### What is actually there

`ml_exit_overlay` (all domains) and `gmgn_exit_boost` (gmgn only) both exist, are wired into the sim-open path, and have never been applied. The strategies are **preflop-only** today: `cl_p` is stamped once at entry, TP/SL are fixed at entry, and the exit is a rule (`close_reason: max_hold`). The market hands over new information every tick and nothing re-decides with it.

### The gate — and the reason to expect a "no"

Promote only if the shadow exit shows **lift over the recorded exit on the identical rows**, clustered by token, at the `READINESS_MIN_SAMPLE` floor. Given §"What is measured today" — the overlay moves **only take-profit**, and take-profit has already been swept three ways against a flat win rate — the prior is that P5 returns **inconclusive or negative**. The right outcome of this SPEC may well be "leave both in shadow and delete the boost", and that is a success, not a failure.

### Cross-reference — this may already be answered, and better

A parallel workstream has `SPEC-ml-shadow-lane-v1.md` in review, which measures the same lane from the other
side and is **more specific than the reading above**: the overlay runs and records on **2,493 rows**, but is
**starved and untuned** — every row `source='identity'`, tier null, and **0 exit parameters changed**.

If that holds, it resolves this SPEC's Step 0 in the negative and **P5 closes with no code**: the "1136 rows
where the effective/base TP differ" above is the overlay's *internal* base-vs-effective bookkeeping, not a
change against the TP the strategy actually used. That is exactly the ambiguity Step 0 existed to remove —
so the honest state here is that **P5 belongs to `SPEC-ml-shadow-lane-v1.md`**, and this section should be read
as the exit-side rationale for tidying that lane rather than as a competing plan. Do not execute both.

### Tasks

1. **Resolve the ambiguity first — but check `SPEC-ml-shadow-lane-v1.md` before running it.** The stamped pair says the overlay's effective TP always differs from its *own* base TP, but that is internal bookkeeping — it does **not** yet say it differs from the TP the strategy actually used. Step 0 is a read-only query joining `ml_exit_effective_take_profit_pct` against the strategy's own effective TP (`cl_take_profit_pct` / the strategy base) to establish whether promoting the overlay would change behaviour at all. **If it would not, P5 closes here** with no code.
2. If it would: replay the shadow TP against the recorded exit on the rows where it fired, and report lift with the same clustered CI as P4.
3. If lift is significant: promote behind `ML_EXIT_OVERLAY_MODE=shadow|enforce` (default `shadow`), fail-soft, with a kill switch — the repo's standing gate shape.
4. Ship the **counterfactual reader** with it. A shadow sink with no reader is another dead store; both overlays have been invisible for their whole life, which is how they stayed inert unnoticed.

## Locked decisions

| # | Lock |
|---|---|
| 1 | Both replays are **read-only** and write nothing to `strategy_outcomes` or `trading_records`. |
| 2 | Both are scored on the **identical row set**, paired against the recorded outcome, with a **per-token clustered** CI. No unpaired headline. |
| 3 | Verdicts carry an **`inconclusive`** state below the sample floor — "no result yet" must not read as "no effect". |
| 4 | The stop sweep moves a **live** parameter, so it ships behind its replay result and is decided **with** the base-stake question, not after it (register C-7). |
| 5 | Both overlays stay `shadow` until §P5 task 1–2 pass. Promotion is a separate change with its own kill switch. |
| 6 | The bar series' sampled-low limitation is stated in the output of every sweep, not just here. |

## Env (proposed; nothing added yet)

| Key | Default | Meaning |
|---|---|---|
| `STOP_SWEEP_CANDIDATES` | `-16,-20,-25,-31.7` | Stops to replay. |
| `STOP_SWEEP_MIN_BARS` | `20` | Bars a trade needs to be replayable. |
| `STOP_SWEEP_WINDOW_DAYS` | `2` | Bounded by bar retention. |
| `ML_EXIT_OVERLAY_MODE` | `shadow` | Existing; `enforce` never shipped. |
| `GMGN_EXIT_BOOST_MODE` | `shadow` | Existing; same. |

## Non-goals

- **Not** a re-run of the take-profit sweep — that axis is measured inert and stays put.
- **Not** a change to the Level 1 market scalar or to `ml_size_mult` (P1 shipped 2026-10-01; sizing is flat).
- **Not** the volume band. `token_ohlc_bars.volume` is NULL on all 875,648 rows and the upstream 1m-volume source returns zero candles — a separate blocker, tracked in [SPEC-rug-signal-v1.md](./SPEC-rug-signal-v1.md).
- **Not** a long backtest: bar retention is ~48h, so both sweeps are same-window comparisons by construction. Extending the window is a data-retention change, not a sweep change.
- **Not** a live-execution change. All of this is the paper desk.

## Risks

| Risk | Mitigation |
|---|---|
| The replay's sampled low under-triggers tight stops, flattering them | Paired comparison on identical bars, bias direction stated in the output; no absolute-PnL claim |
| A stop "wins" on three trades | Report the distribution of stop hits; require the CI and the sample floor |
| P5 is promoted because it is built, not because it works | Task 1 can close P5 with no code; a "no" is a valid outcome |
| A stop change is made in isolation and breaks exposure accounting | Lock 4: decided with the base stake |
| Survivorship in the bar set (only mints the sampler watched) | State the watch-set selection; 679/796 coverage is the honest denominator |

## Verification gate

1. `scripts/replay-stop-sweep.mjs` produces a per-stop table with a clustered CI on the paired difference, and a stop-hit distribution — and writes nothing to the database.
2. Re-running it on an unchanged window reproduces the same numbers (pure over the same bars).
3. P5 task 1's query is committed as a documented one-liner so the "would it change anything?" question is re-askable.
4. Only if a stop moves: the repo gate (`tsc`, full `vitest`, `eslint`, build), then the shrink-wrap deploy chain, then a live smoke on the paper dashboard.

## Open items

1. **P5 task 1 is probably already answered elsewhere** — `SPEC-ml-shadow-lane-v1.md` measures the lane as
   `source='identity'` with **0 exit parameters changed**, which would close P5 with no code. Confirm against
   that SPEC before running anything here; if it holds, this SPEC's P5 section is rationale, not a plan.
2. **Stop-hit distribution is unmeasured** — the sweep's first output should be the histogram, before any PnL summary.
3. Whether the stop should be per-family rather than global. `mcap_enter_at_80` runs **−53.9** while `search_mcap…` runs **−31.7**; a single sweep value may be the wrong shape.
4. The `gmgn_exit_boost` overlay (243 rows) is untouched by both tasks above and may belong to a third thread.
5. Nothing here addresses the **entry** side, deliberately — the register's P3 (fold) and P1 (flat) are the entry-side answers and both have shipped.
