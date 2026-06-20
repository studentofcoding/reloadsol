# Changelog

All notable changes to ReloadSOL are documented in this file.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Fixed — Docker deploy health wait

- **`scripts/docker-deploy.sh`** — verifies `.next/standalone` + `.next/static` immediately after `npm run build` (fails fast on incomplete builds); recreates containers with `--force-recreate`; waits on Docker `reloadsol-web` health before curling `/api/health` (surfaces web logs on `unhealthy` instead of a blind 5-minute loop).
- **`GET /api/health`** — explicit `HEAD` handler for Docker `wget` and in-app connectivity checks.
- **Docker healthchecks** — [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile.web`](Dockerfile.web) use `wget -O /dev/null` (GET) instead of `--spider` (HEAD).

### Improved — Post-implementation hardening

- **Shared record notifications** — `afterTradingRecordInserted()` invalidates server cache (30s TTL) and broadcasts SSE for all inserts, including bot/cron paths via `insertTradingRecord`.
- **`checking` wallet session** — reconnect no longer flashes P&amp;L/History skeleton while validating an existing cookie.
- **Deduped refetch** — removed redundant client SSE notify after POST save; SSE subscriber uses invalidate-only (no double refetch).
- **Sim close proceeds** — `closeSimulationPosition()` returns `solReceived`; success modals show received SOL, not buy cost.
- **`TradeOutcomeModal`** extended to Bulk Buy/Sell and BoardTab instant buy.

### Fixed — Sim close, trade feedback, real-time records, wallet session

- **`trackOperation`** — re-throws API failures when online (no silent success); offline still caches locally. Notifies SSE subscribers after successful save.
- **`POST /api/trading/records`** — broadcasts `trade_update` to SSE clients after insert.
- **`TradingDataProvider`** — optimistic record updates on track; `staleTime` 10s + 15s refetch interval while session ready.
- **Sim close** — close records use `status: 'won'`; failures surface in UI instead of disappearing on refetch.
- **`TradeOutcomeModal`** — unified success/failure modal on PnL, LiveTab, and BoardTab (sim + live buy/sell).
- **`WalletSessionProvider`** — session cookie persists across wallet disconnect; re-sign only when session missing or wallet address changes (not every reconnect).

### Fixed — Wallet sign-in (401 on trading records)

- **Session status check** — `getWalletSessionStatus()` now uses `GET /api/auth/wallet/session` (no query) instead of broken `HEAD` + JSON parse.
- **Message signing** — uses Jupiter `useWallet().signMessage` first, with adapter fallback (`wallet-session-client.ts`).
- **`WalletSessionProvider`** — replaces silent `WalletSessionBridge`; exposes `useWalletSession()` with `signIn()` retry and error state.
- **`WalletSignInPrompt`** — visible Sign in button on History/P&amp;L when session is missing or rejected.
- **`TradingDataProvider`** — defers record fetch until `walletSessionStatus === 'ready'` (stops 401 retry spam).
- **Dev env** — ephemeral `WALLET_SESSION_SECRET` in non-production when unset; documented in `.env.docker.example`.

### Added — Trade tracking utilities

- **`src/utils/simulation-trades.ts`** — `computeOpenSimCycle()` and `closeSimulationPosition()` close sim positions using exact open-cycle token amounts (not recalculated spot prices).
- **`src/utils/trade-tracking.ts`** — shared wrappers: `trackRealBuy` / `trackRealSell` / `trackRealClose`, `trackSimBuy`, `trackSimClose`.
- **`src/utils/trading-records-db.ts`** — `insertTradingRecord()` and `buildTradingRecord()` for direct Supabase writes (server/cron paths).
- **`TrackingRecord.close_position`** — optional flag on sim sells to force-close a cycle when amounts drift.

### Fixed — History & PnL data pipeline

- **`getWalletRecords`** — re-throws `WALLET_SESSION_REQUIRED` instead of returning `[]`, so React Query retries and session errors surface correctly; still merges offline `localStorage` cache as fallback.
- **`WalletSessionBridge`** — always dispatches `reloadsol-wallet-session` after successful sign-in (fixes race where first fetch 401’d before cookie was set).
- **`TradingHistory` / `PnLTracker`** — show “Sign in to load history/P&amp;L” when wallet session is missing (not a misleading empty state).
- **`/api/trading/subscribe`** — moved from dev tier to **wallet tier** in [`api-access.ts`](src/config/api-access.ts) so all connected users get SSE record refresh.
- **`getAllRecords`** — fetch now sends `credentials: 'include'`.
- **`TradingDataProvider` / `PnLTracker` / `TradingHistory`** — use `useWalletAddress()` consistently so Jupiter adapter “connected” state matches record fetches (fixes empty History/PnL when wallet was connected but adapter `connected` was false).
- **Trading record fetches** — `credentials: 'include'` on client GETs; refetch on `reloadsol-wallet-session` after wallet sign-in completes.

### Fixed — Simulation trade close

- **`PnLTracker`** — Fast Sell and bulk **Sell** route SIM positions through `closeSimulationPosition()` (no on-chain Jupiter swap); bulk button label becomes **Close (N)** when all selected positions are sim.
- **PnL cycle math** — sim sells honor `close_position` and treat ≥99% of remaining tokens as a full close (handles float drift).
- **`BoardTab`** — `handleSimulateSell` uses shared close helper + live `records` (replaces approximate price-based sell sizing that left positions stuck open).
- **`LiveTab`** — sim buy via `trackSimBuy`; **Sim Close** button when an open sim cycle exists; real buy/sell now tracked to `/api/trading/records`.

### Changed — Route trade tracking coverage

- **`LiveTab`** — real Jupiter buy/sell calls `trackRealBuy` / `trackRealSell` after confirmed txs (previously on-chain only, no history).
- **`BoardTab`** — weighted Potential bulk buy also calls `trackOperation` (was points-only via `trackBuy`); sim buy/sell use `trade-tracking` helpers.
- **`trackBotOperation`** ([`/api/trending/track`](src/app/api/trending/track/route.ts)) — writes directly to Supabase via `insertTradingRecord()` (no wallet-cookie HTTP POST); sets `is_simulation`, `simulation_type: 'strategy'`, and correct sell `tokenAmount` from input lamports (not SOL output).

### Changed — WalletConnectGate UX

- **Non-connected layout** — two-column grid matching the buy page: **Trending Tokens** on the left, connect CTA on the right (`lg:grid-cols-3`, same as connected bulk buy).
- **Gate copy** — default title “Catch the trending token with our platform”; button **Check now** (`UniversalWalletButton` `connectLabel`).
- **Trending preview** — public GET for `/api/trending/filtered` and `/api/trending/prices`; `TrendingTokens` `preview` mode on the gate (click token → open wallet modal).
- **History/P&amp;L overlays** — gate still uses `showTrending={false}` and “Connect Wallet” label.

### Added — Deploy lockfile repair

- **`scripts/npm-ci-sync.sh`** — runs `npm ci`, and on lockfile drift runs `npm install` once then retries (fixes `Missing: tweetnacl@1.0.3 from lock file` and similar deploy failures).
- **`package.json`** — `lockfile:sync` and `install:ci` scripts; [`docker-deploy.sh`](scripts/docker-deploy.sh), [`docker-install.sh`](scripts/docker-install.sh), and [`docker-dev-entrypoint.sh`](scripts/docker-dev-entrypoint.sh) use the sync script.

### Changed — Supabase secret API keys

- **New key model** — server requires `SUPABASE_SECRET_KEY` (`sb_secret_...`); legacy `service_role` / `anon` / `NEXT_PUBLIC_SUPABASE_*` env vars removed.
- **Pure admin client** — [`src/utils/supabase.ts`](src/utils/supabase.ts) uses secret key only with `detectSessionInUrl: false` (no user JWT mixing).
- **Scripts / CI** — admin scripts and [`deploy_pm2.yml`](.github/workflows/deploy_pm2.yml) updated for `SUPABASE_SECRET_KEY`.

### Added — Wallet API sessions + Supabase hardening (Phase 2)

- **Wallet sign-in** — `/api/auth/wallet/session` issues an httpOnly cookie after ed25519 message signing (`WalletSessionBridge` auto-signs on connect).
- **API middleware** — [`proxy.ts`](proxy.ts) + [`src/config/api-access.ts`](src/config/api-access.ts) enforce wallet vs dev tiers on API routes; cron/webhook bearer secrets still bypass.
- **Supabase RLS** — all app tables in [`supabase/schema.sql`](supabase/schema.sql) now have RLS enabled (blocks direct PostgREST access).
- **Env** — `SUPABASE_SECRET_KEY`, `WALLET_SESSION_SECRET`, optional `WALLET_SESSION_TTL_HOURS`.

### Changed — Wallet tier access (UI)

- **Route tiers** — [`src/config/route-access.ts`](src/config/route-access.ts): wallet-required routes (`/buy`, `/sell`, `/swap`, `/history`, `/pnl`) vs dev whitelist routes (`/dev/signals`, `/dev/algo-tester`, `/dev/dlmm`).
- **`WalletConnectGate`** — blocks wallet-required pages and History/P&amp;L overlays until a Solana wallet is connected.
- **`DevRouteGate`** — centralized in [`src/app/(trade)/layout.tsx`](src/app/(trade)/layout.tsx); connect-first, then dev allowlist check. Removed per-page gates on Signals and Algo Tester.
- **DLMM** — removed hardcoded `PasswordGate`; dev wallet allowlist only (DLMM API writes still use `DLMM_API_PASSWORD`).
- **Navigation** — Swap, History, and P&amp;L visible to all users; dev tool links remain dev-wallet only.
- **Env** — `NEXT_PUBLIC_DEV_WALLETS` or `DEV_WALLETS` (comma-separated) plus built-in defaults in [`src/utils/dev-wallet.ts`](src/utils/dev-wallet.ts).

### Changed — Unified shared rug list

- **`token_rug_list`** — canonical app-wide rug registry (renamed from `dlmm_rug_list`); one list shared by DLMM, Signals, and Algo Tester.
- **Backfill migration** in [`supabase/schema.sql`](supabase/schema.sql) — copies legacy `trading_signals.label = 'rugged'` and `token_mcap_tracking.label = 'rugged'` into `token_rug_list`.
- **Shared service** — [`src/utils/rug-list/service.ts`](src/utils/rug-list/service.ts) `markTokenRug` / `unmarkTokenRug` syncs legacy labels and removes from `dlmm_potential_list`.
- **API** — canonical `GET/POST/DELETE` [`/api/rug`](src/app/api/rug/route.ts); [`/api/dlmm/rug`](src/app/api/dlmm/rug/route.ts) delegates for backward compat.
- **Server sync** — [`/api/signals`](src/app/api/signals/route.ts) and [`/api/mcap-tracking/label`](src/app/api/mcap-tracking/label/route.ts) read/write the shared rug list; Board GET merges rug-list tokens into the Rugged column.
- **Filtering** — manual rugs excluded from [`/api/trading/signals`](src/app/api/trading/signals/route.ts) feed and Board Watching/Potential columns.
- **Hook** — `useRugList` (replaces `useDlmmRugList`); Live/Board/Tracker/Signals invalidate or read unified rug state.

### Added — DLMM Potential / Rug chart actions

- **DLMM Hunter Candidates** — split into **General** (automated Hunter screen) and **Potential** (manual watchlist) tabs via `HunterCandidateTabs`.
- **`dlmm_potential_list`** — persisted watchlist; tokens added from Signals, Board, Tracker, Algo Tester, or DLMM charts.
- **`token_rug_list`** — shared exclusion list; rugged tokens hidden from DLMM General/Potential, trading signals feed, and non-Rugged board columns.
- **`DlmmChartActions`** — shared **Potential** / **Rug** toggle buttons on every chart/token row:
  - DLMM dashboard (`HunterCandidateTabs` cards)
  - Signals hub — Signals, Live, Board, Tracker tabs
  - Algo Tester — Dashboard and History tabs
- **API** — `GET/POST/DELETE` `/api/dlmm/potential`, `/api/rug`, and `/api/dlmm/rug` (alias).
- **Hooks** — `useDlmmPotentialList`, `useRugList`, `useDlmmChartActions` (mutually exclusive: marking Potential clears Rug and vice versa).

### Added — Slim dev surfaces (Signals, Algo Tester, DLMM)

- **Signals hub** (`/dev/signals`) — four tabs via `?tab=signals|live|board|tracker`:
  - **Signals** — trading signal list, filters, floating GMGN charts (`SignalsTab`)
  - **Live** — trending sniper grid, buy/sell, Axiom risk (from catch-the-coin → `LiveTab`)
  - **Board** — kanban columns, `@dnd-kit`, weighted bulk buy on Potential, chart capture (from `/charts` → `BoardTab`)
  - **Tracker** — mcap list, filters, refetch/stop, labels (from `/dev/mcap-tracker` → `TrackerTab`)
- **Algo Tester** (`/dev/algo-tester`) — two tabs via `?tab=dashboard|history`:
  - **Dashboard** — trending win/loss stats, active tracking (from `/dev/trending-tracker`)
  - **History** — token tracking history + Chart.js (from `/dev/tracking-history`)
- **Hub shells** — `SignalsHub.tsx`, `AlgoTesterHub.tsx` with URL-driven tabs and lazy-loaded tab bodies (`next/dynamic`).
- **Shared Signals primitives** under `src/components/signals/shared/`:
  - `parseAddresses.ts` / `boardTabUrl()` — deep links to Board tab with `?addresses=`
  - `GmgnChartEmbed.tsx` — unified GMGN kline iframe
  - `TokenLabelActions.tsx` — rugged / potential / watching label buttons (extracted; wiring in tabs is incremental)
- **`DevRouteGate`** — dev-wallet check on `/dev/*` routes via trade layout (replaces per-page gates and DLMM password gate).
- **`slim_features.md`** — plan + checklist for the dev-route consolidation.

### Added — Next.js 16 migration

- **Next.js 16.1.7** and **React 19** (Node `>=20.9.0`).
- **`eslint.config.mjs`** — ESLint 9 flat config (replaces `next lint`).
- **`proxy.ts`** — request boundary for slim-route redirects (query-aware `/charts?addresses=`), API CORS, and forwarded headers (Next.js 16 replacement for `middleware.ts`).

### Changed — Slim dev consolidation

- **Dev navigation** — reduced to three tools: Signals, Algo Tester, DLMM (desktop + mobile); removed catch-the-coin, charts, trending-tracker, tracking-history, mcap-tracker, pools, pools-test from nav.
- **Route redirects** (single source: `proxy.ts`; `next.config.js` `redirects()` cleared to avoid duplication):

  | Old route | New destination |
  |-----------|-----------------|
  | `/catch-the-coin` | `/dev/signals?tab=live` |
  | `/charts` | `/dev/signals?tab=board` (preserves `?addresses=`) |
  | `/dev/mcap-tracker` | `/dev/signals?tab=tracker` |
  | `/dev/trending-tracker` | `/dev/algo-tester` |
  | `/dev/tracking-history` | `/dev/algo-tester?tab=history` |
  | `/dev/pools` | `/dev/dlmm` |
  | `/dev/pools-test` | `/dev/algo-tester` |

- **Deleted page routes** (logic moved into tab components): `catch-the-coin`, `charts`, `dev/mcap-tracker`, `dev/trending-tracker`, `dev/tracking-history`.
- **Backward-compat re-exports** — `TradingSignals.tsx` → `SignalsTab`; `CatchTheCoinClient.tsx` → `LiveTab`.
- **Cross-tab links** — “Open in Board” uses `/dev/signals?tab=board&addresses=...` from Live, Tracker, and Algo Dashboard.
- **Tab state** — visited Signals/Algo tabs stay mounted (hidden) so filters and scroll persist across tab switches.
- **README** — dev dashboard table updated to the three-surface model.

### Changed — Slim dev improvements (post-merge)

- **BoardTab** — restored weighted “Buy All (Weighted)” UI on the Potential column (`DroppableColumn`).
- **LiveTab** — consolidated duplicate 5s polling into one auto-update loop; removed dead `fetchBuyQuotes`.
- **TrackerTab** — slimmed (~3.6k → ~2.5k LOC): removed toast alerts, 30-day summary, daily ranking viz, growth histograms, and per-row GMGN iframes; kept paginated list, refetch/stop, labels, compact PnL cards.
- **Layout** — removed nested `min-h-screen` and duplicate `<h1>` titles inside tab bodies (Board, Algo Dashboard, History, Tracker, Live).
- **GmgnChartEmbed** — adopted in Board, Signals, and Live tabs (consistent `gmgn.cc/kline` embeds).
- **Orphan pages** — `/dev/pools` and `/dev/pools-test` remain reachable but redirect via proxy; duplicate `NavigationTabs` removed from those pages.

### Changed — Next.js 16 migration

- **`middleware.ts` → `proxy.ts`** — renamed export `middleware` → `proxy` per Next.js 16 convention.
- **Async route params** — `params` / `searchParams` treated as Promises where required (e.g. blog slug, DLMM position API).
- **`next.config.js`**:
  - `images.remotePatterns` (replaces deprecated `domains`)
  - `turbopack.resolveAlias` for Solana/crypto browser polyfills
  - `outputFileTracingRoot`, `serverExternalPackages: ['puppeteer']`
  - Production build uses **`--webpack`** (Turbopack prod build fails on some Solana/DLMM modules)
- **Scripts** — `dev` and `build` default to `--webpack`.

### Fixed — Next.js 16 / dev stability

- **Dev hydration / reload loop** — scripts moved into `<body>` via `next/script`; `suppressHydrationWarning` on root layout.
- **`WalletProvider`** — stable `WALLET_APP_URL` metadata (no `window.location.origin`); memoized wallet config.
- **`HomePageClient`** — `router.replace('/sell')` with ref guard instead of `window.location.href`.
- **`LastReloadTracker`** — graceful handling of 500 from last-reload API.
- **`TradingDataProvider`** — corrected `/api/solprice` fetch path.
- **`/api/trending/track`** — replaced removed `request.ip` with header-based client IP.

### Unchanged (by design)

- Core trading routes: `/buy`, `/sell`, `/swap`, `/pnl`, `/history`
- Backend APIs: `/api/mcap-tracking/*`, `/api/trading/signals`, `/api/trending/*`, `/api/dlmm/*`
- Standalone chart deep link: `/chart/[tokenAddress]`
- DLMM dashboard behavior and all `/api/dlmm/*` routes

---

## Prior releases (wallet, Docker, DLMM)

### Added

- **Jupiter Universal Wallet Kit** — wallet connectivity via [`@jup-ag/wallet-adapter`](https://developers.jup.ag/docs/tool-kits/wallet-kit), supporting 20+ Solana wallets through Wallet Standard auto-discovery (Phantom, Solflare, Backpack, Jupiter Wallet Extension, mobile QR, and more).
- **`UniversalWalletButton`** — connect/disconnect UI that opens Jupiter’s unified wallet picker modal.
- **`WalletNotification`** — lightweight toast feedback for connect, disconnect, and install prompts.
- **DLMM Agent Dashboard** (`/dev/dlmm`) — Hunter screener + Healer position manager for Meteora DLMM pools, with deploy/edit/close, dry-run mode, decision feed, and Telegram bot integration.
- **Docker stack** — one-command local and production deployment for Next.js web + Go cron (`npm run docker:up`, `docker:dev`, `docker:prod`); always runs `npm ci` before build/start.
- **DLMM cron jobs** — automated pool screening (5m) and position management (60s) via `main.go`.
- **`.env.docker.example`** — documented env template for Docker and DLMM agent configuration.
- **`supabase/schema.sql`** — single consolidated Supabase schema (all app tables; removed unused `dlmm_pool_snapshots`).
- **README** — full setup guide from git clone, Docker, Supabase, env vars, dashboards, and troubleshooting.

### Changed

- **Dependencies** — wallet stack trimmed to `@jup-ag/wallet-adapter` only; removed direct `@solana/wallet-adapter-react`, `@emotion/*`, `styled-components`, and legacy `@solana/wallet-adapter-wallets` / `react-ui` (eliminates blocked `xrpl` on Tencent mirrors). `.npmrc` uses `registry.npmjs.org` + `legacy-peer-deps=true`.
- **RPC provider** — all Solana RPC calls now use **Shyft** via `SHYFT_API_KEY` / `RPC_URL` (`src/utils/rpc-urls.ts`). Removed `HELIUS_API_KEY` and Helius Sender from `/api/buy`.
- **`WalletProvider`** — replaced Phantom-only `window.solana` injection with Jupiter `UnifiedWalletProvider`; existing `useWallet()` / `useConnection()` hooks remain compatible across the app.
- **`PhantomWalletButton`** — now re-exports `UniversalWalletButton` for backward compatibility.
- **Jupiter Terminal** — continues to use wallet passthrough with the unified adapter context.
- **`next.config.js`** — added `output: 'standalone'` for Docker, `transpilePackages` for `@jup-ag/wallet-adapter`, and `styledComponents` compiler support.
- **`Dockerfile`** — switched to `npm ci` for reproducible installs.

### Fixed

- Docker web image OOM during in-container `next build` — host-build path via `Dockerfile.web` packages pre-built `.next/standalone`.
- Removed duplicate nested `WalletProvider` wrappers in `HomePageClient` and `SwapPageClient`.
- DLMM dashboard/cron errors when Supabase is unreachable — graceful fallbacks, setup banner on `/dev/dlmm`, `/api/dlmm/health`, and cron manage returns 200 (skipped) instead of 500.
- Supabase schema script fails on existing DBs — `label` and `waiting_started_at` indexes moved after column patches.

---

## Migration notes

### Bookmark / link updates

If you bookmarked old dev URLs, use the redirects above or navigate directly:

- Live sniper → `/dev/signals?tab=live`
- Chart kanban → `/dev/signals?tab=board` (optional `&addresses=mint1,mint2`)
- MCap admin → `/dev/signals?tab=tracker`
- Trending algo → `/dev/algo-tester`
- Tracking history → `/dev/algo-tester?tab=history`

### Wallet session required for History / PnL

After Phase 2, `/api/trading/records` requires a wallet API session (httpOnly cookie from `POST /api/auth/wallet/session`). Ensure `WALLET_SESSION_SECRET` is set in production. Users must approve the sign-message prompt once after connecting; without it, History and P&amp;L show a sign-in prompt rather than data.

Sim positions are closed from P&amp;L via **Close** (not on-chain sell). Use **Sim Close** on Live tab or Board simulate sell for the same behavior.

### Build & verify

```bash
pnpm type-check
pnpm build --webpack
pnpm dev   # uses webpack dev server
```

### Docs still referencing old routes

Some files under `docs/` may still mention deleted paths (`/catch-the-coin`, `/dev/trending-tracker`, etc.). Prefer this changelog and `README.md` for current routing.
