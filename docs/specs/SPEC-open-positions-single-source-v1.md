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

### Step 2 — REVISED AGAIN: the two surfaces are a superset and a filtered view, not duplicates

**This section has now been wrong twice. Both times the fix came from reading the code, not from
reasoning about it. Keep that in mind before acting on the plan below.**

#### What is actually true

| | watchlist bar (`useOpenPositions`) | `PnLTracker.openPositions` |
|---|---|---|
| real, priced, held opens | **yes** | yes |
| simulation positions | **no** | yes (`isSimulation`, `simulationType`) |
| bot-operation positions | **no** | yes (`isBotOperation`, `botStrategy`) |
| external / wallet-only holds | **no** — `listLiveOpenBarPositions` requires `weightedBuyPriceUsd > 0`, and `visibleOpenBarPositions` hides unpriced | yes, pushed in at `:1096` with `buyPriceUsd: 0` |
| price cadence | react-query, `/api/prices/open/refresh`, **15 s**, no stream | `/api/prices/open/refresh` **plus** `/api/prices/open/stream` SSE with a **5 s** poll fallback (`:1930-1994`) |

The bar's list is therefore a **strict subset** of PnLTracker's. `PnLTracker` is the superset: it
starts from the tracked cycles and then *adds* wallet tokens that no cycle covers (`:1080-1117`,
"bought by bot or outside app") while *pruning* ghost/sold ones by holdings (`:1075`).

**So "point PnLTracker at `useOpenPositions()`" is backwards.** It would delete simulation
positions, bot-operation positions, and external wallet holds from the PnL panel — a functional
regression dressed as a de-duplication. That is the opposite of the goal.

#### What the duplication actually is

Not "the same set computed twice". It is:

1. **Two derivations of the same primitives.** Both call `computeOpenTradeCycle` and both prune
   against holdings, but through different helpers (`listLiveOpenBarPositions` vs the inline
   `pruneOpenPositionsByHoldings` path) and against **different holdings sources** — the bar uses
   `useWalletTokens` (browser react-query), PnLTracker uses `fetchSolWalletHoldings` with an RPC
   fallback (`:1055-1071`). Same question, two answers.
2. **Two pollers against one route.** Both POST `/api/prices/open/refresh`. PnLTracker adds the SSE
   stream. The bar's 15 s poll is redundant *load*, not redundant truth.
3. **~~Two percentage formulas~~** — fixed (shared `pctFromBaseline`).

#### The corrected direction

**Investigated (2026-10-02, second pass). The "holdings-source fork" is not a fork.** Both surfaces
reach the *same* function:

```
                    fetchSolWalletHoldings(wallet, {enrichPrices})      (utils/sol-wallet-holdings.ts)
                       Shyft all_tokens  →  Jupiter Portfolio fallback
                          /                                  \
    enrichPrices: true   /                                    \   enrichPrices: false
                        /                                      \
  useWalletTokens                                  PnLTracker :1055
  (TanStack, staleTime 30s, shared                  (imperative, inside the
   key, refetchFresh)                                async PnL recompute, uncached)
```

`useWalletTokens`'s `fetchWalletTokens` (`useWalletTokens.ts:51`) calls `fetchSolWalletHoldings`
directly. So this is **one source, two access paths**, and the only difference is caching:

| | bar | `PnLTracker` |
|---|---|---|
| upstream | Shyft `all_tokens` → Jupiter fallback | identical |
| cache | TanStack, `staleTime: 30_000`, one key per wallet, in-flight de-dup, `refetchFresh()` bypasses the proxy's 15 s cache | **none** — called imperatively on every PnL recompute |
| `enrichPrices` | `true` (adds a `/api/tokens/prices` round trip) | `false` |

So PnLTracker **re-fetches what the bar already has cached**, and a post-trade `refetchFresh()`
reaches the bar but cannot reach PnLTracker's separate imperative call.

**The population difference is a different thing and is intentional.** `PnLTracker` adds sim, bot
and external categories *on top of* tracked cycles (`:1080-1117`); the bar renders a filtered view.
That difference is by design and must not be flattened — which is what the previous version of this
section got wrong.

#### Revised plan

1. ✅ Share the percentage formula (`19f59a1`).
2. ✅ **DONE (`4e1fa8d`)** — `PnLTracker` reads the shared `useWalletTokens` entry instead of calling
   `fetchSolWalletHoldings` imperatively at `:1055`. The direct fetch and its RPC fallback are kept
   for the cold path, so the change is additive. **Option B was chosen**, and not as a compromise:
   `enrichPrices` is hardcoded `true` inside `fetchWalletTokens`, not a per-caller option, so
   "skipping" it (option A) would have changed the shared query for all twelve
   `useWalletTokens` consumers — including the `categorizeUserTokens` dust/zero-value lists that
   the dust filtering depends on. Reading the already-cached entry adds **zero** upstream calls and
   removes PnLTracker's own uncached Shyft round trip per recompute, plus it lets a post-trade
   `refetchFresh()` reach the panel for the first time.
3. **Do not** flatten the populations. The bar stays the filtered view; `PnLTracker` stays the
   superset. Whether the *classification* should also be extracted is a separate, lower-value job —
   parked.
4. ✅ **DONE (`07dbca6` + `9cf9a78`)** — `open-price-stream.ts` is the shared transport: ONE
   `EventSource`, re-opened with the **union** of subscribers' mints (the bar's set and PnLTracker's
   superset genuinely differ, so a single subscriber's set serves neither). Both surfaces now consume
   it; `grep "new EventSource"` across the app returns exactly one hit — the module.

   The bar gets near-realtime prices instead of a 15 s poll. PnLTracker's private `EventSource` and
   its 5 s `startPollFallback` are both gone; the react-query safety net at `:2009` still re-polls
   unconditionally at 15 s, so the stream-is-dead case stays covered without a second timer.

   Two things the wiring had to get right, both of which would have caused a reconnect storm: the
   subscriptions key on the sorted mint-set **string**, not the array (`openPositions` is replaced on
   every price tick, so an array dependency resubscribes continuously — and since the module
   refcounts, each unsubscribe closes the socket before the next subscribe reopens it); and
   PnLTracker's handler goes through a **ref**, because depending on `applyOpenPrices`'s identity
   would do the same.

   The bar keeps its 15 s poll underneath the stream (`pricesQuery` untouched, stream merges and wins
   per-mint), so a stream that never connects degrades to exactly the old behaviour.

**What changed my mind twice:** the first two versions of this section treated the two surfaces as
one computation done twice. They are not. They share one holdings *source* and differ in
*caching* — while their *populations* differ by category on purpose. Reading the other side is what
showed it both times.

**Gate:** unchanged — same wallet, and every category (real, sim, bot, external) present on
PnLTracker with the same percentage, while the bar's visible list is byte-identical to today's.

#### Why this section keeps being wrong

Both earlier versions were written from a partial read of one side. The correction each time came
from reading the other side end-to-end. The lesson for whoever picks this up: neither
`useOpenPositions` nor `openPositions` is the whole story, and the populations differ by *category*,
not by accident.

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
