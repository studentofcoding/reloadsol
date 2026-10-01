# SPEC — The exit standard: one live valuation, one decision, every strategy

**Status:** To-spec (docs only) — **for review, nothing implemented**. No code changed by this document.
**Date:** 2026-10-01
**Provenance:** the debug trace of 2026-10-01 (`scripts/replay-stop-sweep.mjs --slippage`, prod reads) ·
[SPEC-exit-optimization-v1.md](./SPEC-exit-optimization-v1.md) (P4/P5) · [12-proposal-register.html](../../docs/diagrams/12-proposal-register.html)
**Related:** [SPEC-sizing-level-2-probabilistic-v1.md](./SPEC-sizing-level-2-probabilistic-v1.md) (the same
"one path, evidence-gated" shape applied to size)

## Why: the record and the reality disagree by half

Every number below is retention-bounded — both ends of the move read from the **same** `token_ohlc_bars`
series, bars within 3 minutes of entry and exit, so a stale cache cannot enter either side. n = **749**.

| | recorded (`pnl_pct`) | **real (price)** |
|---|---|---|
| average PnL | **+77.7%** | **+18.0%** |
| **win rate** | **50.2%** | **26.6%** |

Broken out by the closer that produced it:

| close_reason | n | avg recorded | avg real | gap | "wins" where price fell |
|---|---|---|---|---|---|
| `take_profit_200` | 161 | +340.1 | **+277.9** | +62 | 13 |
| **`max_age`** | 68 | **+21.3** | **−43.3** | **+64.6** | **17** |
| `label_rugged` | 50 | −48.8 | −61.6 | +12.8 | 0 |
| `stop_loss` | 49 | −56.0 | **−60.1** | **+4.1** | 0 |
| `take_profit` | 3 | +110.8 | +236.6 | −125.8 | 0 |
| `max_hold` | 3 | −21.6 | −11.1 | −10.5 | 1 |

Three things follow, and they set the whole standard:

1. **The losses are honest; the wins are not.** `stop_loss` diverges by **4.1pp** and `label_rugged` by
   12.8pp — the recorded loss slightly *understates* the real one. `take_profit_200` is a **genuine** winner
   (+277.9% real). But `max_age` records **+21.3% where the price did −43.3%** — a **64.6pp** gap, with 17 of
   68 booked as >+20% winners while the price fell.
2. **The edge is real but narrower than the record.** The mcap family's profitability is concentrated in
   `take_profit_200` — 161 trades at a real +278%. Take-profit works. What inflates the record is
   `max_age`.
3. **The three TP variants are not independent evidence.** On one mint they recorded **identical `+30.9`**
   against three different entry prices (real −69.0 / −64.6 / −5.6), and their win rates are
   55.0 / 54.9 / 55.2%. They share one input, so they are one observation counted three times.

### The mechanism

One field does two jobs, and it is a cache:

```
token_mcap_tracking.mcap_growth_percent
  → the SL/TP trigger        (fires late, or never once the row freezes)
  → the exit valuation       (so the recorded PnL is the stale number)
  → shared by every strategy holding that token
```

Observed staleness at the moment of the exit: **18 → 481 minutes**. The tracker stops updating a token that
ages out of its watch set, the position stays open, and the evaluator keeps reading the same frozen value.
A frozen input can never cross a threshold, so the only rule left that fires is the age timeout — which is
why `max_age` takes 68 closes and every phantom win.

Two consequences already visible in the same data: the `stop_loss` cohort exits at **−60.1% real** against a
−32% threshold (the trigger evaluates a stale value too, just not frozen), and `sltp_monitor` has fired
**`TP1: 0, TP2: 0, TP3: 0` across 211 finishes** — it compares a *price* against a target the strategies
express in *mcap*.

## The standard (the contract)

Every strategy, paper or live, satisfies all seven. Nothing else evaluates an exit.

| # | Rule |
|---|---|
| **S1** | **One valuation.** A position's PnL is computed from one live price series (entry and exit from the *same* series). No cache, no tracker field, is ever used as a *price*. |
| **S2** | **One decision.** A single `evaluateExit(position, { priceUsd, mcap }, now)` is the only exit evaluator. It returns `{ close, reason, pnlPct, basisUsed }` — reason from a closed set (`stop_loss`, `take_profit`, `max_hold`, `max_age`, `label_rugged`, `hold`, `stale`). |
| **S3** | **Basis is explicit data, not the route.** Each strategy declares what its SL/TP are *expressed in* — `price` or `mcap`. The evaluator branches on that field, never on which route called it. (Today: `getMcapSimCloseReason` is mcap-based, `shouldClosePriceSimPosition` is price-based, and which one runs depends on the sim-track.) |
| **S4** | **Triggers read live, never cached.** A threshold is compared against the S1 value. A staleness older than `EXIT_MAX_INPUT_AGE_SEC` yields `reason: 'stale'` — never a silent `hold`, and never a valuation from the stale value. Fail-closed on risk. |
| **S5** | **Backstops are backstops.** `max_age` / `max_hold` are last resorts. Their **count is a health metric** with a threshold that alerts, because it measures how often the primary exit failed to fire. Last resort means ~0, not 9% of closes. |
| **S6** | **One writer per row.** `sl_tp_positions` is a *mirror* for paper positions: written and closed by the sim that owns the position. `sltp_monitor` owns live rows only and **skips `is_simulation = true`**. No two evaluators write the same row. |
| **S7** | **Coverage is asserted.** A registry (or a test enumerating the sim-track routes) asserts that every strategy's open path reaches S2. The whole point of this SPEC is that "reaches one consumer" must be impossible to ship again. |

