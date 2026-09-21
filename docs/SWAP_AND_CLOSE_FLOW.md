# Swap and Close Operations

This document summarizes how bulk swaps and token account closures work across the project, including provider integrations, token categorization, fees, and metadata enrichment. It consolidates behavior implemented in `src/utils/swap-executor.ts`, `src/utils/jupiter.ts`, and the UI flows in `BulkTokenSeller.tsx`, `BulkTokenBuyer.tsx`, and signals tabs.

## Working Stack

| Layer | Service | Files |
|-------|---------|-------|
| Wallet tokens | Shyft `all_tokens` (cached), Jupiter Portfolio fallback | `useWalletTokens.ts`, `sol-wallet-holdings.ts`, `shyft-wallet.ts` |
| Multi-tx send | Shyft `send_many_txns` (RPC fallback per tx) | `swap-executor.ts`, `shyft-transaction.ts` |
| Swaps | **Parallel pick:** Raptor (maxHops=1) + Jupiter Lite + Jupiter Swap `/order`; impact-gated; winner’s prepare | `swap-executor.ts`, `swap-quote-pick.ts`, `solanatracker-raptor.ts`, `jupiter-lite-swap.ts`, `jupiter-swap-quote.ts` |
| RPC | Same-origin `/api/rpc` proxy (fallback send only) | `RpcContext.tsx`, `/api/rpc/route.ts` |
| Prices/metadata | Jupiter APIs (UI support, not swap execution) | `/api/tokens/prices`, `/api/jupiter/metadata` |
| Charts | GMGN iframe embeds only (`gmgn.cc`) | Bulk pages, chart pages |
| Close accounts | Jupiter `/reclaim/craft` + fixed fee (manual fallback) | `jupiter-reclaim.ts`, `/api/jupiter/reclaim/craft`, `closeTokenAccounts` |

## Directional swap quote (parallel pick)

`fetchSwapQuote` / `prepareSwapTransaction` (no `maxHops`) race three providers and **gate** by absolute price impact (`SWAP_QUOTE_MAX_IMPACT_PCT`, default **15%**):

1. **Solana Tracker Raptor** — still `maxHops=1` / `RAPTOR_DEFAULT_MAX_HOPS` (do not raise for directional bots)
2. **Jupiter Lite** — `lite-api.jup.ag/swap/v1/quote` (proxied `/api/jupiter/lite/quote`)
3. **Jupiter Swap** — `api.jup.ag/swap/v2/order` (proxied `/api/jupiter/quote`; needs `JUPITER_API_KEY`)

Fail-soft per provider (a 429 on Swap does not fail Lite/Raptor). Winner = highest `outAmount`, then lower impact, then prefer Raptor. Prepare uses that provider: Raptor `quote-and-swap`, Lite `/swap`, or Swap `/order?taker=`. Live arb still passes `maxHops` and keeps the Raptor hops path.

## Raptor Swap Flow (Raptor winner / arb)

Per [Solana Tracker Swap API](https://docs.solanatracker.io/guides/swap-api):

1. **Prepare** — `POST /quote-and-swap` (via `/api/solanatracker/swap`) with `userPublicKey`, mints, amount, slippage, platform fee
2. **Sign** — wallet signs returned `swapTransaction` (base64 v0 tx)
3. **Submit** — `POST /send-transaction` (via `/api/solanatracker/send`)
4. **Confirm** — poll `/transaction/{signature}` until `confirmed` | `failed` | `expired`

### Shared helpers (`src/utils/swap-executor.ts`)

| Helper | Purpose |
|--------|---------|
| `fetchSwapQuote` | Parallel Raptor + Lite + Swap; impact gate; pick winner |
| `prepareSwapTransaction` | Winner’s prepare (arb: `maxHops` → Raptor hops path) |
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

- **Solana Tracker Raptor (swap execution)**
  - Quote: `GET /api/solanatracker/quote` → Raptor `GET /quote` (`maxHops=1` directional)
  - Swap: `POST /api/solanatracker/swap` → Raptor `POST /quote-and-swap`
  - Send: `POST /api/solanatracker/send` → Raptor `POST /send-transaction`
  - Status: `GET /api/solanatracker/transaction/[signature]` (Raptor-built txs)
  - Env: `RAPTOR_API_BASE` (optional). Platform fee is **always 25 bps (0.25%)**
    to the buy_bulk treasury (`feeAccount` / `feeBps` via `src/utils/buybulk-fee.ts`);
    clients cannot omit or override it.

- **Jupiter Lite (directional fallback)**
  - Quote: `GET /api/jupiter/lite/quote` → `lite-api.jup.ag/swap/v1/quote`
  - Swap build: `POST /api/jupiter/lite/swap` → `POST /swap`
  - Shares `throttleJupiterRps` with Price V3 / Swap `/order` on the server

- **Jupiter Swap `/order` (directional fallback)**
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
