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

**Display surfaces must use this same picker.** A quote shown to a user (`BulkTokenSeller`'s
estimate) has to be the candidate `prepareSwapTransaction` would trade. Quoting Raptor alone showed a
single-hop, 38%-impact route for a two-pool token — 2.46 SOL below the executable route **and**
above the gate, i.e. a sale the executor would have refused. `RAPTOR_MAX_HOPS` staying at its default
`1` is deliberate: the conservative single-hop default is right for thin tokens, and route selection,
not the hop ceiling, is where a better price comes from.

**Known nuances.** The estimate quotes `/order` without `taker` while prepare uses
`/order?taker=<pubkey>`, so the two are not byte-identical inputs and the number can shift slightly at
click time (the executor re-quotes at prepare, so nothing unsafe is executed). The failure banner in
`sell-quote-fallback.ts` still says *"Failed to get quotes from Raptor"*, which misattributes the
source now that this path is Jupiter-only.

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
