# SPEC — The notification freshness contract: every card either shows a current value or is not sent

**Status:** To-spec (docs only) — **for review, nothing implemented by this document.**
**Date:** 2026-10-02
**Provenance:** the debug session of 2026-10-02 (prod reads, `EXPLAIN`, the `[db-slow-query]` /
`[db-pool]` loggers, and a full audit of the notify paths).
**Related:** [SPEC-trading-records-read-cost-v1.md](./SPEC-trading-records-read-cost-v1.md) ·
[SPEC-strategy-exit-standard-v1.md](./SPEC-strategy-exit-standard-v1.md)

## Goal

**Every strategy notification carries a value observed within the last 5 seconds, or it is not sent.**
Not just mcap — all of them, on one shared path, so a new strategy cannot opt out by omission.

Two windows, and they are different things:

- **W1 — data freshness.** The value on the card is ≤ `NOTIFY_MAX_STALENESS_MS` (5s) old.
- **W2 — event→send latency.** The card is sent within 5s of the event that produced it.

Both must hold. A card that is accurate but arrives an hour later is a different failure (the one this
session started from); a card that arrives instantly with a day-old number is this one.

## Evidence

### A 5-second window is impossible against the current source — measured

`token_mcap_tracking` is what every mcap card reads. Among the tokens the sim actually considers
(chain `sol`, updated within the 240-min window, inside the 30k–2M band):

```
candidates                     201
median mcap age            1,392 s  = 23.2 minutes
p90 age                   11,413 s  =  3.2 hours
worst age                 14,293 s  =  4.0 hours   (== the recency window)
within 5 seconds                 0     ← none
within 3 minutes                21  (10%)
```

Across all 25,676 tracked rows it is worse: **0 within 5 s**, median **30 days**, p90 78 days. Only
~16 rows are touched per 2-minute tick.

**So a 5s rule reading the tracked row suppresses 100% of mcap notifications.** The window is only
satisfiable by reading the live source at the boundary. That is the whole design.

### Why the row is stale by construction

`trackTokenMcap` (`src/utils/mcap-tracker.ts:714`) writes `current_mcap`/`last_updated_at` only when
the change exceeds `MCAP_DB_WRITE_PERCENT` (default **1%**) **or** on a heartbeat of
`MCAP_HEARTBEAT_MS` (default **600s**). Its only timed callers are `filtered_trending` and
`unfiltered_trending`, both on a fixed **2-minute** cron (`main.go:496`, `:504`), and only for tokens
inside the tracking band. There is no dedicated worker. A low-volatility token's row can therefore be
**~10 minutes** old, and a token that leaves the trending payload simply stops updating.

### The mcap family enters on that stale row — confirmed end to end

`DSmp1qi6fAGn9Xj4cztBi8B1UJUBoiADn7QPhfEnsFq6`, 2026-10-02:

```
13:20:00 +07   crossed the 80% milestone
06:20 UTC      mcap sim job flapping: EOF / "connection reset by peer" / 500 / "job lock held"
14:20 +07      the token's row froze at current_mcap = $307.2K, last_updated_at = 14:20
16:13:05 +07   a pass finally succeeded → opened on that frozen row
16:13          👁 Follow alert fires, carrying the frozen $307.2K
16:17:35 +07   closes at $171K = −44.2%          (171,367 / 307,200 − 1)
```

`resolveMcapSimEntry`'s docstring says *"always book live current_mcap at open time"*, but it returns
`snapshot.current_mcap` from a candidate query that admits rows up to **240 minutes** old, and
**no freshness guard exists anywhere on the open path** — the skip-reason enum has
`milestone_too_old` and `out_of_range` but no stale case, and `last_updated_at` is used only as the
`entryAt` fallback, never as a gate.

### The defect is the whole mcap family, not one strategy

`entry_at` vs when the buy record was actually written, last 24 h:

```
strategy_id                              n   med_lag  worst     >5s
mcap_enter_first_seen                    6    27.0m   120.2m     6/6
search_mcap_first_seen_…tp300_h48        5    22.2m   114.9m     5/5
search_mcap_first_seen_…tp200_h48        7    22.0m   122.9m     7/7
search_mcap_first_seen_…tp150_h48       26    14.1m   174.9m    25/26
mcap_enter_at_80                        20     2.6m   113.1m    14/20
gmgn_kol_momentum / gmgn_sm_kol_combined 6     0.1m     0.1m     0/6    ← clean
```

### Notify-path audit — where each card's number comes from

