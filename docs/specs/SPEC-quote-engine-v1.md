# SPEC — One Solana quote engine, and every trade layer derives from it v1

**Status:** implemented (2026-10-01) — steps 1–4 shipped and live on prod; step 5 partly. See §4 for the per-step status and what is deliberately left open. **§10 (2026-10-02)** records the post-ship assessment, two retractions, and the one fix it produced.
**Date:** 2026-10-01
**Surface:** `src/utils/quote-engine.ts` (new), `src/hooks/useQuote.ts` (new), `src/components/BulkTokenSeller.tsx`, `src/components/BulkTokenBuyer.tsx`, `src/components/signals/*`, `src/components/PnLTracker.tsx`
**Lane:** Solana trade surfaces only (bulk buy, bulk sell, signals, PnL, DLMM fast swap)
**Depends on:** `@tanstack/react-query` (installed, v5 — the module is built on it rather than adding a fourth cache), `src/utils/solanatracker-raptor.ts`, `src/utils/jupiter-swap-quote.ts`, `src/utils/swap-quote-parallel.ts`, `src/utils/jupiter-rps.ts`, `src/utils/token-transfer-fee.ts`
**Provenance:** quote-layer inventory of this repo, 2026-10-01 (every surface, primitive, cache and refresh policy read from source)

---

## 1. Goal

One module owns what a Solana quote is, where it comes from, how fresh it must be, and which rate lane
it spends. Every trade surface asks it, and none of them rolls its own fetch, cache or timer.

## 2. Why — measured from the current code

**(a) A displayed number spends the scarce execution budget.** `BulkTokenBuyer`'s prefetch
(`:547`) → `warmResolvedPreparedSwap` → `prepareSwapTransaction` → `prepareJupiterSwapOrder(taker)` →
`jupiter-swap-quote.ts:236` **trade lane**, and its `outAmount` is exactly what the UI shows as
"You'll get" (`:560-575`). Same in `BulkTokenSeller:659` and `RowTradePanel:169`. A taker-scoped prepare
draws from the one bucket an actual execution needs — 0.5 rps sustained, burst 8 — while the honest
no-taker estimate path sits on the **background** lane for free.

**(b) The same quote is fetched 3–4 times.** Sell estimate: `LiveTab:768`, `PnLTracker:2017`,
`BulkTokenSeller:539`. Buy estimate: `LiveTab:667` and `BulkTokenBuyer:898`. The same prepare is built
independently by Buyer, Seller and RowTradePanel, deduped only by the 8 s prepared-swap cache.

**(c) Six refresh policies for one concept.** 400 ms debounce (Buyer `:543`, Seller warm `:674`,
RowTradePanel `:158`) · 25 s interval (Seller `AUTO_QUOTE_REFRESH_MS:379`) · 300 ms hover + 1 s clear
(PnLTracker `:2046`) · react-query `staleTime 8 s` (DlmmFastSwapModal `:216`) · hover-only (LiveTab) ·
2 500 ms while a confirm modal is open (RH legs `:1627`).

**(d) There is no shared hook.** `useQuote` / `useSwapQuote` / `QuoteProvider`: **0 matches**.

**(e) A primitive had drifted from its use.** The exported `fetchRaptorQuote`
(`solanatracker-raptor.ts:311`) had **no production caller**, while `BulkTokenSeller:461` re-implemented
an equivalent locally. The engine adopted the real primitive, so the two are back in sync — and the
local copy is gone.

## 3. Design

### 3.1 Two files

```
src/utils/quote-engine.ts   // server-safe core, no React
  quoteKey(req)             // deterministic; covers every input that changes the answer
  requestQuote(req)         // coalesced + cached + lane-correct
  peekQuote(key)            // sync read of a still-fresh entry
  subscribeQuote(key, cb)   // fan-out so N surfaces share ONE request
  resetQuoteCacheForTests()

src/hooks/useQuote.ts       // thin react-query binding, 'use client'
  useQuote(req, policy?)    // one quote
  useQuotes(reqs, policy?)  // N quotes (bulk selections) via useQueries
```

react-query already provides cross-component dedupe, `staleTime` and `refetchInterval`; the module
reuses that instead of adding a fourth cache beside `quoteCache` (4 s), `preparedSwapCache` (8 s) and
the react-query price caches.

