# Swap and Close Operations

This document summarizes how bulk swaps and token account closures work across the project, including provider integrations, token categorization, fees, and metadata enrichment. It consolidates behavior implemented in `src/utils/jupiter.ts` and the UI flows in `src/components/BulkTokenSeller.tsx` and `src/components/BulkTokenBuyer.tsx`.

## Working Stack

| Layer | Service | Files |
|-------|---------|-------|
| Wallet tokens | Jupiter Portfolio | `useWalletTokens.ts`, `jupiter-portfolio.ts` |
| Swaps | Jupiter Ultra order/execute (primary) → Raptor fallback | `jupiter-ultra.ts`, `swap-executor.ts`, `/api/jupiter/ultra/*`, `/api/solanatracker/*` |
| RPC | Same-origin `/api/rpc` proxy | `RpcContext.tsx`, `/api/rpc/route.ts` |
| Prices/metadata | Jupiter APIs (UI support, not swap execution) | `/api/tokens/prices`, `/api/jupiter/metadata` |
| Charts | GMGN iframe embeds only (`gmgn.cc`) | `BulkTokenBuyer.tsx`, `BulkTokenSeller.tsx`, chart pages |
| Close accounts | Jupiter `/reclaim/craft` + fixed fee (manual fallback) | `jupiter-reclaim.ts`, `/api/jupiter/reclaim/craft`, `closeTokenAccounts` |

## Providers and Flow

- **Jupiter Ultra (primary swap execution)**
  - Order: `POST /api/jupiter/ultra/order` → `POST https://ultra-api.jup.ag/order?…&clientPlatform=jupiter.web.home_page`
  - Execute: `POST /api/jupiter/ultra/execute` → `POST https://ultra-api.jup.ag/execute?clientPlatform=jupiter.web.home_page` with `{ signedTransaction, requestId }`
  - Implementation: `prepareSwapTransaction`, `submitSignedSwap` in `src/utils/swap-executor.ts`; used by `executeBulkBuy`, `executeBulkSellAlt`, `getSwapQuote`, `getSwapTransaction`

- **Solana Tracker Raptor (fallback)**
  - Quote: `GET /api/solanatracker/quote` → Raptor `GET /quote`
  - Swap: `POST /api/solanatracker/swap` → Raptor `POST /quote-and-swap`
  - Send: `POST /api/solanatracker/send` → Raptor `POST /send-transaction` (RPC fallback if send fails)
  - Used when Ultra order/execute fails

- **GMGN (charts only)**
  - Embedded `gmgn.cc` iframes on `/buy` and `/sell` for price charts
  - No GMGN swap execution in bulk flows

- **Jupiter Reclaim (bulk close)**
  - Craft: `POST /api/jupiter/reclaim/craft` → `https://ultra-api.jup.ag/reclaim/craft` with `{ owner, mints }`
  - Returns a base64 transaction; appends fixed **0.001 SOL × account** close fee (+ sell fee when post-swap)
  - User signs once; transaction sent via `/api/rpc`
  - Fallback: manual burn + close in `closeTokenAccounts` if craft fails

- **Single-token / signals paths**
  - `getSwapQuote` uses Raptor quote (for UI previews)
  - `getSwapTransaction` uses Ultra first, Raptor fallback via `swap-executor.ts`
  - No lite-api swap execution

- **Single-token UI**
  - `CatchTheCoinClient.tsx` sells via Jupiter utilities (quote + swap) but does not auto-close the token account after selling. Closing is handled in bulk flows.

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

## Fees

The system implements a centralized fee configuration in `src/utils/jupiter.ts`:

- **Sell Fees:** **0.5%** of the SOL received from the swap.
- **Buy Fees:** **0.5%** of the SOL budget used for the buy.
- **Close Fees:** **0.001 SOL** (fixed) per successful close operation.
- **Distribution:** All fees are currently routed to the **Dev Wallet**. The referral split is set to 0%.

## Edge Cases and Safeguards

- **Frozen tokens**: Automatically excluded from swaps and closes; added to failed lists.
- **Pump.fun tokens**: Same unified close path as other tokens — burn remaining balance if needed, then close.
- **Missing accounts**: `getAccountInfo` returns null or RPC "could not find account" → counted as already closed (success).
- **Account validation**: `closeTokenAccounts` validates account existence and data length, and re-checks frozen state from raw account data.
- **Batch mechanics**: Bulk flows sign and submit transactions in batches with retries and confirmation checks.

