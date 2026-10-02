# SPEC — The `trading_records` read cost: reconcile the stale cycles, then bound the read

**Status:** To-spec (docs only) — **for review, nothing implemented by this document.**
**Date:** 2026-10-02
**Provenance:** the debug session of 2026-10-02 (prod reads + `EXPLAIN (ANALYZE, BUFFERS)` + the
`[db-slow-query]` / `[db-pool]` loggers that session added). Commits referenced below are shipped.
**Related:** [SPEC-strategy-exit-standard-v1.md](./SPEC-strategy-exit-standard-v1.md) (S9 — one worker
owns every exit; this SPEC is about the read that worker and every sim sits on) ·
[SPEC-exit-optimization-v1.md](./SPEC-exit-optimization-v1.md)

## Goal

Get **pool acquire failures to zero** and the **SL/TP monitor completing every pass**, by removing the
last source of pool pressure: `fetchTradingRecordsForWallet` hydrating a whole wallet repeatedly.

Two things stand in the way, and only the first is a blocker:

1. The reconstruction reports open cycles that are **months old and almost certainly not open**, which
   makes any time-window bound unsafe.
2. The read cache that shipped (`1b734b4`) is keyed by `wallet + opts`, so the same wallet read with
   different `opts` is a different key and still a separate query.

## Evidence

### The read is expensive and it is what fails

Over one 10-minute production window:

```
pool acquire failures                     113
  └─ of which "SELECT data FROM trading_records …"   101
slow queries >5s                           23
  └─ every one of them that same statement
pool state at failure                      total=25 idle=0 waiting=5…8     ← genuine saturation
SL/TP monitor                              1 completed vs 4 FAILED
```

`mcap-tracker-sim` is **6,302 rows / 11 MB** and costs **~7.8 s of client-side JSON parsing**, and the
pool client is held for the whole of it. The mcap sim-track route reads it **once per strategy** on a
15 s open-phase cadence; the SL/TP worker's close path reads it **once per position**. That is ~25
reads/min of one 11 MB wallet.

### Two bounds were tried and both are wrong — do not retry either blind

**`sinceLastClose` (`2ea8448`, then reverted by `d7390c3`).** It extracts JSONB *paths*
(`data->>'bot_strategy'`, `data->'tokens'->0->>'mintAddress'`, …), which forces Postgres to **detoast
the whole `data` column for every row** server-side. `SELECT data` defers that detoast to the client
instead. Measured on `mcap-tracker-sim`:

```
plain read    Index Scan  Buffers: shared hit=2,307     12 ms
bounded read  Index Scan  Buffers: shared hit=44,968   416 ms idle, ~10 s under load
```

~351 MB of buffer reads for an 11 MB wallet. In production: 150 slow queries in 8 minutes, 1,692
client-seconds, at a steady 25/min.

**`sinceDays` (tested, not shipped).** Index-friendly and *does* avoid the detoast — this is the right
shape:

```
window=none     11.4 ms   2,311 buffers   6,302 rows
window=14 days  56.0 ms     198 buffers   3,486 rows   ← uses idx_trading_records_wallet_chain_ts
window= 7 days   6.5 ms   1,936 buffers   2,546 rows
window= 2 days   4.5 ms   bitmap scan     1,058 rows
```

**But it is unsafe today**, which is this SPEC's blocker:

```
oldest ACTIVE position in sl_tp_positions (what the worker owns)   2 days 08:57
oldest "open" cycle in trading_records (buys with no later close)  mcap-tracker-sim   84 days
                                                                   signals-strategy-sim 92 days
                                                                   gmgn-sim            83 days
```

A 14-day window erases those cycles, `getOpenMcapPositions` then reports **"closed"** for mints the sim
may still hold, and the sim **re-opens duplicates**. That is exactly the failure
`fetchTradingRecordsForWallet`'s own docstring warns about ("an open position whose opening buy falls
outside the window can no longer be reconstructed, so it reads as closed").

### A projected read does not help

`tokens[]` + `trading_simulation` are **91%** of the payload and both are required by the cycle walk
(`computeOpenTradeCycle` iterates every token and reads `tokenAmount`/`priceUsd` to decide
open-vs-closed). Measured droppable: **8.9%**. Building a projected JSONB measures *larger* (34 MB) —
the computed value does not inherit the stored column's TOAST — and adds per-row CPU. Dropped.

### What shipped this session

- `2ea8448` — pricing reads the batched source first (81,142 ms → 7,628 ms).
- `508322c` — the worker's price write is one batched statement, not ~160 concurrent UPDATEs.
- `6c8f64f` — the `sinceLastClose` query is hash-joinable (120,096 ms → 861 ms), differential-verified.
- `5ef0135` — `defaultIsOpen` no longer hydrates the whole wallet per candidate. This is what stopped
  the V8 heap OOM that was killing web every ~90 s and presenting as a database fault.
- `1b734b4` — a 60 s TTL cache on the read, invalidated on every write.
- `eb…`/`17e8051` — permanent `[db-slow-query]` and `[db-pool]` logging.

Post-`1b734b4`: slow queries **0**, pool failures ~44/5 min (from 113/10 min), monitor **5 consecutive
passes**, no heap OOM, endpoints fast. **Not zero — that is what this SPEC is for.**

## Design

### Task 1 — reconcile the stale open cycles (the blocker; do this first)

Audit, then repair. Do not assume they are all artefacts.

1. **Classify** every `(strategy, mint)` the reconstruction calls open, by age, against whether it has
   a matching full-close sell (`data->>'close_position' = 'true'`), a partial close, or nothing.
