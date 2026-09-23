# SPEC — Signals strategy-list expand v1

**Status:** to-spec (docs only)
**Date:** 2026-09-23
**Surface:** `reloadsol` `/dev/signals?tab=signals` (`SignalsTab`); `GET /api/trading/signals`
**Lane:** autotrade & algo
**Depends on:** signals scoring templates (`default` / `sell_over_100`); mcap entry templates (`first_seen` / `milestone_80`); `strategy_outcomes` aggregates already produced by `aggregateStrategyReports`; floating-chart Buy + `RowTradePanel` shipped in #65

**Provenance:** operator lock (2026-09-23). Implement from this document. Do not reopen the five locks unless production data contradicts one after ship.

This PR is documentation only. No UI or TS product code. One implementation PR follows this SPEC.

---

## Implementer checklist (build first)

Do this order. Do **not** start by moving the list to Algo Tester, redesigning Buy/Sell, flipping soft-active, or calling `qualifyBestStrategies`.

1. **Keep the list on `/dev/signals?tab=signals`.** Expand the Strategy `<select>` in place. Do not add a jump to `/dev/algo-tester`.
2. **Rank that picker** with raw unfloored `avg_pnl_pct` / `total_pnl_pct` from `strategy_outcomes` (§5). Do not apply min-n floors 30/10. Do not use `avg × n + win%`.
3. **Change membership** so the JSON `signals` array is one row per mint that matches the selected strategy, with `alsoMatches` for the others (§6). Do not read `strategy_outcomes` to decide which mints appear.
4. **Leave trade and Early Enter gates alone.** Floating-chart Buy stays `rowMarketSwap`. List Buy/Sell stays `RowTradePanel`. Do not consult the soft gate or Noul for this list.

---

## 1. Goal

Operators pick a strategy on the Signals tab and see that strategy's current mints.

1. The picker stays on `/dev/signals?tab=signals` and grows from two hardcoded templates to the chain's signals + mcap entry strategies, **ordered by raw closed PnL**.
2. The table shows **one row per mint** for the strategy that is selected. A mint that also matches another strategy in the same picker gets a **badge with that strategy's name**. It does not get a second row.
3. "Highest PnL" / best-strategy **ordering of the picker** uses the same unfloored sum and average `strategy_outcomes` already stores. Min-n floors stay off for this picker. Tiny samples can outrank large ones. That bias is accepted and shown (§5.3).

### 1.1 Non-goals (out of scope)

- Remora, Privy, or any new 1-click wallet path.
- A Trade rail, or any redesign of floating-chart Buy or list-row Buy/Sell.
- Turning Early Enter soft-active or Noul **on**, or consulting either gate when building this list.
- Making `/dev/algo-tester` the list home, or merging this list into Algo Tester. Algo Tester stays the performance desk for all six domains.
- Min-n floors (all-time 30 / 7-day 10) on this picker, including reuse of `qualifyBestStrategies`.
- Changing the Researchy / Telegram best-strategies board. That board keeps its floors and `avg × n + win%` score.
- EVM OHLC, VPS deploy, schema migrations, or new outcome writers.
- Changing how sim-open, sim-track, or Early Enter **emit** decides paper or toasts. This SPEC filters the Signals **list response** only.
- Board tab (`/dev/signals?tab=board`) strategy template. It keeps `default` | `sell_over_100`.
- Tracker (`?tab=tracker`) as a second strategy list.

---

## 2. Locked decisions (do not reopen)

1. **List home:** Strategy picker stays on `/dev/signals?tab=signals` (already has Default / Sell Over 100%). Not Algo Tester jump.
2. **Unique mint:** One row per mint for the *selected* strategy. If that mint also matches another strategy, show a **badge** naming the other strategy — do **not** duplicate rows.
3. **Highest PnL ranking / “best strategy” ordering:** Use **raw unfloored** aggregates from `strategy_outcomes` (sum/avg as the product already uses). Architype rejected min-n floors (30/10). Tiny-n risk is accepted; document it explicitly in the SPEC as known bias.
4. **Trade UX:** Floating-chart Buy already shipped in #65 — toolbar Buy Amount (SOL) → one Jupiter Wallet Kit confirm via `rowMarketSwap` / `runTrackerMarketSwap`. List-row Buy/Sell still use `RowTradePanel`. Do not redesign trade.
5. **Soft-active / Noul:** Stay OFF. Do not consult Early Enter soft-gate for this list.

