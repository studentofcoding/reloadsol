# ReloadSOL — Product & Trading

Condensed, codebase-accurate overview of what ReloadSOL is, which networks it trades
on, the trading surfaces, per-network/wallet swap execution, and the receipt-gated
trade-confirmation lifecycle. Sources: `README.md`, `docs/Overview.md`,
`docs/SWAP_AND_CLOSE_FLOW.md`, `docs/ARCHITECTURE_SUMMARY.md`, plus the component and
util files cited inline.

## 1. What ReloadSOL is

**ReloadSOL** is a **dual-chain memecoin trading platform** — a Next.js web app with
Go cron workers and Docker Postgres/Redis — running on **Solana mainnet** and
**Robinhood Chain** (an EVM chain, id `4663`, native ETH). It combines **manual
trading** (bulk buy/sell, single swaps, PnL tracking, wallet operations on both
chains), **automated strategies** (trending bot, signals paper trading, Meteora DLMM
and RH v3/v4 CLMM liquidity agents), and a **research loop** (paper sims → labeled
outcomes → ML shadow scoring). Core value: buy or sell **many tokens in one flow**,
watch PnL live, and let bots/dashboards surface and track opportunities. All data
lives in Docker Postgres `reloadsol_db` (Supabase cut off).

## 2. Networks: `sol` and `robinhood`

The product is split by an **app-network switch**: the client stores
`reloadsol.appNetwork` in localStorage and exposes `AppNetwork = 'sol' | 'robinhood'`
(`src/utils/app-network.ts`, `src/contexts/AppNetworkContext.tsx`). Route gating uses
`routeSupportsNetwork` against a trade-route registry (`src/config/route-network.ts`);
API routes mirror it with `parseDbChain` / chain-scoped reads, and shared user-data
tables carry a `chain` column (migration `db/init/23-app-network-chain.sql`).

**Robinhood (RH) is gated to dev wallets.** Access is granted when an EVM/Rabby
provider is present, or the connected Sol *or* EVM address is a dev wallet
(`DEFAULT_DEV_WALLETS` in `src/utils/dev-wallet.ts` — includes one `0x…` EVM dev
wallet) or sits on the `RH_WHITELIST` env allowlist (`canUseRobinhoodNetwork` in
`src/utils/rh-whitelist.ts`). Without access, `coerceAppNetwork` flips a manual RH
selection back to `sol`.

## 3. Core trading surfaces

| Surface | Route | What it does | Key files |
|---|---|---|---|
| Bulk buy | `/buy` (`/buy/solana`, `/buy/robinhood`) | Buy up to the chain-specific cap (currently **5 RH / 5 Solana**) from one spend amount (SOL on Solana; ETH/USDG/WETH on RH); valid/parsed chips; risk analysis; trending/toast tokens append to the list | `src/components/BulkTokenBuyer.tsx`, `src/components/RiskAnalysis.tsx` |
| Bulk sell / dust sweep / reload | `/sell` | Sell many tokens at once to reload native; dust categories (sellable / unsellable / zero-balance / frozen / NFT); empty-ATA close + rent reclaim via Jupiter reclaim; post-sell 100% closes | `src/components/BulkTokenSeller.tsx`, `src/utils/jupiter.ts`, `src/utils/swap-executor.ts` |
| Single swap | `/swap` (+ solana/robinhood subroutes) | Solana: **Jupiter Terminal** widget with SOL/USDC presets; Robinhood: in-house RhSwap panel (quote-pair or token→token) | `src/app/(trade)/swap/SwapPageClient.tsx`, `src/components/RhGmgnSwapPanel.tsx`, `src/components/JupiterTerminal.tsx` |
| Chart buy modal | modals over charts / signals / trend boards | Quick single-token buy from any chart surface, keyboard navigable | `src/components/ChartBuyModal.tsx` |
| Token search (dev) | `/dev/search-token` (`/solana`, `/robinhood`); map at `/dev/search-token/detail?address=&view=` | Name/symbol/CA search; Open map / View chart go to TokenLocateHub (Freeview / List). `/search-token*` and `/dev/token-search` redirect here | `src/components/search/SearchTokenClient.tsx`, `src/components/token-locate/TokenLocateHub.tsx`, `src/components/signals/shared/token-search-href.ts` |
| PnL tracker / history | `/pnl`, `/history` | Open vs completed trades, Real/Sim filters, realized/unrealized PnL, Fast Sell | `src/components/PnLTracker.tsx`, `src/components/TradingHistory.tsx` |

