# SPEC — `trading_records`: the missing index, and the read window that is not safe yet

**Status:** **Index SHIPPED (`f6b3665`). The 4-day read floor is SHIPPED BUT UNSAFE and must be
disabled — see Task 1.** Docs-only for everything else; no other change implied by this document.
**Date:** 2026-10-03
**Provenance:** the debug session of 2026-10-03 (prod `EXPLAIN (ANALYZE)`, `[db-slow-query]` /
`[db-pool]` logs, `pg_stat_activity`, pgbouncer config) · supersedes part of
[SPEC-trading-records-read-cost-v1.md](./SPEC-trading-records-read-cost-v1.md), which is **not**
obsoleted — read it first, it measured things this one did not.
**Related:** [SPEC-strategy-exit-standard-v1.md](./SPEC-strategy-exit-standard-v1.md) · the sibling SPEC
above (same subsystem, same window question) · `pnl-execution-stats` is unrelated despite the name

## Goal

Get `[db-pool]` acquire failures to zero and the SL/TP monitor completing every pass.

**The index half of this is done and measured. The window half is a mistake I shipped and it needs
reverting.**

---

## 1. What was actually wrong: one index

`trading_records` carried `idx_trading_records_wallet_chain_ts (wallet_address, chain, timestamp DESC)`.
Every hot read is `WHERE wallet_address = $1 [AND timestamp >= …]` — **none of them constrain `chain`**.
A btree can only use trailing columns when every leading column is constrained, so the `timestamp`
predicate was unusable and the planner fell back to `idx_trading_records_wallet`, reading **all 155,054
rows** for `trending-bot-sim-rh` (one wallet holds 155,054 of the table's 164,382 rows / 270 MB).

**Measured on prod after `61-trading-records-wallet-ts-index.sql` (`f6b3665`):**

| query | plan | time |
|---|---|---|
| 4-day bounded | `Index Scan using idx_trading_records_timestamp` | **2.736 ms**, 222 rows |
| parameterised (as the app sends it) | same | **31.6 ms** |
| unbounded, old shape | same index, wallet filtered | 620 ms, 155,054 rows |

The planner prefers the timestamp index and filters the wallet — a **global 4-day slice is 2,795 rows**,
cheaper than one wallet's 155k. `idx_trading_records_wallet_ts` is what guarantees this predicate shape
has a good plan when the statistics age, rather than relying on the ANALYZE side-effect of creating it.

**Effect on the symptom:** SL/TP monitor went from `3 completed / 4 failed / 6 skipped` (45 min) to
`5 completed / 0 failed / 0 skipped` (6 min).

### Moot / superseded in the sibling SPEC

- Its `sinceDays` measurements (`:58-66`) stand and are consistent with this. It recorded the 14-day
  window using `idx_trading_records_wallet_chain_ts` at 198 buffers; that index is usable for
  `wallet_address` + a `timestamp` **filter**, it just cannot range-seek on the timestamp. The new index
  can. **Its Task 2 gate should name `idx_trading_records_wallet_ts` now.**
- Its Task 3 (collapse cache keys) and Task 4 (re-measure before touching the pool) are **unaffected**
  and still correct.
- Its "not zero — that is what this SPEC is for" is now explained: the residual was the **plan**, not
  the payload size it was measuring.

---

## 2. The mistake: a 4-day read floor that erases live cycles

`75d5478` floored `fetchTradingRecordsForWallet` at `TRADING_RECORDS_MAX_AGE_DAYS` (default 4), on the
reasoning that the oldest **active `sl_tp_positions`** row was 68.5 h.

**That is the wrong quantity.** The reconstruction does not read `sl_tp_positions`; it reads
`trading_records` and derives "open" cycles from buys with no later close. The sibling SPEC measured
those: **`mcap-tracker-sim` 84 days, `signals-strategy-sim` 92 days, `gmgn-sim` 83 days** — while the
worker's own active rows were 2 days. Its `:77-80` states the consequence exactly: a window erases
those cycles, `getOpenMcapPositions` reports **"closed"** for mints the sim may still hold, and the sim
**re-opens duplicates**.

So the shipped floor can make a sim re-enter a position it already holds. Nothing errors.

**Worse, the guard I shipped with it measures the same wrong quantity.** `check-sltp-closer-freshness.sh`
asserts the margin against `sl_tp_positions.created_at` (68.8 h) — so it will report "OK" while the
thing the window actually truncates (the reconstruction's cycles) is already 83–92 days old. A guard
that cannot see the failure it guards is the failure the guard was supposed to prevent.

### Task 1 — disable the floor (do this first)

`TRADING_RECORDS_MAX_AGE_DAYS=0` in the VPS `.env` (env only — no deploy), then restart web. Back up
`.env` to a timestamped copy first and prove the running process loaded it, per the repo's env-change
convention. `0` is the documented escape hatch and restores the previous behaviour exactly.

**This costs less than it sounds.** With the index in place the unbounded read is **620 ms**, against
120 s before it — measured, not assumed. The index is what fixed the pool; the window was never what
made the read fast. The `mcap-tracker-sim` read was 11.4 ms plain in the sibling's table.

### Task 2 — make the guard measure the reconstruction, or delete that clause

Once the floor is off, the margin clause has no subject. If a window is reintroduced (Task 3), the guard
must assert the oldest **reconstruction** cycle — a `trading_records` buys-with-no-close query — not
`sl_tp_positions`. Until then the clause should go rather than report a quantity that cannot fail.

### Task 3 — if a window is reintroduced, it is per-family and differentially tested

The sibling's Task 2 already specifies the shape: derive the window **per family from its own
`maxHoldHours`**, not a magic constant, and gate it on a **differential test** — the reconstructed open
set must be byte-identical to the unbounded read's on one snapshot. Its Task 1 (**reconcile the stale
cycles first**) is the prerequisite, and it is still open: until 83–92-day cycles are resolved, any
window is a bet.

**Do not reintroduce a window before Task 1 of the sibling SPEC is clean.**

---

## 3. Open items

- **Pool failures are down but not zero** (~50/min at the time of writing, declining; `total=8 idle=2`
  from `25/0`). Re-measure on a settled container with no concurrent deploy before calling it done.
- **`idx_trading_records_wallet` is now redundant.** `(wallet_address)` is a prefix of both
  `(wallet_address, chain, timestamp)` and `(wallet_address, timestamp)`. Left in place deliberately —
  drop it in a later step, once this has run across more traffic, so the measurement is not confounded
  by a second change.
- **`pg_stat_activity` showed 1–2 backends while the web pool reported 25 busy.** Not a fault: the web
  is a client of **pgbouncer** (`pool_mode = transaction`, `default_pool_size = 30`,
  `max_client_conn = 200`), which multiplexes. Worth remembering — a 25/25 web pool does not mean 25
  Postgres backends, and the 12 s "slow queries" logged during saturation were **queue wait**, not query
  time (the same query plans at 31 ms).
- **Unnamed callers.** The sibling's note stands: `[db-pool] via=` frames are minified. Adding the wallet
  and opts to the `[db-slow-query]` line would attribute them.

## Non-goals

- Not deleting or rewriting trade history.
- Not raising the pool or the heap. Both were raised before and neither was the constraint.
- Not a normalized schema rewrite for `trading_records`.
- Not a projected read — the sibling measured the droppable share at 8.9%.

## Risks

- **Disabling the floor restores a 620 ms read per call, not 2.7 ms.** Accept: it is still 200× better
  than the 120 s that caused the incident, and it removes a correctness hazard.
- **Four changes in this area have now needed a revert or a retraction** (`sinceLastClose`, the
  projection, the window, and this floor). Every remaining step is gated on a measurement.
- Concurrent sessions: commit explicit paths, ship from an isolated worktree.

## Verification gate

1. **Task 1:** the running process reports `TRADING_RECORDS_MAX_AGE_DAYS=0`; the unbounded read returns
   the same row count as before the floor; no duplicate re-opens appear in `trading_records` for the
   mints in the reconstruction's open set.
2. **Index (done):** `EXPLAIN (ANALYZE)` on both the 155k wallet and `mcap-tracker-sim` shows an index
   path, no `external merge`, and a 4-day read under 50 ms.
3. **Overall, settled container, no concurrent deploy:** `[db-pool]` acquire failures **0** per 5 min;
   `[db-slow-query]` **0** per 5 min; every SL/TP pass completes with no `context deadline exceeded` or
   `EOF`; `reloadsol-web` `restarts=0`.