Standing: `EARLY_ENTER_NOUL_SOFT_ACTIVE` stays default off. `qualifyBestStrategies` / `RESEARCHY_MIN_N_ALL_TIME` (30) / `RESEARCHY_MIN_N_7D` (10) stay the rule for the best-strategies board only. They are the wrong function for this picker.

---

## 3. As-built (verified on `main` at #65, 2026-09-23)

### 3.1 List home and picker

`SignalsHub` mounts `SignalsTab` when `?tab=signals` (default tab when `tab` is omitted).

`SignalsTab` holds:

```ts
const [strategy, setStrategy] = useState<"default" | "sell_over_100">(
  readSignalsStrategyTemplate,
);
```

The `<select>` options are hardcoded, in this order, not by PnL:

| value | label |
|---|---|
| `default` | Default |
| `sell_over_100` | Sell Over 100% |

Persistence is `localStorage` key `signals_active_strategy` via `readSignalsStrategyTemplate` / `writeSignalsStrategyTemplate` (`src/utils/signals-strategy-id.ts`). Unknown values read back as `sell_over_100`. Server render (no `window`) also returns `sell_over_100`. The value is passed to `useTradingSignals({ strategy, ... })`.

`useTradingSignals` sends `strategy` as that template string on `GET /api/trading/signals` with `limit`, `recencyMinutes`, `minGrowth`, `includeStuck`, `maxAgeMinutes`, `chain`.

Board (`BoardTab`) has its own copy of the two-option template select and uses `useSignalsStrategy()`, which reads the **same** storage key. This SPEC does not expand Board. The Signals picker must use a **new** key so writing a strategy id does not clobber Board (§7.2).

### 3.2 Strategy does not filter the candidate SQL

`GET /api/trading/signals` casts `strategy` to `'default' | 'sell_over_100'` and builds a hardcoded `SignalsStrategyConfig` (`enterScoreFloor: 50`, route scoring weights, query from the request). It does **not** load `strategy_definitions` for that request.

`fetchAndScoreSignals` (`src/strategies/signals-pipeline.ts`) selects `token_mcap_tracking` with the same predicates for both templates:

- growth, `current_mcap`, `first_mcap` present and mcaps `> 0`
- `is_tracking_stuck = false` unless `includeStuck`
- `first_seen_at >= recencyCutoff`
- `last_updated_at >= maxAge cutoff`
- `mcap_growth_percent >= minGrowth`
- `chain = $chain`
- `ORDER BY mcap_growth_percent DESC LIMIT limit * 5`

Then rug-drop validation, manual rug-list filter, sort by score then growth, `slice(0, limit)`.

`token_mcap_tracking.token_address` is the primary key (`db/init/02-schema.sql`). `db/init/24-strategy-chain.sql` adds `chain`. One request is one chain, so the candidate set is already one row per mint. The route still returns every scored decision (`enter`, `hold`, `exit`, `skip`). Template does not drop rows.

### 3.3 What the template actually changes

`computeScoreAndDecision` (`src/strategies/signals-scoring.ts`):

| Template | Extra rule |
|---|---|
| `sell_over_100` and growth `>= 100` | subtract `sellOver100LatePenalty` (40); decision `exit` ("Growth >100%: late-stage — sell/take profit") |
| `sell_over_100` and growth `>= 80` and not already enter/exit | decision `hold` |
| `default` | no late penalty; `enter` when `growth >= minGrowth` and `score >= enterScoreFloor`; else `hold` at the hold floor; else `skip` |

