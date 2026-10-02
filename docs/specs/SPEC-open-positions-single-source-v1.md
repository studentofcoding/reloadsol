# SPEC — Open positions: one source of truth

**Status:** **Steps 1 and 4 IMPLEMENTED** (`9b70ba5`, shipped). Steps 2–3 remain to-spec.
**Date:** 2026-10-02
**Author:** Command Code (this session)
**Trigger:** "we have now have PnL on watchlist system check and make it one system instead of duality
… it's mostly on open positions so we didn't have 2 system count it"

### Implemented so far

- **Step 1 — done.** `useOpenPositions` (`src/hooks/useOpenPositions.ts`) is the body of
  `useGlobalOpenPositionsBar` lifted verbatim, comments included. That module is now a re-export, so
  its one consumer (`GlobalWatchlistBar`) is untouched. Behaviour-free: no caller or logic change,
  confirmed by tsc/lint/build.
- **Step 4 — done.** `src/hooks/useLocalStorageValue.ts` is built on `useSyncExternalStore`, following
  `useIsClient`. `PnLTracker`'s five preferences are now *derived* rather than initialised-and-restored,
  so the raw effect from `c0ca7a5` is gone. Raw strings in/out keeps the snapshot value-stable; typed
  wrappers preserve the call sites' functional-update shapes.
  **Bug found and fixed on the way:** the hint read `closedPositionsHintDismissed` while the dismiss
  handler wrote `pnl-closed-positions-hint-dismissed` — two keys, so dismissing never persisted. That
  also made five hand-rolled `localStorage.setItem` calls at the call sites redundant, and they are
  removed; a write in two places is how the keys drifted in the first place.

### Still open

- **Step 2 (revised)** — the open path has now been read end-to-end, and the original Step 2 was
  wrong: `openPositions` is a working record with six fields the hook does not return, three of which
  the **bulk sell** path depends on. The formula half is done (shared `pctFromBaseline`); the
  source-swap half is a view-model migration. See the revised Step 2 below before starting it.
- **Step 3** — retire the duplicate poll. Now depends on the revised Step 2, and PnLTracker's SSE
  stream means it needs a decision rather than a deletion.

---

## 1. The finding

Open positions are currently derived **twice**, in two components that share no code:

| | watchlist bar | `PnLTracker` |
|---|---|---|
| entry | `useGlobalOpenPositionsBar()` | its own inline derivation (~`:998`) |
| candidates | `listLiveOpenBarPositions(records, holdingsByMint)` | `computeOpenTradeCycle(records, mint, 'live')` |
| cost basis | `cycle.weightedBuyPriceUsd` | `cycle.weightedBuyPriceUsd` |
| prices | `POST /api/prices/open/refresh` + `/api/prices/open/stream` | `POST /api/prices/open/refresh` + `/api/prices/open/stream` (`:1902`, `:1942`) |
| pct | `pctFromBaseline(buy, current)` — `utils/watchlist/pct.ts` | inline `((current - buy) / buy) * 100` (`:1814-1822`) |
| poll | `OPEN_BAR_PRICE_POLL_MS = 15_000` | its own interval |

**Evidence that this duality is already load-bearing:** `useGlobalOpenPositionsBar.ts:23` carries the
comment

```
/** Match PnL open marks — `/api/prices/open` (GMGN/Jupiter), not slow 60s Jupiter-only. */
```

Someone had to *hand-align* the bar to PnL's marks. That comment is the defect statement: two systems
whose agreement is maintained by a comment rather than by shared code.

The good news: **every shared piece already exists.** `listLiveOpenBarPositions` and `pctFromBaseline`
are both already extracted, and both surfaces already hit the same price endpoints. So the fix is
**extraction, not invention** — no new module, no new upstream, no new budget.

## 2. What actually diverges

1. **Candidate derivation.** The bar builds its list from `holdingsByMint` (real wallet balances,
   `DUST_UI` floor, quote-mint exclusion, requires a live buy record). `PnLTracker` derives from
   records. Same inputs, two implementations — they can drift.
2. **The percentage.** `pctFromBaseline` returns `null` for a non-positive or missing price; the inline
   copy at `:1814` guards with `if (position.buyPriceUsd && position.buyPriceUsd > 0)`. Close, but
   independently maintained — the classic place a rounding or null-handling change lands in one only.
3. **The poll.** Two intervals against the same two endpoints. Every poll is upstream load.

## 3. The plan

**Goal:** the watchlist owns *open* positions; `PnLTracker` owns *closed* PnL and history. Neither
re-derives what the other owns.

### Step 1 — Extract one hook (no behaviour change)

`src/hooks/useOpenPositions.ts`, lifted from `useGlobalOpenPositionsBar` unchanged:

```ts
export interface OpenPositionsResult {
  positions: OpenBarPosition[]
  priceChangePct: Record<string, number | null>
  enabled: boolean
  refetchHoldings: () => void
}
export function useOpenPositions(): OpenPositionsResult
```

