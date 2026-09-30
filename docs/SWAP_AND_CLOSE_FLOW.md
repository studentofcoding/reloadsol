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

The desk path — `fetchSwapQuote` / `prepareSwapTransaction` **without** `maxHops` — is
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

**A display surface quotes the venue that will execute.** `BulkTokenSeller`'s estimate asks **Raptor
first** — ungated, and the venue `prepareSwapTransaction` builds with `RAPTOR_DEV_FEE_ACCOUNT` — and
escalates to the picker above **only when Raptor is unavailable or its own impact fails the gate**.
That guardrail is load-bearing: at `RAPTOR_MAX_HOPS=1` a two-pool token quotes a single-hop,
38%-impact route, 2.46 SOL below the executable route and above the gate — a sale the executor would
refuse. `RAPTOR_MAX_HOPS` staying at `1` is deliberate; route selection, not the hop ceiling, is where
a better price comes from.

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
nothing unsafe executes). The prefetch window is short — `SWAP_PREPARE_TTL_MS` is **8s** — so a
page-load prefetch is usually stale by click time and the click rebuilds; the estimate cannot rely on
it. **Token → token sells** use the same path: `sellOutputMint` resolves the custom output with its own
symbol/decimals, and `swapPrepareCacheKey` includes `outputMint`, so a native-output swap can never be
reused for a token-output quote.

## Raptor Swap Flow (arb only — `maxHops` set)

Per [Solana Tracker Swap API](https://docs.solanatracker.io/guides/swap-api):

1. **Prepare** — `POST /quote-and-swap` (via `/api/solanatracker/swap`) with `userPublicKey`, mints, amount, slippage, platform fee
2. **Sign** — wallet signs returned `swapTransaction` (base64 v0 tx)
3. **Submit** — `POST /send-transaction` (via `/api/solanatracker/send`)
4. **Confirm** — poll `/transaction/{signature}` until `confirmed` | `failed` | `expired`

### Shared helpers (`src/utils/swap-executor.ts`)

| Helper | Purpose |
|--------|---------|
| `fetchSwapQuote` | Jupiter V2 (`/order`, no taker), Lite only if V2 fails; impact gate; pick winner |
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
  - Quote: `GET /api/solanatracker/quote` → Raptor `GET /quote` (`maxHops` defaults to
    `RAPTOR_MAX_HOPS`; callers may override per request)
  - Swap: `POST /api/solanatracker/swap` → Raptor `POST /quote-and-swap`
  - Send: `POST /api/solanatracker/send` → Raptor `POST /send-transaction`
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
