# Changelog

All notable changes to ReloadSOL are documented in this file.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

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
- **`DevRouteGate`** — dev-wallet check on `/dev/signals` and `/dev/algo-tester` (aligns with nav gating; DLMM still uses `PasswordGate`).
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

### Build & verify

```bash
pnpm type-check
pnpm build --webpack
pnpm dev   # uses webpack dev server
```

### Docs still referencing old routes

Some files under `docs/` may still mention deleted paths (`/catch-the-coin`, `/dev/trending-tracker`, etc.). Prefer this changelog and `README.md` for current routing.
