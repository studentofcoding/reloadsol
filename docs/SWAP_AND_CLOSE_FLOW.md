# Swap and Close Operations

This document summarizes how bulk swaps and token account closures work across the project, including provider integrations, token categorization, fees, and metadata enrichment. It consolidates behavior implemented in `src/utils/swap-executor.ts`, `src/utils/jupiter.ts`, and the UI flows in `BulkTokenSeller.tsx`, `BulkTokenBuyer.tsx`, and signals tabs.

## Working Stack

| Layer | Service | Files |
|-------|---------|-------|
| Wallet tokens | Shyft `all_tokens` (cached), Jupiter Portfolio fallback | `useWalletTokens.ts`, `sol-wallet-holdings.ts`, `shyft-wallet.ts` |
| Multi-tx send | Shyft `send_many_txns` (RPC fallback per tx) | `swap-executor.ts`, `shyft-transaction.ts` |
| Swaps (desk) | **Jupiter Swap V2 `/order`**, falling back to **Jupiter Lite** only when V2 fails; impact-gated; that provider prepares | `swap-executor.ts`, `swap-quote-pick.ts`, `jupiter-swap-quote.ts`, `jupiter-lite-swap.ts` |
| Swaps (arb) | **Raptor** with a hops override (`maxHops` set) | `swap-executor.ts`, `solanatracker-raptor.ts` |
| RPC | Same-origin `/api/rpc` proxy (fallback send only) | `RpcContext.tsx`, `/api/rpc/route.ts` |
| Prices/metadata | Jupiter APIs (UI support, not swap execution) | `/api/tokens/prices`, `/api/jupiter/metadata` |
| Charts | GMGN iframe embeds only (`gmgn.cc`) | Bulk pages, chart pages |
| Close accounts | Jupiter `/reclaim/craft` + fixed fee (manual fallback) | `jupiter-reclaim.ts`, `/api/jupiter/reclaim/craft`, `closeTokenAccounts` |

## Directional (desk) swap quote

**Two entry points, and they are not the same call.** A *surface* asks `getSwapQuote`
(`src/utils/jupiter.ts`) — a display estimate, routed through the shared quote engine
(`src/utils/quote-engine.ts`, [SPEC](specs/SPEC-quote-engine-v1.md)) and never on the execution lane. The
*executor* asks `fetchSwapQuote` / `prepareSwapTransaction` **without** `maxHops`, which is
**Jupiter-only**, gated by absolute price impact (`SWAP_QUOTE_MAX_IMPACT_PCT`, default **15%**):

1. **Jupiter Swap V2** — `api.jup.ag/swap/v2/order` (proxied `/api/jupiter/quote`; needs `JUPITER_API_KEY`). This is the primary and, normally, the only candidate.
2. **Jupiter Lite** — `lite-api.jup.ag/swap/v1/quote` (proxied `/api/jupiter/lite/quote`), queried **only when V2 fails**.

**Raptor is not queried on the desk path.** `prepareSwapTransaction` sends `maxHops != null` to
`prepareArbSwap` (Raptor plus the hops override) and everything else to `prepareDeskSwap`
(`prepareJupiterSwapPrepared`, then Lite). `TRADE_PROVIDER` / `getTradeProvider()` selects the
arb/legacy send stack — it does not move desk swaps onto Raptor.

`collectSwapQuoteCandidates` (`src/utils/swap-quote-parallel.ts`) therefore usually returns a single
candidate; `pickBestSwapQuote` (`src/utils/swap-quote-pick.ts`) filters by the impact gate and orders
by highest `outAmount`, then lower impact, then `PROVIDER_TIE_RANK` (raptor → jupiter_lite →
jupiter_swap — the Raptor rank is unused while only Jupiter is collected). Fail-soft: a 429 on V2
does not fail Lite.

**Every display surface quotes through the shared engine, not a local fetch.** `getSwapQuote` is the one
function the signals tab's buy/sell hovers and the PnL tracker's sell estimate already go through, so it now
routes into `src/utils/quote-engine.ts` and adapts the result back with `solanaQuoteToSwapQuote` — those
callers share **one keyed entry** instead of fetching the same sell estimate independently on the Jupiter
background lane. The bulk buyer's and seller's estimates ask the engine directly.

