# ReloadSOL

Next.js + Go-cron Solana trading platform: bulk token buys, trending tracker, mcap analytics, SL/TP monitoring, and an autonomous Meteora DLMM agent. Bulk buy/sell uses Solana Tracker Raptor; Jupiter Portfolio for wallet tokens; Shyft RPC via `/api/rpc`; Docker Postgres + PgBouncer for persistence; and Jupiter [Wallet Kit](https://developers.jup.ag/docs/tool-kits/wallet-kit) for universal wallet connectivity.

## Features

- **Bulk token purchase** — buy up to 10 tokens in one flow via Raptor
- **Universal wallet** — Phantom, Solflare, Backpack, Jupiter Wallet, mobile QR, and 20+ Wallet Standard wallets
- **Trending tracker** — 24/7 monitoring, win/loss stats, Discord alerts
- **MCap tracker** — growth thresholds, labels
- **SL/TP monitor** — automated stop-loss / take-profit positions
- **DLMM agent** — Hunter screener + Healer manager for Meteora pools (`/dev/dlmm`)
- **Docker stack** — one command runs Next.js web + Go cron locally or in production

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Node.js](https://nodejs.org/) | 20+ | Host build for Docker prod mode |
| [Docker](https://docs.docker.com/get-docker/) | 24+ with Compose v2 | Recommended for full stack (includes Postgres + PgBouncer) |
| Postgres | 16 | Runs in Docker (`reloadsol-db` + `reloadsol-bouncer`) |
| [Shyft RPC](https://shyft.to/) API key | — | Replaces legacy Helius setup |

Optional: Discord webhook, Telegram bot token (DLMM alerts), trading keypair for live bot trading.

### Native deps (Solana / bigint-buffer)

`@solana/web3.js` uses native `bigint-buffer` bindings for performance. npm **`overrides`** pin **`bigint-buffer-fixed@1.1.6`** (CVE-2025-3194). Postinstall rebuilds native addons once when build tools are present; skips if `bigint_buffer.node` is already up to date. Force rebuild: `npm run rebuild:native`. Set `SKIP_NATIVE_REBUILD=1` to skip (e.g. Docker image already rebuilt).

| OS | Install |
|----|---------|
| macOS | `xcode-select --install` |
| Debian/Ubuntu | `sudo apt install -y build-essential python3` |
| Alpine (Docker) | `python3 make g++` (included in project `Dockerfile`) |

---

## Quick start (Docker — recommended)

```bash
git clone https://github.com/studentofcoding/reloadsol.git
cd reloadsol

npm install
cp .env.docker.example .env
# Edit .env — at minimum: POSTGRES_PASSWORD, DATABASE_URL, SHYFT_API_KEY, RPC_URL

# Postgres schema is applied automatically on first docker compose up (db/init/)
npm run docker:up
```

Open [http://localhost:3000](http://localhost:3000). Cron health: [http://localhost:8080/health](http://localhost:8080/health).

### Documentation

| Doc | Use when |
|-----|----------|
| [handoff.md](handoff.md) | Session handoff — Pattern ML focus, ops checklist |
| [docs/ARCHITECTURE_SUMMARY.md](docs/ARCHITECTURE_SUMMARY.md) | Whole picture — algo, Pattern ML, next steps |
| [docs/algo_overview.md](docs/algo_overview.md) | Per-strategy capture/calculate/result, workers |
| [docs/OPERATOR_STATE.md](docs/OPERATOR_STATE.md) | Live ops, retrain loops, model constraints |
| [docs/GMGN_STRATEGY.md](docs/GMGN_STRATEGY.md) | GMGN activity poll, Radar (Early bridge), sim |
| [docs/architecture.md](docs/architecture.md) | System topology, tables, deploy model |
| [ml/README.md](ml/README.md) | Pattern ML export/train on host |

Production DB: Docker Postgres **`reloadsol_db`** only (Supabase cut off). Schema: [`db/init/`](db/init/).

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
# Postgres (Docker compose starts reloadsol-db + reloadsol-bouncer)
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql://postgres:change-me@reloadsol-bouncer:5432/reloadsol_db

# Shyft — https://shyft.to dashboard (server-side RPC via /api/rpc proxy)
# Wallet tokens: Jupiter Portfolio via /api/jupiter/portfolio (both /buy and /sell)
# Swaps: Solana Tracker Raptor (bulk /sell and /buy); GMGN charts only (no GMGN swap execution)
# Browser RPC is proxied through /api/rpc — NEXT_PUBLIC_RPC_URL is optional
SHYFT_API_KEY=your-shyft-api-key
RPC_URL=https://rpc.shyft.to?api_key=your-shyft-api-key,https://api.mainnet-beta.solana.com
# NEXT_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com
```

See [Environment variables](#environment-variables) for the full list.

### 3. Database

**Fresh Docker setup:** schema is applied automatically on first `docker compose up` via [`db/init/`](db/init/) (extensions + full app schema in `02-schema.sql`).

**Existing volume or fresh redeploy:** apply schema from the repo (empty tables, no historical data):

```bash
bash scripts/deploy-tencent.sh db
bash scripts/deploy-tencent.sh schema    # idempotent — safe to re-run
```

**Historical note:** production has migrated off hosted Supabase to Docker `reloadsol_db`. One-time migration script: `bash scripts/migrate-from-supabase.sh` (pgcopydb; connect to `reloadsol-db` directly, not PgBouncer).

Tables include: `token_operations`, `trading_records`, `trading_signals`, `sl_tp_positions`, `trending_token_tracker`, `token_mcap_tracking`, DLMM tables, social signal tables, and bot lock tables.

Verify after deploy: `GET /api/dlmm/health` and `GET /api/health`

### 4. Run with Docker

Docker runs core services (prod overlay adds **nginx** edge cache + **redis**):

| Service | Container | Port | Role |
|---------|-----------|------|------|
| **reloadsol-db** | `reloadsol-db` | 5432 (internal) | Postgres 16 |
| **reloadsol-bouncer** | `reloadsol-bouncer` | 5432 (internal) | PgBouncer transaction pool |
| **reloadsol-nginx** | `reloadsol-nginx` | 80 (public) | Reverse proxy + edge cache |
| **redis** | `reloadsol-redis` | 6379 (internal) | Shared API cache |
| **web** | `reloadsol-web` | 3000 (internal) | Next.js app + API routes |
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

### Scoped deploy (VPS)

Use [`scripts/deploy-tencent.sh`](scripts/deploy-tencent.sh) or [`scripts/docker-deploy.sh`](scripts/docker-deploy.sh) flags:

| Command | Rebuilds | Runs `npm run build`? |
|---------|----------|------------------------|
| `bash scripts/deploy-tencent.sh deploy web` | web (+ social) | Yes |
| `bash scripts/deploy-tencent.sh deploy cron` | cron | No |
| `bash scripts/deploy-tencent.sh deploy db` | Postgres + PgBouncer | **No** |
| `bash scripts/deploy-tencent.sh deploy infra` | nginx + redis | **No** |
| `bash scripts/docker-deploy.sh --db-only` | db only | **No** |
| `bash scripts/docker-deploy.sh --infra-only` | infra only | **No** |

Scope detection: `bash scripts/docker-scope.sh detect --base HEAD~1`  
Smoke test: `bash scripts/deploy-smoke-scopes.sh`

Post-deploy, `scripts/warm-cache.sh` hits `/api/solprice`, `/api/trending`, `/api/trending/stats`, `/api/rpc/health` (auto-run after web/infra deploy).

### Post-deploy verification

| Check | How |
|-------|-----|
| Edge cache | Repeat `curl -I https://reloadsol.app/api/solprice` — look for `X-Cache-Status: HIT` |
| Redis memory | `docker exec reloadsol-redis redis-cli INFO memory` (stay under ~96MB) |
| Raptor swaps | LiveTab single buy/sell; bulk buy/sell on `/buy` `/sell` |
| No home polling | Wallet on `/` or `/blog` — no `/api/trading/records` in Network tab |
| Jupiter widget | `/swap` loads terminal; other routes do not fetch `terminal.jup.ag` |

**How it works:** `scripts/docker-up.sh` runs `npm ci` first, then builds Next.js on the host for prod (`npm run build` → `.next/standalone`) and packages via `Dockerfile.web`. **`docker:deploy`** uses `scripts/docker-scope.sh` to rebuild only web or cron when possible (frontend-only changes do not restart cron). Dev default is **web only**; use `docker:dev:full` when you need cron locally. Cron calls the web service at `API_HOST=http://web:3000`.

Named volumes: `postgres_data` (positions + worker runtime), `redis_data` (cache), `nginx_cache`. `docker compose down` keeps them; `down -v` wipes them.

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
| `POSTGRES_PASSWORD` | Postgres superuser password |
| `DATABASE_URL` | App connection via PgBouncer (`reloadsol-bouncer:5432` in compose) |
| `DATABASE_URL_DIRECT` | Direct Postgres URL for pgcopydb/psql (`reloadsol-db:5432`) |
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
- Consolidated Postgres schema — [`db/init/`](db/init/) (canonical); [`supabase/schema.sql`](supabase/schema.sql) legacy mirror
- GMGN kline charts on DLMM Hunter candidates

**Changed**
- RPC migrated to **Shyft** (`SHYFT_API_KEY` / `RPC_URL`); Helius removed
- `WalletProvider` uses Jupiter `UnifiedWalletProvider`
- Docker uses host-side Next.js build + `Dockerfile.web` standalone image

**Fixed**
- Docker web OOM during in-container builds
- DLMM dashboard graceful fallbacks when Postgres is unreachable
- Schema ordering for existing databases (`label` column patches via `db/init/`)

See [CHANGELOG.md](./CHANGELOG.md) for complete release notes.

---

## Troubleshooting

### Database unreachable or empty dashboards

- Confirm `DATABASE_URL` points at `reloadsol-bouncer` (not `reloadsol-db`) for the app
- Fresh install: `docker compose up` applies `db/init/*.sql` on empty volume
- Re-apply schema: `bash scripts/deploy-tencent.sh schema` or `docker exec reloadsol-db psql -U reloadsol -d reloadsol_db`
- Rebuild: `npm run docker:down && npm run docker:up`

### DLMM manage returns `skipped`

- Schema not applied — run `docker compose up` on fresh volume or migrate with pgcopydb
- Check `GET /api/dlmm/health` for the exact reason

### Cron 500 errors

- Ensure web container is healthy before cron starts (`depends_on: service_healthy`)
- Check `npm run docker:logs` for the underlying API error

### Wallet won't connect

- Use HTTPS in production
- Install a Wallet Standard wallet extension (Phantom, Solflare, etc.)

### `npm install` fails on Tencent Cloud (HTTP 451 / `xrpl`)

Tencent's default npm mirror blocks some packages (e.g. `xrpl`) with **451 Unavailable For Legal Reasons**. This project no longer depends on those packages (legacy Trezor wallet bundle removed).

**One-shot Tencent deploy** (setup → DB → schema → build → deploy):

```bash
cp .env.docker.example .env   # edit POSTGRES_PASSWORD, secrets
bash scripts/deploy-tencent.sh all
bash scripts/deploy-tencent.sh smoke --strict
```

**Step-by-step:**

```bash
bash scripts/deploy-tencent.sh db
bash scripts/deploy-tencent.sh schema
bash scripts/deploy-tencent.sh deploy
bash scripts/deploy-tencent.sh smoke --strict
```

Subcommands: `setup` | `db` | `schema` | `migrate` | `build` | `deploy` | `smoke` | `backup` | `all`

**Cron shows "Database circuit open" (500/409):** the web process tripped an in-memory breaker after DB errors (often before schema apply, or a bad `DATABASE_URL`). After schema is OK:

```bash
bash scripts/recover-db-circuit.sh
# or manually: docker restart reloadsol-web && bash scripts/deploy-tencent.sh smoke --strict
```

Ensure `.env` `DATABASE_URL` uses host `reloadsol-bouncer`, user matches `POSTGRES_USER`, and URL-encodes the password if it contains `@`, `#`, `:`, or `%`.

**`wrong password type` through bouncer:** Postgres 16 uses SCRAM; PgBouncer needs `AUTH_TYPE: scram-sha-256` in [`docker-compose.yml`](docker-compose.yml). After pull: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d reloadsol-bouncer web`.

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
└── utils/                # Jupiter, DLMM, Postgres, RPC helpers

db/init/                  # Canonical Postgres schema (applied on docker compose up)
supabase/schema.sql       # Legacy mirror only — do not use Supabase dashboard
ml/artifacts/             # Pattern ML ONNX (bind-mounted into web container)

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