### Live later, without a second implementation

```
decision = evaluateExit(…)
if (!decision.close) return
if (isSimulatedPosition(position)) recordSimClose(decision)   // paper
else                              executeSellOrder(decision)  // live
```

`isSimulatedPosition` and `executeSellOrder`'s hardcoded `isSimulated: false`
(`sl-tp-tracker.ts:424-434`) stay exactly as they are. That invariant is why a paper stop has never spent
real money, and nothing here weakens it.

## Migration, by family

| family | today | after |
|---|---|---|
| `search_mcap_*`, `mcap_enter_*` | `getMcapSimCloseReason` on the tracker's cached growth; also mirrored into `sl_tp_positions` and second-guessed by `sltp_monitor` | S2 with `basis: 'mcap'`; trigger **and** valuation from the live series; mirror closed by the sim |
| `signals_*` | `shouldCloseSignalsClExit` (mcap-preferred, price fallback) | S2, `basis` declared once |
| `gmgn_*`, `social_*` | `shouldClosePriceSimPosition`; no `sl_tp_positions` row at all | S2, `basis: 'price'`; paper has no mirror (nothing reads it) |
| `att_rh` | the RH sim's own `buySim`/exit ladder; the tracker path explicitly excludes sims | S2, `basis` per its exit config |
| live | `runSLTPMonitorAndSummarize` + `executeSellOrder` | unchanged in this pass; wired to S2 in a later, separate change with its own soak |

## Env

| Key | Default | Meaning |
|---|---|---|
| `EXIT_MAX_INPUT_AGE_SEC` | `180` | Older than this and the decision is `stale`, never a hold-from-cache. |
| `EXIT_CHECK_INTERVAL` | `30` | The exit pass interval. Cheap — bounded by open positions (~150), no GMGN/Jupiter search, so it is **not** subject to the entry scan's 900s budget. |
| `EXIT_BACKSTOP_ALERT_PCT` | `10` | Alert when backstop closes exceed this share of closes in a window. |
| `EXIT_BASIS_<strategy>` | per strategy | `price` \| `mcap`. Declared, not inferred from the route. |

## Non-goals

- **Not** a change to any stop or take-profit **level**. The mechanism is the confounder; move one at a time.
- **Not** a change to the entry scan cadence. That stays at 900s for the GMGN budget — the whole point of S1's
  price source and `EXIT_CHECK_INTERVAL` is that the exit is cheap enough not to need the entry scan's clock.
- **Not** a live-execution change. Live keeps its current path until the paper path has soaked.
- **Not** a re-derivation of the strategy register. That is the *first consumer* of this SPEC, not part of it.
- **Not** the volume band or the rug detector; those are separate blockers.

## Risks

| Risk | Mitigation |
|---|---|
| A live valuation *raises* losses (the recorded numbers get worse, not better) | that is the point — the record currently overstates by 60pp on the phantom cohort. Report both bases during the transition so the change is visible, not silent. |
| The exit pass at 30s adds DB load | bounded by open positions, one batched price read, no discovery. Measure before/after on the cron container. |
| Re-deriving the register on real PnL changes the ranking | expected; land S1–S4 first, then re-run the register as a follow-up with the corrected input. |
| Removing `sltp_monitor` from sims breaks the dashboard's open list | S6 keeps the mirror, closed by the sim; verify `loadOpenPaperPositions` still returns rows before shipping. |
| A live price is occasionally unavailable for a microcap | S4 makes it `stale`, which is visible and counted — not a silent hold. |

## Verification gate

1. **The gap closes.** Re-run the retention-bounded comparison after S1–S4 and require the recorded-vs-real
   gap on `max_age` to fall from **+64.6pp** to within a few points, and `stop_loss` to stay near its current
   4.1pp (i.e. the fix must not make the honest cohort worse).
2. **The win rate is reported on both bases** in every strategy view until they converge — a `pnl_pct` that
   has not been price-validated must be labelled as such.
3. **Backstop share falls** from the current `max_age` share of closes toward `EXIT_BACKSTOP_ALERT_PCT`.
4. **Coverage test green** (S7): every sim-track's open path reaches S2, asserted, not documented.
5. `tsc` · full `vitest` · `eslint` · build · the shrink-wrap deploy chain · a live smoke on the paper
   dashboard.

## Open items

1. **The `basis` decision for the mcap family** — its TP is mcap-targeted (`cl_take_profit_pct` ~280) while
   its SL is price-targeted (`cl_stop_loss_pct` ~−32). Those disagree in the same tick. S3 forces it into one
   declared place, so it has to be answered rather than inherited.
2. **`initial_price_usd` as an entry source.** This SPEC takes entry *and* exit from the bar series to avoid a
   second suspect input; whether `initial_price_usd` agrees with the entry bar should be measured, because the
   strategies' own PnL uses it.
3. **The three TP variants share an exit input.** Post-S1 they will still share an entry, so they remain one
   economic bet at three exit settings — the register's "count uncorrelated bets" point (P8) still stands.
