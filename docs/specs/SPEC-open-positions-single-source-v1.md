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

- **Step 2** — point `PnLTracker`'s open section at `useOpenPositions`. Not started: it needs
  PnLTracker's open path read end-to-end first (§7).
- **Step 3** — retire the duplicate poll once there is one consumer.

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

### Step 2 — Point `PnLTracker`'s open section at the hook

Replace the inline open-section derivation and the inline pct with `useOpenPositions()`. Keep the
component's existing JSX; only the source of `positions` / `priceChangePct` changes.

**Do not** touch the closed-position path, the share modal, or the outcome modal.

**Gate:** counts match between the bar and PnLTracker's open section for the same wallet — that is the
whole acceptance criterion, and it is checkable side by side in a browser.

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