## Operational Guidance

- Use close-only for zero-balance or micro-value tokens (`usdValue < 0.001`) to avoid unnecessary swaps.
- After swapping valuable tokens, rely on auto-close behavior for 100% sells; otherwise, close-only can be triggered separately.
- After a 100% Raptor sell, close should succeed even if the ATA was already reclaimed.

## References

- Core logic: `src/utils/jupiter.ts` (`executeBulkSellAlt`, `executeBulkBuy`, `closeTokenAccounts`, `closeZeroBalanceTokens`, `categorizeUserTokens`, `enrichTokenMetadataAsync`).
- UI integration: `src/components/BulkTokenSeller.tsx` (`handleBulkSell`, `handleCloseOnly`), `src/components/BulkTokenBuyer.tsx` (bulk buy).
- Single token UI: `src/components/CatchTheCoinClient.tsx` (sell-only path using Jupiter).
- Swap Tracking: `src/utils/trading-tracker.ts`.

## Code References by Step

- Token Discovery & Categorization
  - `src/utils/jupiter.ts` — `fetchUserTokens`, `categorizeUserTokens`, `fetchZeroBalanceTokens`.
  - `src/components/BulkTokenSeller.tsx` — UI selection: `selectedTokens`, `selectedZeroBalanceTokens` management.

- Quote & Route Selection
  - `src/components/BulkTokenSeller.tsx` — `fetchQuoteForToken` via `/api/solanatracker/quote`; helpers `getQuoteForToken`, `isQuoteValid`.
  - `src/utils/jupiter.ts` — `executeBulkBuy` uses Raptor quote-and-swap.
  - `src/components/CatchTheCoinClient.tsx` — `fetchSellQuotes` and hover-driven quoting using `getSwapQuote`.

- Transaction Building
  - `src/utils/jupiter.ts` — `executeBulkSellAlt`, `executeBulkBuy` via Raptor `/api/solanatracker/*`.

- Fee Calculation & Attachment
  - `src/utils/jupiter.ts` — `calculateFeeDistribution`, `getFeeForOperation`, `createJupiterFeeInstructions`, `createFeeTransferInstructions`, `getFeeInfo`.
  - `src/components/CatchTheCoinClient.tsx` — Uses `createFeeTransferInstructions` inside `handleSellToken`.

- Signing, Submission & Confirmation
  - `src/utils/jupiter.ts` — `executeBulkSellAlt`, `executeBulkBuy`: batch `signAllTransactions`, Raptor send + poll, RPC fallback for send.
  - `src/components/CatchTheCoinClient.tsx` — `handleSellToken`: `signAllTransactions`, `sendRawTransaction`, `confirmTransaction`.

- Post-Swap Account Closure
  - `src/utils/jupiter-reclaim.ts` — `craftReclaimTransaction`, `injectInstructionsIntoVersionedTransaction`.
  - `src/app/api/jupiter/reclaim/craft/route.ts` — server proxy to Jupiter Ultra reclaim API.
  - `src/utils/jupiter.ts` — `closeTokenAccounts`: Jupiter reclaim primary; manual fallback; missing ATA → success.
  - `src/utils/jupiter.ts` — `closeZeroBalanceTokens`: same Jupiter-first pattern for unsellable tokens.
  - `src/components/BulkTokenSeller.tsx` — Auto-close after 100% sells via `executeBulkSellAlt` close path.

- Close-Only Operations
  - `src/components/BulkTokenSeller.tsx` — `handleCloseOnly`: calls `executeBulkSellAlt` with `tokens: []` and `unsellableTokens`.
  - `src/utils/jupiter.ts` — `closeZeroBalanceTokens`, `fetchZeroBalanceTokens` for identifying candidates.

- Tracking & History
  - `src/utils/trading-tracker.ts` — `trackJupiterSwap` for swap history and analytics.
  - `src/components/BulkTokenSeller.tsx` — `trackClose` invocation after close-only operations; merges close results into bulk sell results.

- Safeguards & Edge Handling
  - `src/utils/jupiter.ts` — `categorizeUserTokens` for classification; `closeTokenAccounts` for freeze checks and account validation.
  - `src/utils/jupiter.ts` — Batch construction, timeouts, and retry logic inside bulk flows.
