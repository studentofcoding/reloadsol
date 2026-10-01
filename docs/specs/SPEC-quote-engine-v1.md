# SPEC — One Solana quote engine, and every trade layer derives from it v1

**Status:** implemented (2026-10-01) — steps 1–4 shipped and live on prod; step 5 partly. See §4 for the per-step status and what is deliberately left open.
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
| 5 · delete orphaned caches | **partly** — the seller's local Raptor client and the buyer's `solPrefetchOut` feed are gone. `preparedSwapCache` stays: it is the execution warm, not a display cache |

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