## 4. Swap execution model (per network + wallet)

> **Diagram:** [Trading surfaces → execution → records](./diagrams/01-trading-surfaces.html)
> and the [trade-confirmation lifecycle](./diagrams/02-confirmation-lifecycle.html).

### Solana

- **Solana Tracker Raptor** is the primary executor for bulk buy/sell, chart buys and
  PnL Fast Sell: `prepareSwapTransaction` → wallet signs the returned v0 tx →
  `submitSignedSwap` (Raptor send, RPC fallback only) → poll `confirmed|failed|expired`
  (`src/utils/swap-executor.ts`, `src/utils/jupiter.ts` `executeBulkBuy`,
  `executeBulkSellAlt`, `executeClientSwap`; server proxy `/api/solanatracker/*`).
- **Jupiter** handles pricing/metadata, the wallet token list (Portfolio), the `/swap`
  Jupiter Terminal widget, and account close/reclaim — not the main swap executor.
- **GMGN** on Solana is charts (embedded `gmgn.cc` iframes) plus a dev-only GMGN
  bound-wallet path in the bulk buyer (`useGmgnOnSol`); swaps otherwise stay Raptor.
- Tokens: Jupiter Portfolio (`useWalletTokens.ts`); prices from the shared
  GMGN + Redis + SSE feed with Jupiter fallback; RPC via the same-origin `/api/rpc`
  proxy (Shyft). Quote comparison across Jupiter / SolanaTracker / GMGN exists at
  `/api/trade/compare`.

### Robinhood Chain (EVM)

Execution depends on **wallet mode** (`useRhWalletMode`), resolved in
`BulkTokenBuyer.tsx` / `BulkTokenSeller.tsx` / `RhGmgnSwapPanel.tsx`:

| Wallet | Execution | Details |
|---|---|---|
| **Bound wallet** (GMGN server-sign) | **GMGN** quote → swap → order poll, per leg | Sequential legs; requires a configured bound EVM wallet for the chain; `/api/gmgn/trade/*` enforces `from` = bound address (`src/utils/gmgn-bulk-trade.ts`, `src/app/api/gmgn/trade/swap/route.ts`) |
| **Parent wallet** (Rabby, browser) | **Kyber aggregator** (`src/utils/dlmm/rh-kyber-swap.ts`) | Parallel Kyber `/routes`, then `/builds`, then allowance reads; optional WETH wrap. Modes below |
| Server / bot | GMGN-bound or keypair paths | Bot cycles run server-side against bound wallets / `TRADING_KEYPAIR_JSON` (Solana) |

Parent-wallet modes (precedence **executor → EIP-5792 → sequential**):

- **BatchExecutor contract** — with `RH_BATCH_EXECUTOR_ADDRESS` set, the wallet gives
  Permit2 approvals in a one-time setup flow. Once readiness is live, each trade
  signs **one atomic `executeBatch` tx** (wrap + pulls + N swaps), regardless of
  wallet EIP-5792 support. The setup does not move funds and the user still confirms
  every trade. Contract: `contracts/src/BatchExecutor.sol` (owner-scoped, immutable,
  pausable, plain-`call` only); planners in `src/utils/dlmm/rh-batch-executor.ts` and
  `src/utils/dlmm/rh-permit2-readiness.ts`; UI checklist in
  `docs/FE_1CLICK_AND_PERMIT2.md`.
- **EIP-5792** — when `getCapabilities` reports `atomic: supported/ready` for chain
  4663, calls go through `wallet_sendCalls` + `waitForCallsStatus`
  (`executeRhWalletCalls`, `src/utils/dlmm/rh-send-calls.ts`). Any non-success receipt
  inside the batch is a failure; mined-but-reverted is never "confirmed".
- **Sequential fallback** — per-leg Approve/Swap txs with per-leg attribution:
  `RhSequentialWriteError` carries the failing call index and `buildKyberLegResults`
  (`rh-kyber-swap.ts`) marks legs confirmed only below that index (partial buys stay
  reconcilable). Each sequential receipt is status-checked.