So Default and Sell Over 100% currently show the **same mints**. Only score, decision, and rationale differ. There is no cross-strategy badge.

Robinhood has `signals_default_rh` only. The route comment and early-alert branch already say there is no `sell_over_100` twin. The Signals picker still offers Sell Over 100% on RH; the alert id forces `signals_default_rh`.

### 3.4 Mcap membership today is a paper gate, not this list

`mcap_enter_first_seen` / `mcap_enter_at_80` (and `_rh` twins) live in `MCAP_TRACKER_STRATEGIES`. Entry template is `first_seen` or `milestone_80`. Open/skip is `getMcapSimOpenSkipReason` (`src/utils/mcap-sim-track.ts`): rugged label, organic / holders when configured, recency on `first_seen_at` or on `when_reach_80pct`, mcap band via `isInTrackingRange`, plus paper-only `already_open` and `already_closed`.

Those mcap ids are not picker options. The signals list never calls `getMcapSimOpenSkipReason`.

### 3.5 Where `strategy_outcomes` PnL is aggregated

Table: `strategy_outcomes` (`db/init/02-schema.sql`, chain column in `db/init/24-strategy-chain.sql`). A row is written on **full close**, not while a mint is on the live list (`docs/03-strategies-and-automation.md`).

`aggregateStrategyReports` (`src/strategies/db.ts`) groups deduped rows by `domain|strategy_id|is_simulated` and sets:

| Field | Formula in code |
|---|---|
| `trade_count` | number of rows in the group (null `pnl_pct` still counts) |
| `avg_pnl_pct` | arithmetic mean of finite `pnl_pct`; `0` when none are finite |
| `total_pnl_pct` | sum of those finite `pnl_pct` values |
| `win_rate` | `summarizeClosedPnls` (strictly positive pnl / n; flats are not wins) |

No min-n floor lives in this function. Zero-trade definitions are filled with `trade_count: 0` and `avg_pnl_pct: 0`.

The **floors** live only in `qualifyBestStrategies` (`src/strategies/best-strategies-rank.ts`): rank key `avg_pnl_pct × n + win_pct`, and a strategy is `hypothesis` (not a top slot) unless all-time `n ≥ 30` **or** 7-day `n ≥ 10`. The unit test parks `signals_sell_over_100` at n=6, avg 500% under hypothesis and ranks `mcap_enter_at_80` / `mcap_enter_first_seen` instead. That function stays for the best-strategies board. **This picker must not call it.**

### 3.6 Trade path already on this tab (#65)

Do not rebuild it.

| Control | Path |
|---|---|
| Toolbar **Buy Amount (SOL)** | `buySolOverride ??` 3% of wallet SOL (`buySolAmount`) |
| Floating-chart **Buy** | `handleFloatingChartBuy` → `floatingChartSolBuyLeg` → `rowMarketSwap` |
| `rowMarketSwap` | `export { runTrackerMarketSwap as rowMarketSwap }` in `src/utils/row-market-swap.ts`. One Jupiter Wallet Kit `signTransaction`. |
| List-row **Buy** / **Sell** | `openRowTrade` → `RowTradePanel` (amount / percent slider, still `rowMarketSwap` inside the panel) |
| Robinhood | row Buy opens `ChartBuyModal`; floating Buy is disabled ("Solana wallet only") |

`RowTradePanel` already states Early Enter Noul / soft-active does not gate it. Keep that.

### 3.7 Soft gate and Noul are not list filters

`GET /api/trading/signals` may attach closed-loop scores and emit Early Enter alerts when `isEarlyEnterMlSoftGateEnabled()` or `isEarlyEnterNoulShadowEnabled()`. Emit calls `passesEarlyEnterMlSoftGate`. Noul soft-active is `isEarlyEnterNoulSoftActiveEnabled()` → `EARLY_ENTER_NOUL_SOFT_ACTIVE`, default **false**.

None of that decides which rows the JSON list returns. This SPEC keeps it that way.

### 3.8 Hypothesis — confirmed