| entry point | displayed value | source | how stale | deferral |
|---|---|---|---|---|
| `notifyStrategyOpen` (mcap) | Entry mcap, Organic, top10 | `token_mcap_tracking` row via `fetchMcapSimCandidateRows` | **≥2 min, ≤~10 min, up to 240 min** | detached `void work()` |
| `notifyStrategyOpen` (gmgn) | Mcap, top10 | live GMGN `tokenInfo` at discovery | discovery→send gap | detached |
| `notifyStrategyOpen` (signals) | Mcap | `entryFeatures.entry_mcap` (open snapshot) | open-time | detached |
| `notifyStrategyOpen` (social) | Mcap | `entryFeatures.market_cap` (open snapshot) | open-time | detached |
| `notifyStrategyOpen` (trending) | Mcap | Jupiter toptrending cache | ≤2–5 min | detached |
| `notifyStrategyOpen` (dlmm) | Mcap | live Meteora `fetchMeteoraPool` | live ✓ | detached |
| `notifyStrategyClose` (mcap) | Market Cap, PnL | `token_mcap_tracking.current_mcap` at close | ≥2 min, ≤~10 min | detached |
| `notifyStrategyClose` (signals/gmgn/social) | Market Cap | **entry-time** `market_cap`/`entry_mcap` replayed — no `exit_mcap` | entire position lifetime | detached |
| `notifyStrategyClose` (trending) | PnL, Result | live-price PnL; `features` omitted → `Market Cap: —` | PnL live | detached |
| `notifyBestStrategyFollowAlert` | Mcap | `entry.entryMcap` (tracked row) | same as mcap open | **`after()` — waits for the HTTP response (W2 risk)** |
| gmgn radar / wallet-digger | Mcap, price | **live `fetchJupiterMarketHints` / GMGN `tokenInfo`** | seconds ✓ | inline |

**No notify or send function rejects stale data.** Grep for staleness checks inside
`notifyStrategyOpen`, `notifyStrategyClose`, `notifyBestStrategyFollowAlert`, `sendTelegramMessage`,
`sendTelegramOhlcPhotoOrText` returns nothing — the existing `isWithinRecency`,
`is_tracking_stuck`, `isStaleData` and `FRESH_AGE_MS` all gate *eligibility or lifecycle*, never the
send.

**No strategy OPEN/CLOSE card carries an observation timestamp.** `entryAt` is available at the mcap
call sites and dropped; the close cards carry none at all.

### Two further defects the audit surfaced

1. **Close cards for signals/gmgn/social show an ENTRY-time mcap.** `mergeEntryFeaturesForOutcome`
   sets `exit_price_usd` but no `exit_mcap`/`current_mcap`, so `preferExit` falls back to the entry
   value. A close card reporting "Market Cap" is reporting where it opened, not where it exited.
2. **The follow alert's deferral waits for the response** (`scheduleOffRequestPath` → Next `after()`),
   while `notifyStrategyOpen/Close` detach immediately. On a slow route that is a W2 violation on the
   one path this session was about.

## Design

### The one live source that already exists

`fetchJupiterMarketHints(mint)` → `{ usdPrice, volume5m, mcap }`
(`src/utils/jupiter-metadata.ts:229`) — a live Jupiter lite-api call, already used for radar cards
(`activity-poll/route.ts:216`), and **already computed and then discarded** by
`resolveTokenMonitorSnapshot` (`src/strategies/sim-monitor-snapshots.ts:150`, uses only
`usdPrice`/`volume5m`).

That discard is the cheapest fix available in this codebase: the value is already being fetched on the
mcap open path, just not used.

### Task 1 — one resolver, one choke point

Add `resolveFreshMarketValue({ mint, chain, kind: 'mcap' | 'price' })` returning
`{ value, observedAt, source } | null`:

- live read first (`fetchJupiterMarketHints` → `mcap`; GMGN `tokenInfo.market_cap`; DexScreener for
  RH), with a **≤5s in-process cache keyed by mint** so several cards in one pass cost one call;
- `null` on failure or timeout (short, explicit), never a silently stale value;
- no long-lived provider fallback — a stale answer is worse than no answer here.

### Task 2 — enforce the contract at the send boundary

`notifyStrategyOpen` / `notifyStrategyClose` / `notifyBestStrategyFollowAlert` take an
`observedAt`. One gate (inside the shared send helper, not per call site):

```
age = now - observedAt
if (value == null || age > NOTIFY_MAX_STALENESS_MS) → suppress, log `[notify-suppressed] reason=stale ageMs=… source=…`
```

