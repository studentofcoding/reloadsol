# ReloadSOL

Next.js + Go-cron Solana trading platform: bulk token buys, trending tracker, mcap analytics, SL/TP monitoring, and an autonomous Meteora DLMM agent. Bulk buy/sell uses Solana Tracker Raptor; Jupiter Portfolio for wallet tokens; Shyft RPC via `/api/rpc`; Supabase for persistence; and Jupiter [Wallet Kit](https://developers.jup.ag/docs/tool-kits/wallet-kit) for universal wallet connectivity.

## Features

- **Bulk token purchase** — buy up to 10 tokens in one flow via Raptor
- **Universal wallet** — Phantom, Solflare, Backpack, Jupiter Wallet, mobile QR, and 20+ Wallet Standard wallets
- **Trending tracker** — 24/7 monitoring, win/loss stats, Discord alerts
- **MCap tracker** — growth thresholds, labels, OHLC bars
- **SL/TP monitor** — automated stop-loss / take-profit positions
- **DLMM agent** — Hunter screener + Healer manager for Meteora pools (`/dev/dlmm`)
- **Docker stack** — one command runs Next.js web + Go cron locally or in production

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org/) | 20+ | Host build for Docker prod mode |
| [Docker](https://docs.docker.com/get-docker/) | 24+ with Compose v2 | Recommended for full stack |
| [Supabase](https://supabase.com/) project | — | Free tier works for dev |
| [Shyft RPC](https://shyft.to/) API key | — | Replaces legacy Helius setup |

Optional: Discord webhook, Telegram bot token (DLMM alerts), trading keypair for live bot trading.

---

## Quick start (Docker — recommended)

```bash
git clone https://github.com/studentofcoding/reloadsol.git
cd reloadsol

npm install
cp .env.docker.example .env
# Edit .env — at minimum: SUPABASE_*, SHYFT_API_KEY, RPC_URL

# Apply database schema in Supabase SQL Editor (see below)
npm run docker:up
```

Open [http://localhost:3000](http://localhost:3000). Cron health: [http://localhost:8080/health](http://localhost:8080/health).

---

## Full setup from git clone

### 1. Clone and install

```bash
git clone https://github.com/studentofcoding/reloadsol.git
cd reloadsol
npm install
```

### 2. Configure environment

```bash
cp .env.docker.example .env
```

Edit `.env` with your secrets. Minimum required for a working stack:

```bash
# Supabase — Dashboard → Project Settings → API Keys
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=your-sb-secret-key

# Shyft — https://shyft.to dashboard (server-side RPC via /api/rpc proxy)
# Wallet tokens: Jupiter Portfolio via /api/jupiter/portfolio (both /buy and /sell)
# Swaps: Solana Tracker Raptor (bulk /sell and /buy); GMGN charts only (no GMGN swap execution)
# Browser RPC is proxied through /api/rpc — NEXT_PUBLIC_RPC_URL is optional
SHYFT_API_KEY=your-shyft-api-key
RPC_URL=https://rpc.shyft.to?api_key=your-shyft-api-key,https://api.mainnet-beta.solana.com
# NEXT_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com
```

See [Environment variables](#environment-variables) for the full list.

### 3. Supabase database

1. Open your [Supabase](https://supabase.com/dashboard) project → **SQL Editor**
2. Paste and run the entire contents of [`supabase/schema.sql`](supabase/schema.sql)
3. Safe to re-run on existing projects (uses `IF NOT EXISTS` + idempotent patches)

Tables created include: `token_operations`, `trading_records`, `trading_signals`, `sl_tp_positions`, `trending_token_tracker`, `token_mcap_tracking`, `token_ohlc_bars`, and DLMM tables (`dlmm_agent_config`, `dlmm_candidates`, `dlmm_positions`, `dlmm_lessons`).

Verify DLMM health after deploy: `GET /api/dlmm/health`

### 4. Run with Docker

Docker runs two services:

| Service | Container | Port | Role |
|---------|-----------|------|------|
| **web** | `reloadsol-web` | 3000 | Next.js app + API routes |
| **cron** | `reloadsol-cron` | 8080 | Go scheduler (trending, SL/TP, DLMM) |

```bash
npm run docker:up           # prod-like: web + cron (foreground)
npm run docker:up:web       # web only
npm run docker:up:cron      # cron only (web should already be running)
npm run docker:dev          # hot-reload web only (no cron)
npm run docker:dev:full     # hot-reload web + cron
npm run docker:prod         # detached production (restart: always)
npm run docker:deploy       # production deploy — auto-detect changed services
npm run docker:deploy:web   # deploy web only (frontend changes)
npm run docker:deploy:cron  # deploy cron only (Go changes)
npm run docker:down         # stop containers
npm run docker:logs         # tail logs
```

**How it works:** `scripts/docker-up.sh` runs `npm ci` first, then builds Next.js on the host for prod (`npm run build` → `.next/standalone`) and packages via `Dockerfile.web`. **`docker:deploy`** uses `scripts/docker-scope.sh` to rebuild only web or cron when possible (frontend-only changes do not restart cron). Dev default is **web only**; use `docker:dev:full` when you need cron locally. Cron calls the web service at `API_HOST=http://web:3000`.

First run may take several minutes while dependencies install and Next.js builds.

### 5. Run without Docker (dev only)

```bash
cp .env.docker.example .env.local   # or symlink/copy to .env
npm run dev
```

Cron jobs will **not** run in this mode unless you start `main.go` separately. Use Docker for the full autonomous stack.

---

## Environment variables

Copy from [`.env.docker.example`](.env.docker.example). Key groups:

### Required

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server secret key (`sb_secret_...`) |
| `SHYFT_API_KEY` | Shyft dashboard API key — powers server-side RPC via `/api/rpc` proxy |
| `RPC_URL` | Comma-separated RPC URLs (max 5). Server `/api/rpc` proxy with failover. |
| `NEXT_PUBLIC_RPC_URL` | Optional — browser uses `/api/rpc` proxy by default; set only for legacy direct-RPC paths. |
| `RAPTOR_API_BASE` | Optional override for Solana Tracker Raptor swap API (default `https://raptor-beta.solanatracker.io`) |
| `WALLET_SESSION_SECRET` | httpOnly wallet session cookie signing |

### Cron secrets

| Variable | Default | Used by |
|----------|---------|---------|
| `TRENDING_TRACKER_SECRET` | — | Trending track/summary APIs |
| `PNL_UPDATE_SECRET` | — | `/api/pnl/update` |
| `DLMM_SCREEN_SECRET` | — | DLMM Hunter cron |
| `DLMM_MANAGE_SECRET` | — | DLMM Healer cron |

### DLMM agent

| Variable | Default | Description |
|----------|---------|-------------|
| `DLMM_AGENT_ENABLED` | `false` | Master switch for autonomous agent |
| `DLMM_DRY_RUN` | `true` | Simulate LP actions without on-chain txs |
| `DLMM_API_PASSWORD` | — | Password for dashboard config changes |
| `TRADING_KEYPAIR_JSON` | — | `[1,2,3,...]` array for live trading |

### Telegram (optional)

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALERT_CHAT_ID=
TELEGRAM_ADMIN_CHAT_IDS=
TELEGRAM_WEBHOOK_SECRET=reloadsol-dlmm-secret
```

After deploy, register the webhook:

```bash
npm run dlmm:telegram-webhook -- https://your-domain/api/dlmm/telegram
```

### Trading safety

```bash
MAX_SOL_AT_RISK=1.0
MIN_SOL_BALANCE=0.1
TOKEN_PURCHASE_COOLDOWN_HOURS=24
MAX_PURCHASES_PER_TOKEN=2
BOT_TRADING_FAILURE_THRESHOLD=3
BOT_TRADING_HALT_MINUTES=20
BOT_TRADE_LOCK_TTL_SEC=120
```

---

## Dev dashboards

| Route | Description |
|-------|-------------|
| `/dev/signals` | Signals hub — signals, live trending, chart board, mcap tracker (`?tab=`) |
| `/dev/algo-tester` | Algo tester — trending win/loss dashboard + tracking history |
| `/dev/dlmm` | Meteora DLMM agent — pools, positions, deploy/edit/close |

Legacy routes redirect via `proxy.ts` (e.g. `/charts` → `/dev/signals?tab=board`, `/dev/trending-tracker` → `/dev/algo-tester`).

---

## DLMM agent

Autonomous Meteora DLMM liquidity manager (Meridian-style Hunter + Healer):

- **Hunter** — screens pools every 5m (`POST /api/dlmm/screen`)
- **Healer** — manages open positions every 60s (`POST /api/dlmm/manage`)
- **Dashboard** — `/dev/dlmm` with GMGN kline charts per candidate
- **Telegram** — alerts and bot commands via `/api/dlmm/telegram`

Start in safe mode:

```bash
DLMM_AGENT_ENABLED=false
DLMM_DRY_RUN=true
```

Check status: `GET /api/dlmm/health` · Config: `GET /api/dlmm/config`

---

## Wallet integration

ReloadSOL uses Jupiter **Universal Wallet Kit** — a single wallet dependency (`@jup-ag/wallet-adapter`; no legacy `@solana/wallet-adapter-*` packages):

```tsx
import { useWallet, useConnection } from '@/components/WalletProvider'

const { publicKey, connected, signAllTransactions } = useWallet()
const { connection } = useConnection()
```

| Component | Role |
|-----------|------|
| `WalletProvider.tsx` | `UnifiedWalletProvider` wrapper |
| `UniversalWalletButton.tsx` | Connect / disconnect UI |
| `JupiterTerminal.tsx` | Swap widget with wallet passthrough |

Docs: [Jupiter Wallet Kit](https://developers.jup.ag/docs/tool-kits/wallet-kit)

---

## Trending token tracker

Automated monitoring of Jupiter trending tokens with 24h win/loss summaries.

### API endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/trending/track` | POST | 5-minute price updates (cron) |
| `/api/trending/summary` | POST | 24-hour summaries (cron) |
| `/api/trending/stats` | GET | Frontend stats feed |
| `/api/trending/mode` | PUT | Toggle simulation ↔ live trading |
| `/api/trending/price-monitor` | POST | 1-minute price monitor (Go cron) |

### Switch simulation → live trading

```bash
curl -X PUT \
  'https://<your-domain>/api/trending/mode?key=$TRENDING_TRACKER_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"isSimulated": false}'
```

### Manual test

```bash
node scripts/test-trending-tracker.js all
```

---

## Useful npm scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Next.js dev server (no cron) |
| `npm run build` | Production build |
| `npm run type-check` | TypeScript check |
| `npm run docker:up` | Docker web + cron (foreground) |
| `npm run docker:up:web` | Docker web only |
| `npm run docker:up:cron` | Docker cron only |
| `npm run docker:dev` | Docker web hot reload (no cron) |
| `npm run docker:dev:full` | Docker web + cron hot reload |
| `npm run docker:prod` | Docker detached production |
| `npm run docker:deploy` | Auto deploy changed services |
| `npm run docker:deploy:web` | Deploy web only |
| `npm run docker:deploy:cron` | Deploy cron only |
| `npm run dlmm:telegram-webhook` | Register Telegram webhook URL |
| `npm run logs:follow` | Tail app logs |
| `npm run logs:trending` | Filter trending API logs |

---

## Changelog

### Recent changes ([full changelog](./CHANGELOG.md))

**Added**
- Jupiter Universal Wallet Kit — 20+ wallets via Wallet Standard
- DLMM Agent Dashboard (`/dev/dlmm`) — Hunter + Healer, Telegram, dry-run
- Docker stack — `npm run docker:up` runs web + Go cron
- Consolidated Supabase schema — single [`supabase/schema.sql`](supabase/schema.sql)
- GMGN kline charts on DLMM Hunter candidates

**Changed**
- RPC migrated to **Shyft** (`SHYFT_API_KEY` / `RPC_URL`); Helius removed
- `WalletProvider` uses Jupiter `UnifiedWalletProvider`
- Docker uses host-side Next.js build + `Dockerfile.web` standalone image

**Fixed**
- Docker web OOM during in-container builds
- DLMM dashboard graceful fallbacks when Supabase is unreachable
- Supabase schema ordering for existing databases (`label` column patches)

See [CHANGELOG.md](./CHANGELOG.md) for complete release notes.

---

## Troubleshooting

### Supabase `ENOTFOUND` or empty dashboards

- Confirm `SUPABASE_URL` resolves (correct project ref from dashboard)
- Run [`supabase/schema.sql`](supabase/schema.sql) in SQL Editor
- Rebuild Docker web only: `npm run docker:deploy:web`
- Rebuild cron only: `npm run docker:deploy:cron`
- Full stack: `npm run docker:down && npm run docker:up`

### DLMM manage returns `skipped`

- Schema not applied — run `supabase/schema.sql`
- Check `GET /api/dlmm/health` for the exact reason

### Cron 500 errors

- Ensure web container is healthy before cron starts (`depends_on: service_healthy`)
- Check `npm run docker:logs` for the underlying API error

### Wallet won't connect

- Use HTTPS in production
- Install a Wallet Standard wallet extension (Phantom, Solflare, etc.)

### `npm install` fails on Tencent Cloud (HTTP 451 / `xrpl`)

Tencent's default npm mirror blocks some packages (e.g. `xrpl`) with **451 Unavailable For Legal Reasons**. This project no longer depends on those packages (legacy Trezor wallet bundle removed).

If install still fails:

```bash
# Project .npmrc already points at registry.npmjs.org — verify it is not overridden:
npm config get registry

# If it shows mirrors.tencentyun.com, reset for this project:
npm install --registry=https://registry.npmjs.org/
```

### Bulk buy failures

- **Insufficient balance** — need SOL for swaps + fees
- **No valid quotes** — token may lack Jupiter liquidity
- **Invalid mint** — verify address on [Solscan](https://solscan.io)

### Discord notifications

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ENABLE_DISCORD_NOTIFICATIONS=true
```

---

## Project structure

```
src/
├── app/
│   ├── api/              # REST routes (trending, dlmm, trading, mcap, …)
│   └── (trade)/dev/      # Dev dashboards
├── components/           # UI + WalletProvider
├── hooks/                # React Query hooks
├── types/                # TypeScript types
└── utils/                # Jupiter, DLMM, Supabase, RPC helpers

supabase/
└── schema.sql            # Full database schema (run once in SQL Editor)

main.go                   # Go cron scheduler
docker-compose.yml        # web + cron services
scripts/docker-up.sh      # Build + start helper
```

---

## Security

- Verify token mint addresses before buying
- Start with small amounts and `DLMM_DRY_RUN=true`
- Never commit `.env` or `TRADING_KEYPAIR_JSON` to git
- Restrict cron secrets in production
- Check transaction signatures on Solscan after execution

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes and run `npm run type-check`
4. Submit a pull request

## License

MIT License — see LICENSE file for details.

## Disclaimer

This software is provided as-is. Always verify transactions and use at your own risk. The developers are not responsible for any financial losses.