An `estimate` quote is **Raptor first** — ungated, and it answers a whole batch in well under a second —
escalating to the picker above **only when Raptor is unavailable or its own impact fails the gate**.
`purpose: 'execute'` is a different lane entirely (see the desk path above) and is never cached. Because a
raw `outAmount` is a smallest-unit integer, an estimate also carries **`outDecimals`** for the output mint —
read from the same cached mint-account call that answers the transfer-fee question, so it costs no extra
lookup — and a surface shows **nothing** when the mint cannot be read rather than guessing an exponent.

The engine resolves Raptor's hop ceiling **per pair** too, which is what fixed the token→token 500 below.
That guardrail is load-bearing: at `maxHops=1` a two-pool token quotes a single-hop, 38%-impact route,
2.46 SOL below the executable route and above the gate — a sale the executor would refuse.

**Measured on prod 2026-10-01, a single global hop value is the wrong shape.** At `maxHops=1` a
**token→token** pair does not quote badly, it fails outright:

```
500 {"error":"Failed to get quote: No direct route found and maxHops=1"}
```

At `maxHops=2` and `3` the same pair quotes `200`. A route through SOL / USDC / USDT *does* have a
direct pool and returns `200` at `1`. The failure was not cosmetic: Raptor 500 → the surface escalated
to the Jupiter picker → those escalations spent the 0.5 rps keyed budget → the *prepare* was then rate
limited too and fell back to a Lite lane that is per-IP banned on this host. One wrong hop count, a 429
cascade.

So the ceiling is resolved **per pair** in `src/utils/raptor-hops.ts`:
`resolveRaptorHops(inputMint, outputMint)` returns `RAPTOR_MAX_HOPS` (1) when either side is a verified
quote mint — SOL, USDC or USDT — and `RAPTOR_TOKEN_TOKEN_HOPS` (3) when neither is. Every Raptor quote
and swap build goes through it, so a caller that omits `maxHops` can no longer pick the wrong value.
Route selection is still where a better price comes from; the hop ceiling is now just correct per pair.

**That verified-mint assumption is direction-dependent — measured 2026-10-01.** It holds for token→SOL,
but on **SOL→token** (a buy) **8 of 40 real mints had no direct SOL pool** and answered
`500 "No direct route found and maxHops=1"`; all 8 quoted fine at 2. So the pair alone cannot tell you
which way it will go. A no-route answer now triggers **one wider retry on the free lane**
(`escalateRaptorHops`), which is strictly better than what happened before: escalating to the keyed Jupiter
picker spent the 0.5 rps execution budget on a *display* quote — the same cascade described above.

**Cost of the estimate, measured.** Quoting the picker per selected token is what made **bulk** slow:
5 tokens took **14.87s** wall (one token 14.87s) against **0.69s** on Raptor, because each picker call
is one Jupiter background-lane request and that lane is capped and shared with in-process callers (the
sims and price lookups never appear in the nginx logs). A per-token estimate fan-out is therefore a
Jupiter-budget decision, not a UI detail.

### Rate control (`src/utils/jupiter-rps.ts`)

One **token bucket** refilled at `JUPITER_MAX_RPS` (default **0.5**, the measured-clean rate), capacity
`JUPITER_BURST` (default **8** — the measured tolerance: *"~6 rps sequential — 8 ok, then 429"*), with
**priority lanes**:

- **trade** — a taker-scoped `/order` prepare, `/execute`, a Lite `/swap` build — may spend the whole
  bucket.
- **background** — price lookups, sim sampling, UI quotes — yields whenever trade work is waiting and
  must leave `JUPITER_TRADE_RESERVE` (default 2) tokens untouched.

Fixed 2s spacing was the previous design and cost every caller 2s per queued request: three concurrent
callers measured **2.01 / 4.00 / 5.98s**, and one prepare took **1.76s** instead of 0.21s. Repeats are
coalesced and cached — `withJupiterOrderQuote`, `JUPITER_QUOTE_CACHE_MS` (default 4000) — keyed on every
input (mints, amount, slippage, taker, fees). A **taker-scoped request is never cached or coalesced**,
so the execution's prepare is always live.