Suppression must be **named and logged**, so a missing card is distinguishable from a broken one.
Every card renders `as of <age>s` so the reader can see what they are looking at.

### Task 3 — carry the observation time

Every card gets `observed_at`. For mcap, stop using `last_updated_at` as `entryAt`; stamp
`entry_at` = **open time** and keep the milestone in its own field (this is the separate
stamp bug already recorded in `SPEC-trading-records-read-cost-v1.md`).

### Task 4 — fix the close-card value independently

Signals/gmgn/social close cards must report the **exit** value, not the entry one: populate
`exit_mcap`/`current_mcap` at close from the same resolver, with `preferExit` semantics already in
`telegramExtrasFromFeatures`.

### Task 5 — make the follow alert's deferral match the others

Either detach (`void work()`, like open/close) or move the `after()` send to the top of the response
so it cannot sit behind a slow handler. Pick one; today it is neither.

## Per-family outcome under this contract

| family | source today | meets 5s without a live read? | after Tasks 1–2 |
|---|---|---|---|
| mcap open/close | tracked row | **no** — median 23 min | live Jupiter mcap |
| gmgn open | live GMGN at discovery | discovery→send gap only | live at send |
| signals / social open | open snapshot | no | live at send |
| trending | Jupiter cache 2–5 min | no | live at send |
| dlmm | live Meteora | **yes** | unchanged |
| gmgn radar / wallet-digger | live Jupiter / GMGN | **yes** | unchanged (the model to copy) |

## Options considered for W1, and why live-at-send wins

| option | verdict |
|---|---|
| **A. Raise the tracker to 5s** | **Rejected.** 25,676 rows × a rate-limited upstream, and it would still miss any token outside the current trending payload. Cost is unbounded for a 5s guarantee it cannot actually give. |
| **B. Live read at the send boundary** | **Recommended.** One call per card, rare events, and the call is already made on the mcap open path. Gives a real 5s bound. |
| **C. Suppress when the cached value is stale** | **Recommended as the fallback**, not the primary — alone it suppresses ~100% of mcap cards. |
| **D. mcap = price × supply** | Viable fallback where supply is available, but adds a second dependency and its own staleness. Only if B is unavailable for a chain. |
| **E. Widen the window to the tracker cadence (e.g. 3 min)** | **Rejected** — it is a different requirement, and it does not fix the stale-entry loss. |

## Env

| key | default | meaning |
|---|---|---|
| `NOTIFY_MAX_STALENESS_MS` | `5000` | a card whose value is older than this is suppressed |
| `NOTIFY_FRESH_CACHE_MS` | `5000` | in-process cache for the live resolver, keyed by mint |
| `NOTIFY_LIVE_READ_TIMEOUT_MS` | `1500` | the live read fails open to *suppress*, not to a stale value |

## Non-goals

- Not raising the mcap tracker's cadence (option A).
- Not suppressing mcap cards wholesale — Task 1 is what makes them sendable.
- Not touching the exit worker's decision path; this is the notify and entry-value boundary.
- Not backfilling historical cards.

## Risks

- **Volume.** If the live read is flaky, cards stop. That is the stated intent ("else don't send"),
  but it must be **observable**: a `[notify-suppressed]` line with a reason, and a counter, so a
  silent card is never mistaken for "no trades".
- **Cost/rate.** One live call per card; cards are rare. The ≤5s cache collapses repeats within a pass.
- **A live mcap can disagree with the tracked row.** Expected — that is the point — but it means the
  card and the DB will differ, so the card must say so (`source`, `as of`).
- **Task 3 changes stored values**, so it moves historical comparisons; do it as its own commit with a
  differential check, as with the earlier `sinceLastClose` rewrite.

## Verification gate

1. **Resolver:** for a known mint, `resolveFreshMarketValue` returns `observedAt` within 5s of `now`
   on success, and `null` on timeout/upstream failure — proven by a test with a stubbed failing fetch.
2. **Gate:** a card built with `observedAt = now - 6s` is **not** sent, and one at `now - 1s` is;
   asserted at the shared send helper, not per call site, so a new caller cannot bypass it.
3. **Live, on a settled container:** over 30 minutes of production —
   - every sent card's `as of` is ≤5s;
   - every suppression logs `[notify-suppressed]` with a reason;
   - no card shows an `entry_at` more than 5s from its buy record's timestamp (the per-strategy query
     from the Evidence section above, re-run);
   - signals/gmgn/social close cards show an **exit** mcap, not the entry one.
4. **Regression:** the mcap family's `med_lag` column in that per-strategy query goes to ~0, matching
   gmgn's.
