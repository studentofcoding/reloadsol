# Changelog

All notable changes to ReloadSOL are documented in this file.

## [Unreleased]

### Added

- **Jupiter Universal Wallet Kit** — wallet connectivity via [`@jup-ag/wallet-adapter`](https://developers.jup.ag/docs/tool-kits/wallet-kit), supporting 20+ Solana wallets through Wallet Standard auto-discovery (Phantom, Solflare, Backpack, Jupiter Wallet Extension, mobile QR, and more).
- **`UniversalWalletButton`** — connect/disconnect UI that opens Jupiter’s unified wallet picker modal.
- **`WalletNotification`** — lightweight toast feedback for connect, disconnect, and install prompts.
- **DLMM Agent Dashboard** (`/dev/dlmm`) — Hunter screener + Healer position manager for Meteora DLMM pools, with deploy/edit/close, dry-run mode, decision feed, and Telegram bot integration.
- **Docker stack** — one-command local and production deployment for Next.js web + Go cron (`npm run docker:up`, `docker:dev`, `docker:prod`).
- **DLMM cron jobs** — automated pool screening (5m) and position management (60s) via `main.go`.
- **`.env.docker.example`** — documented env template for Docker and DLMM agent configuration.
- **`supabase/schema.sql`** — single consolidated Supabase schema (all app tables; removed unused `dlmm_pool_snapshots`).
- **README** — full setup guide from git clone, Docker, Supabase, env vars, dashboards, and troubleshooting.

### Changed

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