**Known nuances.** The estimate quotes without `taker` while prepare adds one, so the two are not
byte-identical and the number can shift slightly at click time (the executor re-quotes at prepare, so
nothing unsafe executes). The **warm** (`warmResolvedPreparedSwap`) is a taker-scoped prepare, so it draws
the same 0.5 rps lane an execution needs — which is why it fires on **intent** rather than on every edit:
1.5 s of idle on the form, or immediately when the pointer or keyboard reaches the action button
(`src/hooks/useWarmOnIntent.ts`, once per distinct set of inputs). `SWAP_PREPARE_TTL_MS` is **8s**, so even a
fired warm is often stale by click time and the click rebuilds; nothing may depend on a cache hit, which is
what makes a missed trigger cost latency only. **Token → token sells** use the same path: `sellOutputMint`
resolves the custom output with its own
symbol/decimals, and `swapPrepareCacheKey` includes `outputMint`, so a native-output swap can never be
reused for a token-output quote.

## Raptor Swap Flow (arb only — `maxHops` set)

Per [Solana Tracker Swap API](https://docs.solanatracker.io/guides/swap-api):

1. **Prepare** — `POST /quote-and-swap` (via `/api/solanatracker/swap`) with `userPublicKey`, mints, amount, slippage, platform fee
2. **Sign** — wallet signs returned `swapTransaction` (base64 v0 tx)
3. **Submit** — **our own RPC**, not Raptor's. `submitSignedSwap` tries Shyft, then falls back to
   `connection.sendTransaction` (`skipPreflight: true`, `maxRetries: 2`). Raptor's `POST /send-transaction`
   is **kept in the tree but not used** (§3 of the routing SPEC, locked 2026-10-01): it answered `200`
   **plus a signature** for transactions that never reached the chain (0/3 then 0/4 reproduced), and
   `sendRaptorTransaction` has **no caller** — audited 2026-10-01 (T13). Wiring it up would mean verifying
   on-chain, not reading the response
4. **Confirm** — poll `/transaction/{signature}` until `confirmed` | `failed` | `expired`

### Shared helpers (`src/utils/swap-executor.ts`)

| Helper | Purpose |
|--------|---------|
| `getSwapQuote` | **Surface entry** — routes into the quote engine as `purpose: 'estimate'` and adapts the result back; the signals hovers and the PnL sell estimate come through here |
| `fetchSwapQuote` | Jupiter V2 (`/order`, no taker), Lite only if V2 fails; impact gate; pick winner. The engine's escalation path, and what the executor uses |
| `prepareSwapTransaction` | Desk → Jupiter V2 (Lite fallback); arb (`maxHops`) → Raptor hops path |
| `submitSignedSwap` | Shyft send or RPC; Raptor status poll only if tx was Raptor-built |
| `executeClientSwap` | Single-tx: prepare → sign → submit → confirm |
| `signTransactionsWithFallback` | Batch sign; one-by-one fallback on wallet reject |
| `prepareBulkSwapTransaction` | Bulk buy/sell tx + metadata |

**Do not** call `connection.sendRawTransaction` on Raptor-built txs except via `submitSignedSwap` RPC fallback.

### Call sites

- **Bulk buy/sell** — `executeBulkBuy`, `executeBulkSellAlt` in `jupiter.ts`
  (`executeBulkSellAlt` takes optional `outputMint` / `outputDecimals`; default
  wrapped SOL. Full `/sell` can set a custom mint; PnL Fast Sell and compact
  Reload do not.)
- **Signals** — `LiveTab.tsx`, `BoardTab.tsx` via `executeClientSwap`
- **Server bots** — `trade-executors.ts`, `sl-tp-tracker.ts`, `/api/trending/track`, `/api/buy`
- **Chart page buy** — `executeBulkBuy` (tracking via `tradingTracker` directly)

## Providers and Flow

- **Solana Tracker Raptor (arb swaps; not the desk)**
  - Quote: `GET /api/solanatracker/quote` → Raptor `GET /quote` (`maxHops` defaults to the pair policy
    in `src/utils/raptor-hops.ts` — `RAPTOR_MAX_HOPS` for a route touching SOL/USDC/USDT,
    `RAPTOR_TOKEN_TOKEN_HOPS` otherwise; callers may override per request)
  - Swap: `POST /api/solanatracker/swap` → Raptor `POST /quote-and-swap`
  - Send: **our RPC**, via `submitSignedSwap` (Shyft → RPC fallback). Raptor's `/api/solanatracker/send` →
    `POST /send-transaction` is **kept but has no caller** — a 200 + signature from it was not a landing
    (T13), so wiring it up means verifying on-chain, not reading the response
  - Status: `GET /api/solanatracker/transaction/[signature]` (Raptor-built txs)
  - Env: `RAPTOR_API_BASE` (optional). Platform fee is **always 25 bps (0.25%)**
    to the buy_bulk treasury (`feeAccount` / `feeBps` via `src/utils/buybulk-fee.ts`);
    clients cannot omit or override it.

- **Jupiter Lite (desk fallback — only when V2 fails)**
  - Quote: `GET /api/jupiter/lite/quote` → `lite-api.jup.ag/swap/v1/quote`
  - Swap build: `POST /api/jupiter/lite/swap` → `POST /swap`
  - Shares `throttleJupiterRps` with Price V3 / Swap `/order` on the server

- **Jupiter Swap `/order` (desk primary)**
  - Quote: `GET /api/jupiter/quote` → `api.jup.ag/swap/v2/order` (no `taker`)
  - Prepare: same URL with `taker` = user pubkey (unsigned `transaction`)
  - Requires `JUPITER_API_KEY`; send still uses Shyft/RPC like Lite

- **Jupiter Ultra Reclaim (close only — not swaps)**
  - Craft: `POST /api/jupiter/reclaim/craft` → reclaim API
  - User signs once; transaction sent via `/api/rpc`

- **GMGN (charts only)**
  - Embedded `gmgn.cc` iframes; no GMGN swap execution

- **Jupiter Terminal (`/swap` page only)**
  - Widget script loaded on `/swap` only (not global layout)

## Token Categorization

Defined in `categorizeUserTokens` (`src/utils/jupiter.ts`):

- `sellable`: Tokens where `usdValue >= 0.001` or flagged as sellable (e.g., Pump.fun categorization for quoting).
- `unsellable`: Non-zero balance tokens with `usdValue < 0.001` and other constraints.
- `zeroBalance`: `uiAmount <= 0.000000000001`.
- `frozen`: Tokens flagged as frozen are excluded from both swaps and closes.
- `nfts`: Tokens identified as NFTs.

## Metadata Enrichment

Implemented in `enrichTokenMetadataAsync` (`src/utils/jupiter.ts`), the system enriches token metadata (symbol, name, logo) without blocking the main UI or swap flows.

- **Behavior:**
  - Asynchronous and non-blocking: The UI loads tokens immediately with "Unknown" placeholders, and metadata populates as it becomes available.
  - **Batching:** Processes tokens in batches of **10** to respect API rate limits.
  - **Throttling:** Adds a **500ms** delay between batches.
  - **Caching:** Enriched metadata is cached in `tokenCache` to prevent redundant fetches.
  - **Triggers:** Automatically triggered after `fetchUserTokens` completes its initial pass.

## Close-Only Operations

- Entry points: `handleCloseOnly` in `BulkTokenSeller.tsx` and `closeZeroBalanceTokens` in `src/utils/jupiter.ts`.
- Behavior:
  - Primary: Jupiter `/reclaim/craft` batches burn + close for selected mints
  - Fallback: manual burn + close if Jupiter craft fails
  - Frozen tokens are skipped and recorded as failed closes.
  - Missing token accounts (already closed) are treated as success.
  - Fees: **0.001 SOL × account count** via `createFeeTransferInstructions('CLOSE')` in the same signed transaction.

## Post-Swap Closures

- After swaps: If a token is sold 100%, `closeTokenAccounts` is invoked via Jupiter reclaim (manual fallback on failure).