Keep the existing internals verbatim — the `useWalletTokens` default-key comment (`:57-65`, the
"new buys never show up in Open positions" bug), the provisional `open-positions-cache` paint, the
one-poll grace in `visibleOpenBarPositions`, and `useIsClient` for the server/hydration render.

`useGlobalOpenPositionsBar` then becomes a thin re-export, so the bar is untouched.

**Gate:** `tsc`, lint, build, and the bar renders identically. Nothing else moves in this step.

### Step 2 — REVISED: `openPositions` is a working record, not a display list

**The original wording of this step was wrong, and reading the path end-to-end is what showed it.**
It said "replace the inline derivation with `useOpenPositions()`; only the source of `positions`
changes". That would break three live features.

`PnLTracker`'s `openPositions` state (`:179`) is not the hook's `OpenBarPosition[]`. It carries:

| extra field | consumer |
|---|---|
| `id` | bulk sell — `selectedTokens.has(pos.id)` (`:1307`, `:1327`) |
| `isSimulation` | bulk sell — `positionsToSell.some(pos => !pos.isSimulation)` (`:1310`) |
| `currentTokenPriceUsd` | bulk sell — `sellPriceUsd: position.currentTokenPriceUsd` (`:1348`) |
| `pnlPercentage`, `currentUsdValue` | notifications (`:1604`), display |
| `actualWalletBalance`, `walletTokenData` | `refreshWalletBalances` (`:1801`) |
| `isLoadingPrice` | the per-position loading state |

`useOpenPositions()` returns seven fields and none of those. Swapping the source would leave the sell
button reading `undefined` for a price. So Step 2 is **a view-model migration**, not a source swap.

**Revised Step 2:**
1. **Done** (`9b70ba5` + this commit) — share the *formula*. `pctFromBaseline` replaces the inline
   `((current - buy) / buy) * 100` at `:1848`. Verified equivalent: the guards above it
   (`currentTokenPriceUsd > 0` at `:1841`, `buyPriceUsd > 0` at `:1847`) establish exactly the
   positivity that is `pctFromBaseline`'s only null branch. Note `:1886` computes a *different*,
   value-based percentage and is deliberately left alone.
2. **Open** — widen the hook to carry the fields both surfaces need (`currentTokenPriceUsd` at
   minimum; `id`/`isSimulation` are PnLTracker's own view-model concerns and should be *added by*
   PnLTracker on top of the hook, not moved into it). Then `openPositions` becomes a thin mapping
   from `useOpenPositions()` plus PnLTracker's own enrichment.
3. **Open** — only after 2: retire the duplicate price poll (`:1902`, `:1942`) in favour of the
   hook's react-query cache. PnLTracker additionally consumes an SSE stream the hook does not have,
   so this needs its own decision rather than a straight deletion.

**Gate:** unchanged — same wallet, same count, same percentage per mint, side by side in a browser.

### Step 3 — Retire the duplicate poll

With one consumer, one `refetchInterval` remains. Confirm the shared query key means the two surfaces
share a single in-flight request rather than each running its own.

### Step 4 — The `useEffect` question (convention)

`useIsClient` is implemented with `useSyncExternalStore` (`server snapshot = false`, `client = true`) —
the project's idiom for client-only reads. The `PnLTracker` preferences I just changed (commit
`c0ca7a5`) default their state and restore it in a raw effect; the fully-conformant form backs each
preference with `useSyncExternalStore` so no effect is needed. That also means the five **setters**
must write to `localStorage` and notify the store.

Recommend folding Step 4 into Step 2, since both touch `PnLTracker` and both want to be verified in the
same browser pass.

## 4. Non-goals

- Not merging the *price* layer — both surfaces already share `/api/prices/open/*`, and that is working.
- Not touching closed positions, history, the share modal, or the outcome modal.
- Not removing `PnLTracker`. It keeps closed PnL, which is exactly what the user asked to preserve.
- Not changing `computeOpenTradeCycle`, `listLiveOpenBarPositions`, or `pctFromBaseline`.

## 5. Risks

| risk | mitigation |
|---|---|
| `useGlobalOpenPositionsBar`'s comments encode hard-won bugs (cache-key trap, clone-vs-real) | extract verbatim, comments included; do not "tidy" while moving |
| Two surfaces rendering the same list could double-count in a total | the acceptance check is that they *agree*, and any total sums one source |
| Hidden divergence in PnLTracker's open path I have not read end-to-end | Step 1 is behaviour-free; the divergence only becomes visible in Step 2, where it is equally visible to `tsc` and to the browser |

## 6. Verification gate

`npm run lint && npm run verify:no-raw-useeffect && npm run build` — plus a browser check that the bar
and PnLTracker's open section report the same count and the same percentage per mint, which is the
actual requirement and cannot be verified from the repo alone.

## 7. What I am not claiming

I have read `useGlobalOpenPositionsBar` fully and located PnLTracker's open path by grep
(`:998`, `:1814-1822`, `:1902`, `:1942`). I have **not** read PnLTracker's open section end-to-end, so
Step 2's exact diff is an estimate. Step 1 is safe regardless, and it is the step that makes Step 2
small.