- **Permit2** — canonical Permit2 `0x0000…8BA3` on 4663. Approvals: one-time ERC20
  approve to Permit2 + `permit2.approve(token, spender, maxUint160, maxUint48)`.
  Standalone path behind `RH_PERMIT2_SWAPS` (default off); executor mode implies
  Permit2 for the executor spender regardless.
- Executor/5792 paths are atomic (one hash confirms every leg).

## 5. Trade-confirmation lifecycle (recent fix)

RH parent/bound swaps no longer guess success from the submit promise — outcome is
decided **only after the on-chain receipt resolves**:

1. **Confirm modal** shows review legs (`GmgnTradeConfirmModal`,
   `src/components/GmgnTradeConfirmModal.tsx`); parent Rabby gets a sequential-sign
   hint ("Approve then Swap, two prompts").
2. On confirm, `RhGmgnSwapPanel.runConfirmed` sets `submitPhase='submitting'` — the
   modal renders a **submit spinner** ("Submitting & confirming on-chain…", buttons
   disabled) — and **persists a pending record** with `txStatus:'pending'` via
   `tradingTracker.trackOperation` (`src/components/RhGmgnSwapPanel.tsx`,
   `src/utils/trading-tracker.ts`).
3. The swap executes (GMGN bound, or Kyber `executeRhParentKyberBuy/Sell`, which wait
   for receipts through `rh-send-calls.ts` / `rh-kyber-swap.ts`).
4. **The receipt decides**: sequential writes throw on a reverted receipt
   (`receipt.status !== 'success'`); a caught error (revert, user reject, batch
   non-success) or `success:false` finalizes the record `txStatus:'failed'`. Only
   successful settlement writes `txStatus:'confirmed'` and flips the modal to a
   **success screen** with a tx explorer link (Blockscout for RH, Solscan for Sol).
5. Promotion: `tradingTracker.updateRecord` → server action `updateTradingRecord`
   (`src/actions/records.ts`) → `updateTradingRecordData` in `trading_records` (falls
   back to insert if the pending record was skipped). Recording is best-effort — a
   tracking hiccup never aborts the on-chain swap.
6. Every insert/update invalidates the trading-records cache and **broadcasts an SSE
   `trade_update`**, so the history feed refreshes to the terminal state
   (`src/utils/trading-records-db.ts`, `src/utils/trading-records-cache.ts`,
   `src/utils/trading-notifications.ts` → `POST /api/trading/subscribe`).

The modal's single `settle()` path applies success/failure counts exactly once.

## 6. PnL tracker / history concepts

- Records are **per wallet + per chain**: cache keys, offline-cache keys and the
  `/api/trading/records` query are all `wallet:chain` scoped — SOL and RH history
  never mix (`src/utils/trading-tracker.ts`).
- Each operation carries `operationType` (`buy`/`sell`/`close`), token legs (mint +
  symbol + prices/amounts), `successCount` / `failureCount` / `totalTokens`,
  spent/received amount + fees, and `signatures[]` (tx hashes; GMGN legs carry
  `orderId`/`hash`).
- **Success/failure semantics**: a leg is successful only when its order/receipt is
  terminal-confirmed; history shows "N failed" for failed legs; failed-only records
  are skipped by the DB layer (`shouldSkipTradingRecord`).
- **Settlement state**: `txStatus` `pending` → `confirmed`/`failed` mirrors the
  on-chain lifecycle above (`src/utils/trading-tracker.ts`; UI badges in
  `TradingHistory.tsx` — amber "Confirming…" spinner for pending, red for failed).
- **PnL**: `PnLTracker.tsx` matches successful buy/sell/close operations per token to
  compute realized/unrealized native-unit PnL; open positions are pruned against live
  holdings (`pruneOpenPositionsByHoldings`); per-wallet aggregates live in
  `token_operations` and strategy outcomes in `strategy_outcomes`.
- **Real-time**: `tradingTracker.subscribeToWallet(wallet, cb, chain)` keeps one SSE
  connection per wallet (60s heartbeat staleness check, debounce, exponential backoff,
  8s polling fallback) and re-fetches records on `trade_update` / `pnl_update` /
  `balance_update` events.
