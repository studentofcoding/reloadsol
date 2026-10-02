# SPEC — The exit standard: one live valuation, one decision, every strategy

**Status:** **Implemented for S8/S9/S10** (the mechanism); S1–S7 (the valuation/decision rules) remain
the to-spec recommendation. S8/S9/S10 shipped in the exit-standard work: `db/init/57-sl-tp-exit-contract.sql`
adds the contract columns, `registerSimExitContract` is the single registration path for all five spine
callers, the per-family closers were deleted (the mcap route's manage phase is gone, not disabled), and the
60s `sltp_monitor` worker owns every exit. See `CHANGELOG.md [Unreleased]` — "one exit evaluator, one
exit worker, and one entry price".

**Status corrected 2026-10-02 against live production** — three claims in this file no longer matched the
data, and the register in §8 replaces them:

| This file said | Production says |
|---|---|
| "8 of 9 now register at open" | **4 of 9 stamp a complete contract.** 3 register partially (`search_mcap_*`: 538 rows, **28 contracted = 5%**), and **2 have no rows at all** — `att_rh`, which is the **most active strategy by outcomes (417 in 7d)**, and `social_only_fomo_gt7` |
| Gate 4: coverage is "3 of 9" | 6 of 9 have *any* row; **4 of 9 are contracted**; the gate remains 9 of 9 |
| Gate 5: "the worker has never fired a TP" (`SL: 211, TP1: 0`) | **TP1 now fires** — lifetime closes are **398 SL / 22 TP1**. TP2/TP3 remain **0**, and that is correct: see §8 G-f |

**Date:** 2026-10-01 (status updated 2026-10-02)
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

### What it does to the register (re-derived on price-validated PnL)

Re-run per strategy on the same retention-bounded input — recorded and real on **identical** rows,
one consistent snapshot (2026-10-02). `avg win` / `avg loss` are the payoff legs, so the EV below
can be checked arithmetically rather than taken on trust:

| strategy | n | rec avg | **real avg** | **real win** | **real median** | avg win | avg loss |
|---|---|---|---|---|---|---|---|
| `search_mcap…tp300` | 159 | +106.7 | **+29.9** | 27.7 | **−70.0** | +305 | −75 |
| `search_mcap…tp200` | 168 | +83.3 | **+23.5** | 28.6 | **−59.2** | +260 | −71 |
| **`mcap_enter_at_80`** | 99 | +7.8 | **+18.7** | **32.3** | **−12.9** | +149 | −43 |
| `mcap_enter_first_seen` | 61 | +72.9 | **+11.1** | 27.9 | −65.4 | +226 | −72 |
| `search_mcap…tp150` | 185 | +90.5 | **+9.9** | 27.0 | −67.4 | +232 | −72 |
| `gmgn_kol_momentum` | 19 | −32.5 | **+0.8** | 26.3 | −19.1 | +134 | −47 |
| `social_only_fomo_gt7` | 9 | −31.3 | −28.0 | 22.2 | −38.0 | +65 | −54 |
| `gmgn_sm_kol_combined` | 23 | −53.4 | **−50.8** | 4.3 | −61.8 | +103 | −58 |

**The profile is a lottery ticket, and the payoff legs say so.** `tp300` wins 27.7 % of the time and
its median trade loses **70 %**, yet it returns **+29.9 %** on average because the wins are ~4× the
losses (305 vs 75). `0.277 × 305 − 0.723 × 75 = +30.3` — the mean is fully explained by the payoff
ratio, not by any claim of predictive skill. A strategy you judge on win rate looks broken here; one
you judge on `R` looks deliberate.

**The register's load-bearing claim is falsified by this.** It argued "read the median, never the mean — the
mcap family is the only one with a positive median, so it is real." Price-validated, **every one of them has a
deeply negative median** (−66 to −75 for the TP trio). The positive medians were the stale valuation. Win
rates fall **55–58% → 25–27%**.

So the family's +16.8 to +27.8 average is **entirely right tail** — a typical trade loses ~70%. The tail is
real (`take_profit_200` = +277.9% real on 161 trades), so this is genuine positive-EV-by-tail, not a phantom.
But the median argument was never true, and it strengthens rather than weakens the payoff-ratio case (P4).

**`mcap_enter_at_80` is the most robust strategy on the book**, on three independent measures: best
real median (**−12.9** against −59…−70 for the TP trio), best win rate (**32.3 %**), and the
shallowest average loss (**−43** vs −71…−75). The register listed it as marginal because its
*recorded* average was the family's lowest (+7.8) — the stale valuation penalised the strategy whose
exits were honest.

The ranking also inverts inside the family: recorded puts `tp150` second (+90.5) and real puts it
fifth (+9.9) — an **80 pp overstatement** on one strategy. `gmgn_kol_momentum` is **+0.8 real**, i.e.
flat rather than the −32.5 it records. And the gap to the "losers" narrows from ~133 pp of recorded
average to ~49 pp.

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
**`TP1: 0, TP2: 0, TP3: 0` across 211 finishes**.

**The take-profit had never fired — and the cause was a dead branch, not the basis.** `checkSLTPTriggers`
(`sl-tp-tracker.ts:588`) sends `position_type === 'bot'` rows down a path that reads **only**
`tp1_percentage` / `tp2_percentage` / `tp3_percentage` (`:605`). `take_profit_percentage` is read **only** in
the `manual` branch (`:644`), which a `bot` row can never reach. And `registerSimulatedSlTp`
(`mcap-tracking/sim-track/route.ts:179`) registers **`positionType: 'bot'` with no TP ladder at all** — no
`tp1Percentage`, no `tp2Percentage`, no `tp3Percentage`. So `take_profit_percentage = 200` is a field the
worker **never evaluates**: `tp1_percentage` is NULL, the guard is falsy, and the whole TP block is skipped.

The basis is *not* the cause here, and the registration says so deliberately:

> *"The price basis is the REAL market price at entry (`priceUsd`), not the sim's mcap, because the tracker
> refreshes `current_price` from the market — mixing the two would break the ratios."*
> — `mcap-tracking/sim-track/route.ts:171-173`

That is a correct choice, reached as a **workaround** for the fact that `sl_tp_positions` cannot express an
mcap target (G2). The row is coherently price-based. What it cannot do is fire a target the code never reads.

## The standard (the contract)

Every strategy, paper or live, satisfies all ten. Nothing else evaluates an exit.

| # | Rule |
|---|---|
| **S1** | **One valuation.** An exit is evaluated against a **live** reference value — `getOpenPositionPrices()` (batched, GMGN → Jupiter/DexScreener) for a `price` basis, the tracker's mcap for an `mcap` basis — and the recorded PnL is computed from that value against the **reference value stamped at open** (S8). **No cache is ever used as a price, and no runtime path is added to get one: the batched price call already exists.** |
| **S2** | **One decision.** A single `evaluateExit(position, { priceUsd, mcap }, now)` is the only exit evaluator. It returns `{ close, reason, pnlPct, basisUsed }` — reason from a closed set (`stop_loss`, `take_profit`, `max_hold`, `max_age`, `label_rugged`, `hold`, `stale`). |
| **S3** | **Basis is explicit data, not the route.** Each strategy declares what its SL/TP are *expressed in* — `price` or `mcap`. The evaluator branches on that field, never on which route called it. (Today: `getMcapSimCloseReason` is mcap-based, `shouldClosePriceSimPosition` is price-based, and which one runs depends on the sim-track.) |
| **S4** | **Triggers read live, never cached.** A threshold is compared against the S1 value. A staleness older than `EXIT_MAX_INPUT_AGE_SEC` yields `reason: 'stale'` — never a silent `hold`, and never a valuation from the stale value. Fail-closed on risk. |
| **S5** | **Backstops are backstops.** `max_age` / `max_hold` are last resorts. Their **count is a health metric** with a threshold that alerts, because it measures how often the primary exit failed to fire. Last resort means ~0, not 9% of closes. |
| **S6** | **One writer per row — the worker.** `sltp_monitor` evaluates and closes **every** row, paper and live (superseding the earlier "skips `is_simulation`" form of this rule, which S9 replaced). A paper row is still *written* by the strategy at open — that is what registers it — but it is *closed* by exactly one writer: the worker, through the sim executor. No other code path may close or finish a row. |
| **S7** | **Coverage is asserted.** A registry (or a test enumerating the sim-track routes) asserts that every strategy's open path reaches S2. The whole point of this SPEC is that "reaches one consumer" must be impossible to ship again. |
| **S8** | **Every open carries its own exit contract.** At the moment a position opens it stamps the three things the exit needs, so no later step ever guesses or looks one up: **(a) the reference value** the thresholds are measured against, **(b) the basis** (`price` \| `mcap`) that reference value is in, **(c) the thresholds** (SL, TP, and the backstop) as they apply to *this* trade — the effective ones, not the strategy default. A position without a complete contract is uncloseable by policy, and the open fails loudly rather than producing one. |
| **S9** | **One worker owns every exit.** `sltp_monitor` evaluates and executes for **all** strategies, paper and live, reading each position's S8 contract. It runs on its own clock (cheap, batched, bounded by open positions), decoupled from the 900s entry scans. |
| **S10** | **The reference value is the price actually paid.** A position's `entry_price` is the **impact-included fill price** — `computeBuyFill().effectivePrice` = `spotPrice × (1 + impact + spread)` — not the market quote. A stop measured from a price the trade never paid is wrong from the first tick. **The helper already exists** (`execution-model.ts:162`, `resolveSimFill` at `sim-fill.ts:211`) and is currently exercised **only at close**, inside the shadow execution record (`sim-fill.ts:276`, `:335`). This rule is wiring, not new modelling. |

### The executor: the SL/TP worker owns every exit

Strategies decide **entries** and declare their exit contract (S8). The worker decides and performs every
**exit** (S9). One decision function, two executors — and the executors differ only in what they write:

```
// sl-tp-tracker.ts — the worker, per open position
const { referenceValue, basis, sl, tp, backstop } = position   // S8, stamped at open
const live = readLive(referenceValue.kind)                     // price series | tracker mcap, always live
const decision = evaluateExit({ referenceValue, live, basis, sl, tp, backstop, now })
if (!decision.close) return

if (isSimulatedPosition(position)) recordSimClose(decision)    // paper: records + closes the mirror
else                              executeSellOrder(decision)   // live: real swap — unchanged
```

**Why the worker is the right executor, and not a new one:**

- It **already exists and already works** — 211 real stop-loss closes, and the stored stop is correct
  (`0.0000030520 / 0.0000043600 = 0.69999` → a real −30%).
- It **already holds each position's thresholds** — `stop_loss_percentage`, `take_profit_percentage`,
  `tp1/2/3_*`, `position_type`, `strategy_id`, `is_simulation` are all columns on `sl_tp_positions` today.
- It **already reads prices in one batched call** (`getOpenPositionPrices`), so it is cheap — bounded by open
  positions, not candidates, and free of the GMGN discovery traffic that forced the entry scans to 900s.
- It **already runs at 60s** (`SLTP_MONITOR_INTERVAL`), which is the right clock for an exit and is already
  decoupled from the entry scan.

**The five gaps it must close, each a specific change:**

| # | Gap | Change |
|---|---|---|
| G1 | It **cannot close a paper position.** The paper branch already exists and is reached (`monitorSLTPPositions:1256` → `markSimulatedPositionClosed`), but that function writes **only** `sl_tp_positions` — *"Deliberately DB-only: no chain, no wallet"* (`:766`). It retires the mirror row and writes nothing to `strategy_outcomes` / `trading_records` | the paper branch must **write the outcome**, not just flip the row: add `recordSimClose()`, which calls the sim's existing close writer (extracted, not duplicated) and finishes the mirror. **Structurally isolated** — `isSimulatedPosition` and `executeSellOrder`'s hardcoded `isSimulated: false` stay untouched, with the separation's own test. **Status: done.** The closer was not written fresh — `close-strategy-sim-position.ts` already did this exact job for strategy *deactivation* (sell record with `close_position: true` + domain outcome), so it was parameterized by `closeReason` and `sellPriceUsd` and is now reached from the worker via `closeSimulatedPositionFromWorker` (`src/utils/sl-tp-sim-close.ts`). The mirror is retired **only when the close succeeded**, so a failed close stays open and retries |
| G2 | `stop_loss_percentage` is a **bare number with no unit** — the row cannot say whether it means a price or mcap growth | S8's `basis` on the row, so the unit is *data* rather than a convention every caller must honour. (The mcap family already navigates this by registering a price-derived value — `sim-track/route.ts:171-173` — which is a workaround, not a declaration.) |
| **G2b** | **The take-profit is never evaluated at all.** `bot` rows read only `tp1/2/3_percentage` (`:605`); `take_profit_percentage` is read only by the `manual` branch (`:644`) — and the sim registers `bot` **with no ladder** (`sim-track/route.ts:205`). Hence **`Finished: 211 (SL: 211, TP1: 0, TP2: 0, TP3: 0)`** | a `bot` row with no `tpN` ladder **falls back to `take_profit_percentage`** — a bot with one target behaves like one target. Pinned by gate 5 |
| G3 | **Six strategies have no rows at all** — `mcap_enter_at_80`, `mcap_enter_first_seen`, `att_rh`, both gmgn, social. **And the chain must become per-row first:** `getCurrentTokenPrices` hardcodes `'sol'` (`:571`, *"sl_tp_positions is Solana live-only"*), so `att_rh` would be priced through the Solana path and evaluated against a wrong number | every open path registers (S7 asserts it); the chain is read off the row before `att_rh` is registered. Today registration correlates with a *dashboard* feature, not risk — the three that register have the **worst** real median (−66 to −75), and the most robust (`mcap_enter_at_80`, −14.3) has none. **Status: 8 of 9 now register at open**, through the one shared `registerSimExitContract`; the chain-aware pricing landed (`getCurrentTokenPrices` now groups by the row's `chain`). **`att_rh` is the remaining gap and is deliberate** — it resolves no `effective_exit` at open, so it has no thresholds to stamp, and registering it with the strategy's *base* exit would re-introduce the value S8 exists to remove |
| G4 | The mcap closer reads a **cached** `mcap_growth_percent` (stale 18–481 min) | S1/S4: live value, and `stale` rather than a hold when it cannot be read |

**The one hard risk, stated plainly.** The worker is the **live** path, and this adds a branch that writes a
paper close one step away from one that spends real money. `isSimulatedPosition` and
`executeSellOrder`'s hardcoded `isSimulated: false` (`sl-tp-tracker.ts:424-434`) stay exactly as they are,
the sim executor is a separate function, and the separation carries its own test. That invariant is why a
paper stop has never spent real money; nothing here weakens it.

### What S8 changes at the call site

Every strategy's open becomes: work out the exit, then hand it over.

```
entryPrice = …                      // the price we just bought at
basis      = exitConfig.basis       // 'price' | 'mcap', declared per strategy (S3)
reference  = basis === 'mcap' ? { kind: 'mcap',  value: entryMcap } : { kind: 'price', value: entryPrice }
thresholds = effectiveExit          // cl / brain adjusted for THIS trade, not the strategy default

addSLTPPosition({ …position, referenceValue: reference, basis, thresholds })
```

Two consequences worth naming:

- **The reference value is stamped, never re-derived.** Today the mcap family's entry mcap comes from the
  tracker row at read time; if that row was already stale at open, the *whole trade's* exit math is off from
  the first tick. Stamping it at open makes the contract self-contained — and a wrong reference becomes a bug
  you can see in the row rather than one that surfaces 6 hours later as a phantom +21%.
- **The thresholds are the *effective* ones.** `cl` and the brain adjust SL/TP per trade; the worker must
  receive what the trade was actually sized and entered against. Using the strategy's *base* exit would
  re-introduce a value the trade was never opened under — and with the mcap family's real median at −70%,
  that difference is the whole result.

## Migration, by family

| family | today | after (S8 contract + S9 worker) |
|---|---|---|
| `search_mcap_*` (3) | registers; closer is `getMcapSimCloseReason` on the **cached** growth; also second-guessed by `sltp_monitor` | opens stamp `basis: 'mcap'`; the worker evaluates live and closes |
| `mcap_enter_at_80`, `mcap_enter_first_seen` | **no rows at all** — same domain as the three above, no exit registration | register at open like the rest; the worker closes |
| `signals_*` | `shouldCloseSignalsClExit` (mcap-preferred, price fallback); no rows (none open in 3d) | `basis` declared once; register at open; the worker closes |
| `gmgn_*`, `social_*` | `shouldClosePriceSimPosition`; **no rows** | `basis: 'price'`; register at open; the worker closes |
| `att_rh` | the RH sim's own `buySim`/exit ladder; `addSLTPPosition` gated `!is_simulated` | register like everything else; the worker closes |
| live | `runSLTPMonitorAndSummarize` + `executeSellOrder` | **same worker, same executor** — only its decision becomes the shared `evaluateExit`. No new live path. |

## Env

| Key | Default | Meaning |
|---|---|---|
| `EXIT_MAX_INPUT_AGE_SEC` | `180` | Older than this and the decision is `stale`, never a hold-from-cache. |
| `SLTP_MONITOR_INTERVAL` | `60` | The exit clock — **one worker, one interval.** (Supersedes the draft `EXIT_CHECK_INTERVAL`; two clocks for one worker is the same drift this SPEC removes.) Already set to 60 on prod; cheap, batched, bounded by open positions, no GMGN discovery — so it is not subject to the entry scan's 900s budget. |
| `EXIT_BACKSTOP_ALERT_PCT` | `10` | Alert when backstop closes exceed this share of closes in a window. |
| `EXIT_BASIS_<strategy>` | per strategy | `price` \| `mcap`. Declared, not inferred from the route. |

## Non-goals

- **Not** a change to any stop or take-profit **level**. The mechanism is the confounder; move one at a time.
- **Not** a change to the entry scan cadence. That stays at 900s for the GMGN budget — the whole point of S1's
  price source and the worker's own 60s clock is that the exit is cheap enough not to need the entry scan's.
- **Not** a change to *what* live execution does. The worker already owns live closes and keeps
  `executeSellOrder`; step 5 only swaps its decision function for the shared one, after the paper path soaks.
- **Not** a re-derivation of the strategy register. That is the *first consumer* of this SPEC, not part of it.
- **Not** the volume band or the rug detector; those are separate blockers.

## Risks

| Risk | Mitigation |
|---|---|
| A live valuation *raises* losses (the recorded numbers get worse, not better) | that is the point — the record currently overstates by 60pp on the phantom cohort. Report both bases during the transition so the change is visible, not silent. |
| The worker at 60s over ~150 paper rows adds DB load | bounded by open positions, one batched price read, no discovery. Measure before/after on the cron container; it already runs at 60s today. |
| Re-deriving the register on real PnL changes the ranking | expected; land S1–S4 first, then re-run the register as a follow-up with the corrected input. |
| **The worker is the live path.** Adding a sim executor puts a paper write one branch away from a real swap | `recordSimClose` is a **separate function**; `isSimulatedPosition` and `executeSellOrder`'s hardcoded `isSimulated: false` are untouched; the separation carries its own test (gate 6) |
| A schema change to `sl_tp_positions` on the live table | the S8 contract is **additive and nullable**; existing rows and the live stop path are unaffected until an open stamps one |
| Pointing the live decision at `evaluateExit` changes live behaviour | that is step 5 alone, after the paper path has soaked, with the invariant test green throughout |
| The worker now closes ~150 paper rows it previously only recorded — a behaviour change to every arm of the paper desk | expected, and the point. Report both bases during the transition so the shift is visible, not silent. |
| A live price is occasionally unavailable for a microcap | S4 makes it `stale`, which is visible and counted — not a silent hold. |

## Verification gate

1. **The gap closes.** Re-run the retention-bounded comparison after S1–S4 and require the recorded-vs-real
   gap on `max_age` to fall from **+64.6pp** to within a few points, and `stop_loss` to stay near its current
   4.1pp (i.e. the fix must not make the honest cohort worse).
2. **The win rate is reported on both bases** in every strategy view until they converge — a `pnl_pct` that
   has not been price-validated must be labelled as such.
3. **Backstop share falls** from the current `max_age` share of closes toward `EXIT_BACKSTOP_ALERT_PCT`.
4. **Coverage test green** (S7): every sim-track's open path reaches S2, asserted, not documented. Today the
   answer is **3 of 9** — `mcap_enter_at_80`, `mcap_enter_first_seen`, `att_rh`, both gmgn and social have
   zero `sl_tp_positions` rows. The gate is 9 of 9.
5. **The worker's take-profit fires.** It has never done so: `Finished: 211 (SL: 211, TP1: 0, TP2: 0, TP3: 0)`.
   The discriminator is **G2b**: a `bot` row with no `tpN` ladder must fall back to `take_profit_percentage` and
   close as `take_profit`. If TP is still 0 after that lands, the fallback is not being reached — the *basis*
   is a red herring here and must not be blamed again.
6. **The isolation test.** A test asserts a paper position cannot reach `executeSellOrder` — the one property
   that has kept a paper stop from spending real money. It must fail loudly if the branch is ever crossed.
7. `tsc` · full `vitest` · `eslint` · build · the shrink-wrap deploy chain · a live smoke on the paper
   dashboard.

## Open items

1. **The `basis` decision for the mcap family** — still open, but now better posed. The family's own sim
   **already declares `price`** and documents why (`sim-track/route.ts:171-173`), so the question is not
   "which basis?" but whether that workaround *becomes* the declaration (S8 stamps `basis: 'price'` and the
   mcap target is converted at open) or the row gains a genuine `mcap` basis and the tracker supplies the
   mcap. The two thresholds disagree in one tick (`cl_take_profit_pct` ~280 mcap vs `cl_stop_loss_pct` ~−32
   price), so S3 forces one answer rather than leaving each route to pick.
2. **`initial_price_usd` as an entry source.** This SPEC takes entry *and* exit from the bar series to avoid a
   second suspect input; whether `initial_price_usd` agrees with the entry bar should be measured, because the
   strategies' own PnL uses it.
3. **The three TP variants share an exit input.** Post-S1 they will still share an entry, so they remain one
   economic bet at three exit settings — the register's "count uncorrelated bets" point (P8) still stands.

## 8. Coverage register

Every property this system must hold, each with its state **as measured on production 2026-10-02**, the
concrete handling, and the test that pins it. Reading: **in** = implemented and verified live · **partial** ·
**open** = not implemented.

### 8.0a What has shipped since the baseline

`2e96be7` closes C2, C3, D2, D3, F1, F2, F3 and G-h, and asserts E2. Specifically:

- `db/init/58-sl-tp-close-reason.sql` adds `sl_tp_positions.close_reason` + `closed_at` and
  `cron_worker_runtime.last_skipped_at` — additive and nullable, the same shape as 57.
- Every close writer now stamps a reason, and `max_age` has its own trigger instead of collapsing into
  `max_hold_time`. That is what makes a backstop distinguishable from a stop-loss at last.
- `markSimulatedPositionClosed` no longer sets `tp1_executed = true` on a non-stop trigger. That single
  line was why a backstop was filed as take-profit.
- A skipped pass is persisted rather than rejected with a 400, and the route runs a job-lock heartbeat,
  so a pass outliving the Go client's 120s timeout can no longer lose its lock and let a second pass
  start over the same positions.
- `getSLTPTrackingSummary` reports `by_reason` and takes an explicit window.

Still open: **A1/A5** (legacy rows, fail loudly — P3) · **B1–B5** (the live valuation and `stale` —
P4) · **C4**, **D1**, **D6**, **E1**, **E3** · **G-a**–**G-g**.

**P3 done (2026-10-02).** `backfill-exit-contracts-standalone.mjs` (dry-run by default, `--apply`,
a before-image of every touched row) stamped the contract onto **all 510 legacy rows** —
`reference_kind='price'`, `reference_value=entry_price`, `exit_basis='price'`. All 510 were
derivable, so nothing was invented and nothing was NULLed. Applied on prod: `uncontracted` went
**510 → 0**, and a re-run selects **0 rows**, which is the idempotency check. The 510 were entirely
the three `search_mcap_*` families (183 + 164 + 163), which is the confirmation that these were old
rows rather than a missing registration. `registerSimExitContract`'s refusal is now counted
(`simExitRegistrationFailureCount`) and logs the strategy + mint, so an open that stops registering
is measurable rather than merely a line in a log.

### 8.0 The measured baseline

Counting the contract columns (`reference_kind`, `reference_value`, `exit_basis`) that S8 adds:

| stratum | rows | contracted | |
|---|---|---|---|
| Active positions | 162 | **13** | **92% carry no contract** |
| Lifetime rows | 582 | 72 | 12% |
| `exit_basis` values ever written | — | `price` only | **`mcap` has never been written, 0 rows** |
| Closed rows | 420 | — | 398 `sl_executed`, 22 `tp1_executed`, **0 tp2/tp3, 0 with no flag** |

Per strategy — this is the table that replaces "8 of 9":

| strategy | outcomes 7d | sl_tp rows | contracted | |
|---|---|---|---|---|
| `att_rh` | **417** | **0** | 0 | most active strategy; no rows at all |
| `search_mcap_first_seen_sl_30_tp200_h48` | 347 | 169 | 5 | |
| `search_mcap_first_seen_sl_30_tp150_h48` | 339 | 205 | 22 | |
| `search_mcap_first_seen_sl_30_tp300_h48` | 317 | 164 | 1 | |
| `mcap_enter_at_80` | 170 | 27 | **27** | complete |
| `mcap_enter_first_seen` | 108 | 10 | **10** | complete |
| `gmgn_sm_kol_combined` | 60 | 2 | **2** | complete |
| `gmgn_kol_momentum` | 49 | 4 | **4** | complete |
| `social_only_fomo_gt7` | 27 | **0** | 0 | no rows |

The contracting that works is on the **smallest** families; the largest and most active are the ones missing
it. Where a contract *is* stamped it is correct — per-trade values (−10.44%, −31.33%, +14.33%, +286.64%),
so the cl/brain adjustment does reach the row.

**Why the big family is uncontracted — a correction to an earlier reading of this table.** It is not a
missing call site. `registerSimExitContract` stamps `reference_kind` / `reference_value` / `exit_basis` on
*every* call, and `mcap-tracking/sim-track/route.ts:401` is one of its four call sites. The uncontracted
rows are **legacy rows opened before migration 57**, so the fix is a disposition for old rows (P3), not a
change to the mcap path. `att_rh` is the one genuine absence: it resolves no `effective_exit` at open, so
it has no thresholds to stamp, and `simCloseDomainForStrategy('att_rh')` returns `null` by design — a fact
the routing test already asserts.

### A. The contract — what an open must stamp (S8)

| # | Must hold | State | Handling | Test |
|---|---|---|---|---|
| **A1** | `reference_value` stamped at open | **partial** | 13/162 active | a row missing it is rejected |
| **A2** | `reference_kind` ∈ {`price`,`mcap`} | **partial** | CHECK constraint exists | constraint test |
| **A3** | `exit_basis` matches `reference_kind` | **partial** | both NULL or both set in all 72 | assert they agree |
| **A4** | thresholds are the **effective** (cl/brain) ones, not the strategy base | **in** | verified in the 72 | a base-equal value fails the test |
| **A5** | an open that cannot build a contract **fails loudly** | **open** | today it inserts NULL — this is why 149 phantom rows exist | open-without-thresholds throws |

### B. The valuation — what an exit is measured against (S1, S4, S10)

| # | Must hold | State | Handling | Test |
|---|---|---|---|---|
| **B1** | live read, **never** a cache | **in** | G4: cached `mcap_growth_percent`, stale 18–481 min | a cached value can never be returned |
| **B2** | staleness → `stale`, never a silent `hold` | **in** | `EXIT_MAX_INPUT_AGE_SEC=180` exists but is **not enforced** | stale input ⇒ `reason:'stale'` |
| **B3** | entry reference = the **impact-included fill** (S10) | **open** | helper exists (`execution-model.ts:162`), runs **only at close** | `reference_value == computeBuyFill().effectivePrice` |
| **B4** | `0` / negative / NaN never reaches a comparison | **in** | needs a guard at the evaluator boundary | each bad value ⇒ `hold`, never a close |
| **B5** | for `mcap`, staleness is measured in **mcap time** | **open** | wall-clock is meaningless for a tracker row | an old mcap ⇒ `stale` |

### C. The decision (S2, S3)

| # | Must hold | State | Handling | Test |
|---|---|---|---|---|
| **C1** | one evaluator, closed reason set | **in** | `exit-evaluator.ts` | golden cases per reason |
| **C2** | **the reason is persisted** | **in** | **there is no `close_reason` column** — and `strategy_outcomes.status` only holds `won`/`lost`/`breakeven`, so the reason is nowhere | reason round-trips row → back |
| **C3** | a backstop is distinguishable from a stop-loss | **in** | every close sets `sl_executed` or `tp1_executed`; **0 of 420 rows have no flag**, so `max_age`/`max_hold` are recorded as `sl_executed = true` | `max_age` close ⇒ `sl_executed = false` |
| **C4** | basis is read from the row, not the route | **in** | 4 families yes; `search_mcap_*` NULL | the evaluator never sees a route |

### D. The writer (S6, S9)

| # | Must hold | State | Handling | Test |
|---|---|---|---|---|
| **D1** | one writer owns every exit | **partial** | family closers deleted (`8ae590a`), but `att_rh` — the most active strategy — has no rows and still exits through its own RH ladder | a second closer cannot write |
| **D2** | a **skipped** pass is recorded | **in** | `Worker runtime persist HTTP 400 (sltp_monitor/skipped)` — skips are invisible, so "how often did the sole closer not run" is unanswerable | skip ⇒ persisted, not a 400 |
| **D3** | a **timed-out** pass has defined recovery | **in** | observed 14:55:07; whether rows closed before it died is unrecorded | a killed pass leaves no half-closed row |
| **D4** | a paper row **cannot** reach `executeSellOrder` | **in** | `isSimulatedPosition` + hardcoded `isSimulated:false` | **the isolation test, gate 6** |
| **D5** | a paper close writes the outcome; the mirror retires **only on success** | **in** | `closeSimulatedPositionFromWorker` | failed close stays open and retries |
| **D6** | no row is left half-closed on write failure | **open** | | a thrown write leaves `is_active=true` |

### E. Coverage (S7)

| # | Must hold | State | Handling | Test |
|---|---|---|---|---|
| **E1** | every strategy's open path reaches the evaluator, **asserted** | **open** | 4 of 9 contracted | the registry test — gate 4, target 9 of 9 |
| **E2** | `att_rh`'s absence is **asserted as deliberate** | **in** | it resolves no `effective_exit` at open | a named exception, not a silent hole |
| **E3** | chain is per-row, not hardcoded `sol` | **in** | `getCurrentTokenPrices` groups by the row's `chain` | a `robinhood` row is not priced on Solana |

### F. Observability

| # | Must hold | State | Handling | Test |
|---|---|---|---|---|
| **F1** | backstop share is computable | **in** | blocked by C3 | the metric returns a number |
| **F2** | `stale` is counted | **in** | blocked by C2 | |
| **F3** | skipped passes are counted | **in** | blocked by D2 | |
| **F4** | `EXIT_BACKSTOP_ALERT_PCT` (10) alerts | **open** | env documented, no alert wired | crossing it fires |
| **F5** | both bases reported until they converge | **open** | gate 2 | an unvalidated `pnl_pct` is labelled |

### G. Edge cases

| # | Case | State | Handling | Test |
|---|---|---|---|---|
| **G-a** | a pass **severed by a web recreate** (the EOF burst) | **open** | every deploy is a window with no exits — and it is the sole closer | a killed pass is recoverable and counted |
| **G-b** | the worker **down entirely** | **open** | nothing exits; the dashboard shows a stale badge only | an alert, not a badge |
| **G-c** | a position that **can never be priced** | **open** | must go `stale`, be counted, and not sit open forever | a permanently unpriceable row is surfaced |
| **G-d** | **legacy uncontracted rows** (149 active, 510 lifetime) | **open** | they need an explicit disposition: backfill, close, or mark uncloseable-by-policy. Today they are open and invisible | the disposition is asserted |
| **G-e** | the four categories (real/sim/bot/external) | **partial** | the worker currently sees `Manual: 0, Bot: 162` | the manual path is exercised |
| **G-f** | **partial exits / the TP ladder** | **resolved, but see the caveat** | `tp1_sell_percentage` has **never been < 100** and `active_after_tp1 = 0`, so **TP1 always closes in full and TP2/TP3 are unreachable by construction**. The 0s are therefore *correct*, not a bug — but a 3-tier ladder that only ever uses tier 1 is indistinguishable from a single TP. **Decide: wire the ladder or drop the columns** | a partial TP leaves the row active; a full TP does not |
| **G-g** | `label_rugged` path | **in** | reason in the closed set | a rugged label closes |
| **G-h** | two backstops, `max_age` **and** `max_hold` | **in** | neither persisted (C3) | each is distinguishable |

### 8.9 Build order

1. **C2 + C3** — persist the close reason. Additive and nullable, the same shape as the S8 migration, so it
   cannot break the live stop path. Nothing else is measurable until a backstop stops masquerading as a
   stop-loss; it also unblocks S5, F1 and G-h.
2. **A5 + A1** — fail loudly on an incomplete contract, then contract `search_mcap_*` (538 rows, 5%). Also
   give the 149 legacy rows an explicit disposition (G-d).
3. **D1 + D2 + D3** — `att_rh` (the most active strategy) has no rows, and pass skips/recovery are unrecorded
   — which matters more now that the worker is the **only** closer.
4. **B1 + B2** — the live valuation and `stale`, where the recorded-vs-real gap actually lives.
5. **G-f** — decide the ladder: wire it or delete it.