> The Signals list is one tracking window. The strategy control only rescores it. Closed PnL can order strategies, but it does not list live mints. Cross-strategy membership is not on the row.

---

## 4. What changes (exact)

| Question | v1 answer |
|---|---|
| Expand picker options? | **Yes.** Fixed universe in §4.1, labels in §7.1. Not every `strategy_id` in the database. Not trending / GMGN / social / DLMM. |
| Rank strategies by raw PnL? | **Yes, picker order only.** §5. Mint rows are not sorted by strategy PnL. |
| Change list membership query? | **Yes, after the existing candidate SQL.** §6. Do not replace the SQL with a `strategy_outcomes` read. |
| Badge data shape? | **`alsoMatches: { strategyId, name }[]`** on each returned signal. §6.4. |

### 4.1 Picker universe (closed set)

Sol (`chain=sol`):

| `strategyId` | Domain | Match rule |
|---|---|---|
| `signals_default` | `signals` | template `default` |
| `signals_sell_over_100` | `signals` | template `sell_over_100` |
| `mcap_enter_first_seen` | `mcap_tracker` | entry template `first_seen` |
| `mcap_enter_at_80` | `mcap_tracker` | entry template `milestone_80` |

Robinhood (`chain=robinhood`):

| `strategyId` | Domain | Match rule |
|---|---|---|
| `signals_default_rh` | `signals` | template `default` |
| `mcap_enter_first_seen_rh` | `mcap_tracker` | entry template `first_seen` |
| `mcap_enter_at_80_rh` | `mcap_tracker` | entry template `milestone_80` |

No `signals_sell_over_100` on Robinhood. Do not invent one.

`is_active` does not remove an id. `search_*` children, trending, GMGN, social, and DLMM ids are not options.

Display names come from the registry / `strategy_definitions.name` already used in product (`Default momentum`, `Sell over 100%`, `Enter at first seen`, `Enter at 80% milestone`, plus the Robinhood names). Do not invent a second name table.

---

## 5. Picker ranking (raw unfloored PnL)

### 5.1 Source

Reuse `aggregateStrategyReports({ chain })` breakdown (deduped `strategy_outcomes`, same mean and sum as §3.5). Do not add a second SQL aggregator.

For each universe id, take the breakdown row with `is_simulated === true` and that `strategy_id`. Ignore live rows. These strategies are `sim_only`; the operator figure for Sell over 100% is sim PnL.

All-time. Do not pass a 7-day `from`. Do not blend week n into the rank.

### 5.2 Order

Picker `<option>` order:

1. Strategies with `trade_count > 0` first. A zero-fill `avg_pnl_pct: 0` at `trade_count === 0` is **not** a sample and must not sort as a real 0% (that would beat a negative average).
2. Among `trade_count > 0`: `avg_pnl_pct` descending, then `total_pnl_pct` descending, then `strategy_id` ascending.
3. Among `trade_count === 0`: `strategy_id` ascending, after every positive-n strategy.

Rank keys are the raw mean and the raw sum. Do **not** multiply by n. Do **not** add win%. Do **not** drop or demote anyone for `n < 30` or 7-day `n < 10`. Do **not** call `qualifyBestStrategies`, `qualifiesResearchyMinN`, or `bestStrategyCompositeScore`.

### 5.3 Known bias (accepted)

Tiny-n risk is accepted.

`avg_pnl_pct` is an unfloored arithmetic mean. A strategy with a huge mean and a small `trade_count` outranks a strategy with a smaller mean and a large `trade_count`. Example the lock is written for: all-time Sell over 100% around **359% avg at n=38** outranks `mcap_enter_first_seen` / `mcap_enter_at_80` when those means are lower, even if their n is larger, and even when `avg × n + win%` plus the 30/10 floors would have ordered or benched them the other way on the best-strategies board.