2. **Cross-check** each against `sl_tp_positions` (the row the worker actually manages) and
   `strategy_outcomes` (`exit_at IS NOT NULL`).
3. Decide per class:
   - *Genuinely open* → leave; it must survive any window.
   - *Stale* (closed in the world, no matching close record) → repair by writing through the product's
     **own** record shape — a real `close_position` sell carrying the exact remaining amount and cost
     basis — exactly as `closeMcapStrategySimPositions` does, with a neutral reason. **Never delete or
     rewrite history.**
4. Report the census before mutating anything: counts per class, oldest age, and how many would be lost
   by a 14-day window.

**Deliverable:** a committed, re-runnable script, dry-run by default with `--apply`, batched writes,
backing up only the affected rows before writing, idempotent on re-run, and rows whose true value is
genuinely underivable left honestly untouched rather than fabricated.

### Task 2 — bound the read with `sinceDays` (only after Task 1 is clean)

Per-family window derived from that family's own `maxHoldHours` (mcap sims default 96 h), **not a
magic constant**, with margin. Index-friendly: it filters a real column, so no detoast.

**Gate:** `EXPLAIN (ANALYZE, BUFFERS)` shows the `idx_trading_records_wallet_chain_ts` path (≈200
buffers, not ≈45,000) **and** the reconstructed open set is byte-identical to the unbounded read's on
one snapshot — a differential test, not reasoning.

### Task 3 — collapse the cache keys

`walletRecordsCacheKey` is `wallet + opts`, so `{}`, `{ sinceLastClose: true }` and
`{ strategies: [...] }` are three separate reads of one wallet. Establish which of them a caller
actually needs, and reduce to **one canonical read per (wallet, purpose)**.

Cheapest first: reuse an existing read rather than adding one. The mcap sim-track route already showed
this is possible — it was doing a redundant second identical read that `1b734b4` removed.

### Task 4 — re-measure, then decide about the pool

Only if `[db-pool]` still shows `waiting > 0` at `total = DATABASE_POOL_MAX` after Tasks 1–3 is raising
the pool justified. It was raised 10 → 25 once already and changed nothing, because the constraint was
never size.

## Env

| key | default | meaning |
|---|---|---|
| `WALLET_RECORDS_CACHE_MS` | `60000` | TTL for the `fetchTradingRecordsForWallet` cache; `0` disables |
| `DB_SLOW_QUERY_MS` | `5000` | log any query holding a client longer; `0` disables |
| `DATABASE_POOL_MAX` | `10` code / `25` prod | app pool size |
| `DATABASE_POOL_CONN_TIMEOUT_MS` | `5000` | how long a query waits for a free client |

## Non-goals

- Not deleting or rewriting trade history; Task 1 repairs by writing real sell records.
- Not a nicer read shape only — the stale cycles are a **correctness** defect, worth fixing regardless
  of performance.
- Not raising the pool or the V8 heap as the fix. Both are headroom; both were already raised.
- Not moving this to a Go worker. Go has no Postgres client and never has — it calls web over HTTP, so
  it cannot relieve the pool, only add a second consumer.
- Not a normalized schema rewrite for `trading_records`.

## Risks

- **Task 1 writes to production trade history.** Dry-run first, report the census, back up the affected
  rows, batch, and prove idempotency by re-running.
- **A "stale" cycle that is genuinely open** would, if wrongly closed, cause a re-entry the sim would
  not otherwise make. The classification in Task 1 step 2 exists to catch this; if a class is ambiguous,
  leave it and report it rather than guess.
- **Three fixes in this area already needed a revert or a retraction** (`sinceLastClose`, the
  projection, and the window). Every step here is gated on a measurement, not on plausibility.
- Concurrent sessions: commit explicit paths, ship from an isolated worktree.

## Verification gate

1. **Task 1:** census printed; dry-run row count and token sum reported; `--apply` re-run is a no-op;
   affected rows unchanged apart from the repair; zero rows deleted.
2. **Task 2:** `EXPLAIN (ANALYZE, BUFFERS)` on the `mcap-tracker-sim` and 155k-row wallets shows the
   index path and no `external merge`; **differential test**: old vs new query return identical id sets
   on one snapshot, and `getOpenMcapSimPositions` / `openPositionsFor` return identical open sets.
3. **Overall, on a settled container with no concurrent deploy:**
   - `[db-pool]` acquire failures **0** per 5 minutes
   - `[db-slow-query]` **0** per 5 minutes
   - SL/TP monitor: **every pass completes**, no `context deadline exceeded` / `EOF`
   - `reloadsol-web` `restarts=0`, no `Reached heap limit`
   - `/api/health` < 50 ms, `/api/strategies/outcomes` 200 < 1 s

## Open items

- **The V8 heap cap is headroom, not a fix.** Peaks measured 627 MiB against a 768 MiB container before
  the cache; `WEB_NODE_OPTIONS=--max-old-space-size=640` only moves the ceiling. If peaks fall with the
  cache, good — but the driver is the hydration payload, which is what Tasks 1–3 reduce.
- **Unnamed callers.** The `[db-pool]` `via=` frames are minified in the standalone bundle, so the
  remaining failing reads could not be attributed to a specific call site. If Task 3 needs it, add the
  wallet and opts to the `db-slow-query` line rather than reading bundle offsets.
- **`docs/03-strategies-and-automation.md`** still lists per-family cadences; if Task 2 changes any read
  cadence, re-check those rows.
- **Not yet explained:** `signals-strategy-sim-rh` (10 rows) and `mcap-tracker-sim-rh` (745 rows) are
  tiny, yet appear in the stale-cycle list at 66 and 63 days. Worth understanding before classifying.