### 3.2 `purpose` is first-class — this is the decision being made wrong today

| purpose | source | Jupiter lane | cached | when it must be fresh |
|---|---|---|---|---|
| `estimate` | **Raptor `/quote` first**; escalates to the Jupiter picker only when Raptor errors or its impact fails the gate | **none** (Raptor is not gated) | yes, `QUOTE_ESTIMATE_TTL_MS` | tolerant — a display number may be seconds old |
| `execute` | `/swap/v2/order?taker=` (+ `requestId` in the same response) | **trade** | **never** | always — built at click |

The `estimate` rule is not new invention: it is the guardrail `docs/SWAP_AND_CLOSE_FLOW.md:37-43` already
documents for the sell surface ("quote the venue that executes… escalates to the picker only when Raptor
is unavailable or its own impact fails the gate"), lifted into one place so buy, signals and PnL inherit
it rather than each rediscovering it.

### 3.3 The refresh policy is data, not a magic number per component

| phase | rule |
|---|---|
| `onEdit` | debounce the **inputs** (`debounceMs`, default 300) |
| `freshness` | the cache decides whether a fetch happens at all — a re-edit inside `staleTime` costs **zero** requests |
| `whileStable` | optional interval (`refreshMs`); default **false** for `estimate` — a quote is not a live ticker |
| `hidden tab` | never fetch (`refetchIntervalInBackground: false`) |

**Debounce the inputs, not the quote.** The current buyer debounces a *fetch*, so a settled edit fires one
trade-lane prepare per mint — the documented 14.87 s bulk path. Debouncing the key and letting freshness
gate the fetch makes a 5-mint edit cost one request per *changed* mint, and a re-edit cost nothing.

## 4. Migration order — status

| step | status |
|---|---|
| 1 · core + hook | **done** — `src/utils/quote-engine.ts`, `src/hooks/useQuote.ts` (react-query v5 binding), `quote-engine.test.ts` |
| 2 · `BulkTokenSeller` | **done** — its local `fetchRaptorQuote` re-implementation is gone, `fetchQuoteForToken` asks the engine, and the 25 s figure is now `QUOTE_ESTIMATE_REFRESH_MS_DEFAULT` so there is one number instead of two |
| 3 · `BulkTokenBuyer` | **done** — the displayed estimate now comes from `useQuotes(…, 'estimate')` instead of the warmed prepared swap, so it no longer spends the Jupiter trade lane; the warm stays for click latency but no longer *is* the display |
| 4 · signals + PnL | **done, at the chokepoint** — rather than editing four call sites, `getSwapQuote` (which the signals tab's buy/sell hovers and the PnL tracker's sell estimate all call) now routes through the engine and adapts back via `solanaQuoteToSwapQuote`. They inherit the shared key, cache and estimate policy with **zero** call-site changes, and the duplicate fetches collapse onto one entry |
| 5 · delete orphaned caches | **done — nothing orphaned remains.** The two this SPEC named (the seller's local Raptor client, the buyer's `solPrefetchOut` feed) are gone. Audited 2026-10-01, reader-by-reader: `preparedSwapCache` is the **execution** warm, `jupiter-swap-quote.ts`'s `quoteCache` is read by `withJupiterOrderQuote` (the execute path), and `quote-engine.ts`'s `estimateCache` has a live reader. Every cache left has a caller, so the honest result is that there was nothing further to delete — not that the step was skipped |

### The raw-amount bug, and the fix

`BulkTokenBuyer` rendered `~{solPrefetchOut[mint]}` with **no formatter**, filled from `warmed.outAmount`
— a raw smallest-unit integer — so the badge read like `~33661682691` beside the token symbol.

Fixing *where the number comes from* without fixing that would just have moved the bug, so the engine now
carries the scale: an `estimate` attaches **`outDecimals`** for the output mint, read from the same cached
mint-account call that already answers the transfer-fee question (`getMintDecimals` shares that reader
rather than adding a second lookup). A surface renders `formatTokenAmount(outAmount, outDecimals, 4)`, and
when the mint cannot be read it shows **nothing** rather than guessing an exponent — a wrong scale is worse
than a missing number.

**The warm now fires on intent.** It used to run 400 ms after every settled edit, which spent the trade lane
on an amount the user was still deciding on. Both forms warm through `useWarmOnIntent` instead: after
**1.5 s of idle**, or immediately on `pointerenter`/`focus` of the action button, and once per distinct set
of inputs (re-hovering the same form is free). Reaching for the button is when the warm pays, so that is now
when it starts. A missed trigger costs **latency only** — the click path builds on a cold cache — which is
what makes this safe to leave heuristic rather than exhaustive.

## 5. Out of scope

- **The Robinhood / 0x path** (`simulateRhParentBuyLeg`, `RhGmgnSwapPanel`) — a different venue with a
  different request shape. The module exposes `purpose` so it can adopt later rather than force-fitting it.
- **The Jupiter swap page** (`JupiterTerminal`) — the quote happens inside the third-party Plugin widget;
  we cannot own it.
- **Changing the execution path.** `/order → /execute` is measured-best and untouched here.
- **Prices, holdings, balances** — `useSolPrice`, `useWalletTokens` and the price caches stay as they are;
  this SPEC is about *swap quotes*, not market data.

## 6. Env

| Var | Default | Purpose |
|---|---|---|
| `QUOTE_ESTIMATE_TTL_MS` | `10000` | how long an `estimate` stays fresh (also the hook's `staleTime`) |
| `QUOTE_DEBOUNCE_MS` | `300` | input debounce before a key is considered settled |

`execute` is never cached, so it needs no TTL.

## 7. Tests

- `quoteKey` includes every input that changes the answer — both mints, amount, slippage, `purpose`,
  taker, priority fee, fee account/bps — and **excludes `purpose: 'execute'` from the cache**.
- `requestQuote` coalesces identical in-flight requests into one upstream call.
- An `estimate` inside its TTL returns from cache and issues **no** request.
- An `execute` is **never** served from cache, even immediately after an identical one.
- A Raptor estimate that fails, or whose impact fails the gate, escalates to the Jupiter picker.
- The engine never calls `throttleJupiterRps` for an `estimate` (asserted by mocking the gate).

## 8. Risks

- **Estimate ≠ execution source.** A Raptor estimate and a Jupiter execution can differ; this is already
  true of the sell surface today. Mitigation: the estimate is labelled by provider, and `execute` always
  re-quotes — the number shown is never the number used.
- **Two caches during migration.** Until step 5, `preparedSwapCache` (8 s) and the engine's estimate cache
  coexist. They must not fight: the engine is the only *display* source, and the prepared cache stays an
  execution-side warm.
- **A shared key across surfaces is a behaviour change** — one surface's refresh now serves another. That
  is the intent (and `useWalletTokens` already documents the same lesson), but each migration needs its
  own freshness check after a trade.

## 9. Verification

1. `npm run verify:no-raw-useeffect && npm run verify:no-hardcoded-sol-price && npm run build`.
2. Focused vitest for `quote-engine`.
3. After the buyer migration: assert that a settled edit on a 5-mint selection issues **no trade-lane**
   call, and that the Jupiter gate is untouched by display traffic.
4. Live: a buy and a sell still confirm, and the displayed estimate still matches what the executor
   reports as `outAmount` within the expected router difference.

---

## 10. Post-ship assessment (2026-10-02)

A read of the trade engine after the batch fixes (`79a59c1`, `256f047`) to answer *"what could we improve,
or is it already good"*. Each finding carries its evidence class, and two of the author's own claims from
this pass are recorded as **retracted** rather than quietly dropped.

### 10.1 Scorecard

| # | finding | verdict | outcome |
|---|---|---|---|
| 1 | "engine half-adopted — `useQuotes` has 0 consumers, buyer reports a raw integer" | **wrong, false premise** | nothing to do — already done (§10.2) |
| 2 | 4 sites hardcode `priorityFeeLamports: 30000`, bypassing the shared fee policy | **real — fixed here** | routed through `TRACKER_AUTO_PRIORITY_FEE` |
| 3 | `skipPreflight: true` leaves the pre-send simulation net empty | **real, latent** | open — a decision, not a default |
| 4 | the arb hop helper is pair-blind while its sibling is marked *do not call* | **real, contained** | open — mitigated by a separate env key |

### 10.2 Retractions — recorded, not dropped

**Finding 1 was wrong in every part.** It claimed the hook was dead code with 7 raw paths remaining, and
that the buyer rendered an unformatted raw smallest-unit integer (`~{solPrefetchOut[mint]}`). Verified
against source on 2026-10-02:

- `useQuotes` **is** consumed — `BulkTokenBuyer.tsx:23` (import) and `:571` (call). The "0 consumers"
  count came from a malformed `grep` pattern (basic `grep` without `-E` cannot express the alternation
  that was intended). **The counter was broken, not the code.**
- The estimate **is** formatted — `formatTokenAmount(quote.outAmount, quote.outDecimals, 4)` at `:590`,
  fed by `buyEstimateByMint` from the engine. A repo-wide search for an unformatted `{…outAmount}` render
  returns **nothing**.
- `solPrefetchOut` **does not exist** in the file. The described badge was not there.

The lesson: a count produced by a search tool is evidence only once the *query* is verified. This one was
not, and it inverted the conclusion. Step 3 of the migration was already complete.

**The comparison written a turn earlier was also wrong in direction.** It argued the simulator's
`SIM_PRIORITY_FEE_QUOTE = 0.00003` might understate the real tip by 100× against the 3,000,000 cap. The
constant is exactly the value the swap path hardcodes (`30000` at four call sites at the time), so the sim
was derived from the code's own number. Measured across 19 real transactions: min 12,000 · **median
20,000** · max 80,000 — the sim is mildly **conservative**, overstating by ~10,000 lamports/tx. The three
3,000,000 outliers were the author's own probe script passing the cap explicitly as a *number*, which maps
to `broadcastFeeType=exactFee` and therefore charges the cap exactly; they are not app behaviour. The cap
is a ceiling, never a spend.

### 10.3 Finding 2 — what the four sites actually were

Not a style gap. A number maps to `exactFee` (charge exactly this) while the resolver's object form maps to
`priorityFeeLamports` + `broadcastFeeType=maxCap` (pay the venue's estimate, never above the ceiling). So
the four sites were fixed **and behaviourally different** from the nine that used the policy. All ten now
resolve through one place, so a `SWAP_PRIORITY_FEE_LAMPORTS` override and the 0.003 SOL cap apply
uniformly. Verified: `priorityFeeLamports: 30000` occurrences in `src/` = **0**.

### 10.4 Still open, ranked

1. **`skipPreflight: true` on the send path** (`swap-executor.ts:517, 527, 561, 613`). Deliberate — the
   simulate-then-send guard added today *is* the simulation. The exposure is a state change between that
   simulation and the send, which nothing catches. Before `79a59c1` the bulk **sell** path had neither net,
   which is exactly how two token→token sells reached chain as failures. Worth an explicit decision.
2. **The arb hop helper.** `getRaptorMaxHops()` carries a *"do not call this to build a quote"* warning;
   `getRaptorMaxHopsArbitrage()` is called to build quotes at three sites (`sol-arb/execute.ts:52,157`,
   `sol-arb/quote.ts:85`) with no such warning. Blast radius is contained by its **own env key**
   (`RAPTOR_MAX_HOPS_ARBITRAGE`), so the desk fix cannot widen it, and SOL-arb pairs touch SOL where one hop
   is right. But the *class* of bug is latent if arb ever routes token→token: the pair-blind value would
   break it identically. The guard covers one function and not the other.
3. **The two landing lanes in a mixed batch.** Raptor-built legs land via Shyft, Jupiter-built legs via
   `/execute`. Correct, but pacing and rate tuning govern only one half.
4. **Stale comments** in `swap-quote-parallel.ts` (its own docstring says Raptor is not queried) and
   `BulkTokenSeller.tsx:455`.

### 10.5 What is already good — and should not be re-litigated

- **Fan-out cancelled on measurement** — +5.0 bps mean / 0 median for 2.59× the swap time. Reopening it
  needs **>25 bps median over ≥100 priced pairs** (§2.10's bar), not a hunch.
- **One execution lane**; Raptor and Lite confined to quoting and display, per their measured failures.
- **Per-pair lane and per-pair hops share one predicate** (`isVerifiedQuoteMint`), so they cannot drift.
- **Priority-fee delegation is correct**, because a DIY `getRecentPrioritizationFees` probe returns 0.
- **The dead Ultra client is gone** — `jupiter-ultra.ts` no longer exists.
- **The simulator agrees with the swap path** on the fee it assumes (this section, §10.2).