The same rule lets n=1 (or the ranker's own fixture: Sell over 100% at n=6, avg 500%) take the top picker slot. That is not a bug. Do not "fix" it with a floor in review.

The option label shows the mean **and** n so the operator can see the sample (§7.1). This picker does not change the floored board.

### 5.4 What ranking does not do

- It does not change which mint is selected on first visit. Empty storage still resolves to today's default: `signals_sell_over_100` on sol, `signals_default_rh` on Robinhood (§7.2). Highest avg is the **order of options**, not an auto-switch of the operator's current pick.
- It does not sort table rows. Row order stays §6.5.
- It does not rewrite `strategy_outcomes`.

---

## 6. List membership and badges

### 6.1 Candidate pool (unchanged SQL)

Keep `fetchAndScoreSignals` as the pool: the tab's limit, recency, min growth, stuck flag, max age, and chain. Still one chain, still one tracking row per mint.

Do not widen that SQL to the mcap strategy limit (300) or to "80% stamp is fresh but `first_seen_at` is outside the tab recency". A mint outside the tab window is absent even if a mcap recency rule would still open it. Tab filters stay the pool; strategy match runs **inside** the pool.

`strategy_outcomes` is not a membership source. Closed history ranks strategies. It does not put a mint on this list. Do not pass `already_closed` keys into the match.

### 6.2 Match predicates

Evaluate **every** universe strategy for the request chain against each candidate. A mint is returned only when it matches the **selected** id. Other matches become badges.

**Signals ids** (`signals_default`, `signals_sell_over_100`, `signals_default_rh`): call `computeScoreAndDecision` with that template and the same hardcoded floors/weights the route already uses (`enterScoreFloor` 50, route `scoring`, request query). Do not switch signals membership onto a DB-merged config in this PR.

Member iff `decision` is `enter` or `hold`. `exit` and `skip` are not members.

Consequences, from the scorer as it exists:

- Growth `>= 100` is `exit` for `sell_over_100`. That mint is **not** on the Sell over 100% list. It can still be on Default when Default's decision is `enter` or `hold`, and it will **not** badge Sell over 100%.
- Growth `>= 80` that does not clear the enter floor is `hold` for `sell_over_100` and **is** a member.

**Mcap ids:** call `getMcapSimOpenSkipReason` with the merged registry strategy (`getMergedMcapTrackerRegistry`), an **empty** open-mint set, and an **empty** closed-outcome set. Empty sets are required so `already_open` and `already_closed` never fire. Those two reasons are paper one-shot, not "does this mint match the rule right now".

Member iff the skip reason is `null`.

That reuses rugged, organic, holders, `first_seen_too_old`, `no_milestone`, `milestone_too_old`, and `out_of_range` / missing entry mcap. It does not open a sim and does not read Early Enter ML (`ml_gate_reject` is not a return of this function today; do not add an ML skip).

`mcap_enter_at_80` matches only when the milestone rule passes (`when_reach_80pct` or growth `>= 80`, inside that strategy's recency, inside the mcap band). `mcap_enter_first_seen` matches on first-seen recency + band, with or without an 80% stamp.

### 6.3 Unique mint

After classification, one output row per `token_address`. The pool is already unique; if a future join duplicated a mint, collapse before badges. Never emit two rows because two strategies match.

### 6.4 Badge payload

Add to each `SignalItem` / signals JSON object:

```ts
alsoMatches: { strategyId: string; name: string }[]
```

- Include every universe strategy for this chain that matches, **except** the selected id.
- Order badges with the same rank as §5 (raw avg, then sum, then id).
- `name` is the registry display name (§4.1). The badge text is that name, not the id.
- No matches besides the selected strategy → `alsoMatches: []` and no badge.
- Do not badge the selected strategy on its own row.

The list response also gains the ordered picker payload (so the client does not re-rank):

```ts
strategies: {
  strategyId: string
  name: string
  domain: 'signals' | 'mcap_tracker'
  avgPnlPct: number | null // null when trade_count === 0
  totalPnlPct: number | null
  n: number // trade_count
}[]
```

`avgPnlPct` / `totalPnlPct` are null at n=0 even though the zero-fill breakdown stores numeric 0. For n>0, copy `avg_pnl_pct` and `total_pnl_pct` through, including a real 0% mean.

### 6.5 Query param and row sort

`strategy` query value becomes the **strategy id**. Still accept `default` → `signals_default` and `sell_over_100` → `signals_sell_over_100` so an old client does not 500. Any other unknown id → **400**.

On Robinhood, `sell_over_100` / `signals_sell_over_100` is unknown → 400. The RH picker never sends it.

Row sort:

- Selected id is a signals strategy: keep today's sort (that template's score desc, then growth desc) **after** dropping non-members. `limit` applies to members, not to the pre-filter pool. The pool may still read `limit * 5` candidates; document that a very large member set can be capped by that existing fetch cap. Do not raise it in this SPEC.
- Selected id is an mcap strategy: sort members by `mcap_growth_percent` desc, then `token_address` asc. There is no mcap "score" to borrow. The score / decision columns may still show a `default`-template rescore as **display only**. That display must not add or remove the row. Membership is §6.2 only.

### 6.6 Early Enter side effect

Apply the membership filter to the JSON `signals` array only.

Do not pass the filtered array into `emitSignalsEarlyAlertsFromScoredAsync`. Leave emit on the pre-filter scored list, and only when the selected id is a signals template (same attribution as today: `signals_sell_over_100` or `signals_default` / `signals_default_rh`). When the selected id is an mcap strategy, do not attribute a new Early Enter alert to that mcap id and do not invent an emit.

Do not call `passesEarlyEnterMlSoftGate`, `isEarlyEnterNoulSoftActiveEnabled`, or Noul from the membership or badge path. Soft-active stays off.

---

## 7. UI

### 7.1 Strategy control

Same toolbar slot on `SignalsTab`. Options are `strategies` from the response, in that order.

Label:

- n>0: `{name} · {avg}% avg · n={n}` with avg rounded to the nearest integer (359.4 → `359%`). `title` includes `sum {total}%` using `totalPnlPct` (one decimal is enough).
- n=0: `{name} · n=0`. No fake 0% average.

Example order when Sell over 100% is ~359% avg at n=38 and the mcap means are lower: Sell over 100% first, then the higher of the two mcap avgs, then the other, then any n=0 id (often `signals_default` until it has closes).

Changing the select refetches `useTradingSignals` with the strategy id. Chain switch swaps the universe (sol ids vs RH ids). If the persisted id is not in the new chain's universe, fall back per §7.2.

### 7.2 Persistence

New key: `signals_list_strategy_id`.

Do not write strategy ids into `signals_active_strategy`. Board still stores `default` | `sell_over_100` there.

| Stored value | Resolve |
|---|---|
| empty / missing | sol → `signals_sell_over_100`; robinhood → `signals_default_rh` |
| id in the current chain universe | that id |
| anything else | same fallback as empty |

Do not migrate by treating "highest avg" as the stored choice.

### 7.3 Badges

In the Token cell, after the symbol: one chip per `alsoMatches` entry. Text is `name`. More than one chip when more than one other strategy matches. No chip when `alsoMatches` is empty.

Do not add a second table row, a nested table, or a "also in" duplicate under Actions.

### 7.4 Trade (no change)

Keep #65 as wired:

- Toolbar Buy Amount (SOL), 5% / 25% / 90% presets, fees field.
- Floating-chart Buy calls `rowMarketSwap` / `runTrackerMarketSwap` once per confirm. No amount modal on that button.
- List Buy and list Sell open `RowTradePanel`.
- Robinhood exceptions in §3.6 stay.

Do not move list Buy onto the floating-chart one-shot path. Do not remove `RowTradePanel`.

### 7.5 Columns

Keep the current columns (growth, score, ML, decision, rationale, milestones, actions). Badges are the only new chrome. ML pattern columns stay display-only and do not gate membership.

---

## 8. Data sources

| Need | Source | Not this |
|---|---|---|
| Live mint pool | `token_mcap_tracking` via `fetchAndScoreSignals` | `strategy_outcomes` |
| Signals match | `computeScoreAndDecision` template `default` or `sell_over_100` | soft gate, Noul, pattern `pWinner` |
| Mcap match | `getMcapSimOpenSkipReason` on merged mcap config, empty open set, empty closed set | sim-open side effect, `already_closed` |
| Picker rank | `aggregateStrategyReports` breakdown, `is_simulated === true`, all-time, request `chain` | `qualifyBestStrategies`, 7-day window, live rows |
| Badge names | registry / definition `name` | raw `strategy_id` as the visible badge |
| Trade | existing `rowMarketSwap`, `RowTradePanel` | new swap stack |

---

## 9. Acceptance tests

### 9.1 Ranking

| Fixture (sim, all-time, one chain) | Expect |
|---|---|
| `signals_sell_over_100` avg 359, n=38; `mcap_enter_at_80` avg 18, n=40; `mcap_enter_first_seen` avg 16, n=35; `signals_default` n=0 | picker order: sell over 100, at_80, first_seen, default. Sell over 100 is **not** dropped for a floor. |
| Sell over 100 n=6, avg 500; at_80 n=40, avg 18 (the Researchy fixture) | picker order puts Sell over 100 **first**. `qualifyBestStrategies` on the same numbers still puts it in `hypothesis` — that function's tests stay unchanged. |
| Two strategies, same avg, different `total_pnl_pct` | higher sum first. |
| Same avg and sum | `strategy_id` ascending. |
| n=0 avg filled as 0 vs n=10 avg −5 | n=10 ranks first. |
| `qualifyBestStrategies` existing tests | still exclude tiny-n from `ranked`. This SPEC does not edit that lock. |

### 9.2 Membership and badges

| Candidate | Selected | Expect |
|---|---|---|
| growth 120, Default decision `enter`, Sell over 100 decision `exit`, first_seen matches, at_80 matches | `signals_sell_over_100` | row **absent** |
| same | `signals_default` | **one** row; badges `Enter at 80% milestone` and `Enter at first seen` in §5 order; **no** Sell over 100 badge |
| same | `mcap_enter_at_80` | **one** row; badge `Default momentum` and `Enter at first seen`; no second row |
| growth 90, both signals decisions `hold` or `enter`, first_seen matches, at_80 does not (`no_milestone` / out of recency) | `signals_sell_over_100` | one row; badge Default and first seen; no at_80 badge |
| growth 40, Default `skip`, nothing else matches | `signals_default` | absent |
| two strategies match, one mint | any of those selected | exactly one row |
| `already_closed` would skip paper for first_seen, entry rule otherwise matches | `mcap_enter_first_seen` | row **present** (closed set passed empty) |
| label `rugged` | `mcap_enter_first_seen` | absent |
| RH request | picker | no `signals_sell_over_100` option |
| `strategy=not_a_strategy` | — | 400 |
| `strategy=default` | — | treated as `signals_default` |

Badge unit: `alsoMatches` never contains the selected id. Names are display names.

### 9.3 Non-interference

- Floating-chart Buy test (or existing #65 test) still calls `rowMarketSwap` / `runTrackerMarketSwap` with the toolbar SOL amount and one sign. List Buy still renders `RowTradePanel`.
- Membership helper source has no import of `passesEarlyEnterMlSoftGate`, `early-enter-noul-shadow`, or `isEarlyEnterNoulSoftActiveEnabled`.
- `EARLY_ENTER_NOUL_SOFT_ACTIVE` default remains false. No new env default turns it on.
- Board storage key `signals_active_strategy` still only reads `default` | `sell_over_100`. Signals list writes `signals_list_strategy_id` only.
- Algo Tester routes and `getAlgoPositions` are untouched.

---

## 10. Out of scope

- Remora / Privy / 1-click.
- Trade rail.
- Soft-active ON, or consulting the Early Enter soft gate (or Noul) for list membership or badges.
- Algo Tester as the list home; merging this list into Algo Tester; adding the other four domains to this picker.
- Min-n floors on this picker; editing the Researchy board to match this picker.
- EVM OHLC.
- VPS deploy.
- Changing the floating-chart Buy path (`rowMarketSwap` / `runTrackerMarketSwap`) or replacing `RowTradePanel`.
- Paper open/close rule changes (`already_open` / `already_closed` stay in the sim worker).
- Board tab template expand.
- Auto-selecting whichever strategy currently has the highest average.

---

## 11. Files likely touched

**This PR (docs only):**

- `docs/specs/SPEC-signals-strategy-list-v1.md`
- `docs/specs/README.md` (index row)

**Implementation PR (not this one):**

| File | Change |
|---|---|
| `src/components/signals/SignalsTab.tsx` | Picker options from `strategies`; badges; new storage key. No trade-handler edits. |
| `src/hooks/useTradingSignals.ts` | `strategy` is a strategy id; response types gain `alsoMatches` and `strategies`. |
| `src/utils/signals-strategy-id.ts` | Leave Board template helpers. Add list-id read/write on `signals_list_strategy_id`. |
| `src/app/api/trading/signals/route.ts` | Map legacy template params; attach rank payload; filter `signals` after score. Do not route the filter through the soft gate. |
| New helper next to the signals pipeline (name up to the implementer) | Universe, match (§6.2), unfloored picker sort (§5). Must not import `best-strategies-rank`. |
| `src/strategies/signals-pipeline.ts` | Only if the helper needs a scored candidate without a second SQL. Do not fork the tracking query. |
| Tests | §9 fixtures beside the helper and the route. Leave `best-strategies-rank.test.ts` floors intact. |

Not expected to change: `RowTradePanel.tsx`, `row-market-swap.ts`, `tracker-market-swap.ts`, `best-strategies-rank.ts`, `signals-early-ml-gate.ts`, `early-enter-noul-shadow.ts`, Algo Tester pages, `db/init/*`.

---

## 12. Ship shape

One docs PR (this SPEC). One later implementation PR for §11. No schema migration. If review size forces a split, the only safe cut is:

1. Rank payload + picker (list membership still the old unfiltered window — not acceptable as the finished feature), then
2. Membership + badges.

Do not ship (1) alone as done. The locks are one list: ordered picker, unique mint, badges. Prefer a single implementation PR.

---

## 13. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-23 | List home | `/dev/signals?tab=signals`. Not Algo Tester. |
| 2026-09-23 | Unique mint | One row per mint for the selected strategy. Other matches are name badges. |
| 2026-09-23 | Picker order | Raw `avg_pnl_pct` then `total_pnl_pct` from sim `strategy_outcomes`. No 30/10 floor. No `avg × n + win%`. Tiny-n bias accepted (§5.3). |
| 2026-09-23 | Trade | #65 floating Buy + `RowTradePanel` unchanged. |
| 2026-09-23 | Soft-active / Noul | Stay off. Not an input to this list. |
| 2026-09-23 | Universe | Sol: default, sell over 100%, first seen, at 80%. RH: no sell-over-100 twin. |
| 2026-09-23 | Membership | Tracking window, then existing score/entry predicates. Outcomes do not list mints. Paper already-open/closed ignored. |
| 2026-09-23 | As-built | Template does not change the SQL set. Floors live in `qualifyBestStrategies` only. |

---

## 14. Related docs

- Algo Tester desk (do not merge this list into it): [SPEC-strategies-algo-tester-unify-v1.md](./SPEC-strategies-algo-tester-unify-v1.md)
- Early Enter soft gate (do not consult for this list): [SPEC-early-enter-soft-gate-v1.md](./SPEC-early-enter-soft-gate-v1.md)
- Noul shadow / soft-active flag: [SPEC-jev-soft-gate-shadow-v1.md](./SPEC-jev-soft-gate-shadow-v1.md)
- Strategy spine and `strategy_outcomes`: [../03-strategies-and-automation.md](../03-strategies-and-automation.md)
