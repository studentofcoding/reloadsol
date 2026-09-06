# ReloadSOL — Architecture & Data

Condensed, codebase-accurate view of the deployment topology, persistence layer,
trading-records model, data flows, and deploy model. Sources: `docs/architecture.md`,
`docs/API_ARCHITECTURE_SUMMARY.md`, `docs/ARCHITECTURE_SUMMARY.md`, `README.md`, plus
the SQL and source files cited inline.

## 1. Topology

> **Diagram:** [System architecture on one VPS](./diagrams/03-system-architecture.html).

ReloadSOL is a **Docker Compose stack** on one VPS. A Next.js app serves UI + API and
a Go service drives scheduled workers; all app data lives in Postgres `reloadsol_db`.

| Service (container) | Process | Role |
|---|---|---|
| `reloadsol-web` | Next.js App Router (`Dockerfile.web`) | SSR UI, ~50 API routes under `src/app/api/**`, server actions under `src/actions/**`, ONNX ML shadow scorers (artifacts bind-mounted ro) |
| `reloadsol-cron` | Go scheduler (`main.go`, `worker_tracker.go`, `Dockerfile.cron`) | Cron jobs (`/trigger/*` guarded by `X-Trigger-Secret`): trending, signals, mcap, GMGN, social, DLMM, **RH LP screen**, **strategy search**, **fomo_ws**, RH CLMM manage (alert-only), strategy report, SL/TP, PnL, SOL arb |
| `reloadsol-db` | `postgres:16-alpine`, 768MB cap | Postgres 16; schema auto-applied from `db/init/*.sql` (`/docker-entrypoint-initdb.d`) |
| `reloadsol-bouncer` | PgBouncer (transaction pool, SCRAM) | App connects `DATABASE_URL` → bouncer → db; `DATABASE_URL_DIRECT` bypasses for psql/pgcopydb |
| `reloadsol-nginx` | nginx | Public `:80` edge — reverse proxy + cache (`X-Cache-Status: HIT`); prod hides web `:3000` |
| `reloadsol-redis` | redis:7-alpine, 96MB LRU | Shared API cache, job locks, alert throttles; in-memory fallback when absent |
| `reloadsol-social-ingest` | Telethon sidecar | Telegram channels → `POST /api/social/ingest` |

Wiring: cron calls the web service at `API_BASE_URL` / `API_HOST`
(`http://web:3000` in compose; `http://127.0.0.1` via nginx on prod); the Workers tab
reads cron at `CRON_SERVICE_URL` (`http://cron:8080`). `npm run dev` alone runs no
cron. Named volumes: `postgres_data`, `redis_data`, `nginx_cache`.

### Web-side structure

- **API routes**: `src/app/api/<domain>/route.ts` — e.g. `trading/records`,
  `trading/subscribe`, `rpc`, `buy`, `kyber/{routes,build}`, `gmgn/trade/{quote,swap,order}`,
  `rh/wallet-tokens`, `solanatracker/*`, `trending/*`, `dlmm/*`, `watchlist`.
- **Server actions** (`'use server'`): session-guarded DB writes with cache-tag
  invalidation — `src/actions/records.ts` (`addTradingRecord`, `updateTradingRecord`,
  `deleteTradingRecord`), `src/actions/watchlist.ts`, etc.
- **Auth tiers** (`src/utils/api-auth.ts`, `src/config/api-access.ts`): public
  (`/api/health`, `/api/rpc`, `/api/solprice`) · wallet (signed session cookie,
  `WALLET_SESSION_SECRET`) · dev (dev-wallet whitelist) · service (cron secret /
  bearer / UA). RH routes accept a `0x` wallet instead of a Sol session because the
  RH network is already dev-gated client-side.

## 2. Persistence (Postgres `reloadsol_db`)

Canonical schema: `db/init/*.sql` — `02-schema.sql` plus numbered migrations
`04`–`29` (applied on first `docker compose up` on an empty volume, or via
`bash scripts/deploy-tencent.sh schema`). `29-rh-lp-candidates.sql` chain-scopes DLMM
tables and adds FOMO trader/closed snapshots. `supabase/schema.sql` is a legacy mirror.

**`trading_records`** stores history as a **JSONB `data` column** with denormalized
`wallet_address`, `operation_type`, `timestamp`, and `chain` (default `sol`; index
`(wallet_address, chain, timestamp DESC)` — migration `23-app-network-chain.sql`).
Wallet+chain scoped rows are also the unit of the Redis/in-memory cache.

Key tables (02-schema + migrations):

| Table | Purpose |
|---|---|
| `trading_records` | Per-operation history (manual + bot); JSONB `data`, `chain` |
| `token_operations` | Per-wallet aggregates: swap/close counts, sol balance, `trade_pnl` |
| `wallet_watchlist` | Per-wallet watchlist; unique per `(wallet, token, chain)` |
| `trading_signals`, `token_rug_list`, `dlmm_potential_list` | Label lists — all chain-stamped (23) |
| `trending_token_tracker` (+`_dev`), `trending_token_summary` | Bot tracking rows: status `waiting/tracking/won/lost/skipped/stopped`, `trading_simulation`, `price_history`; daily rollups |
| `sl_tp_positions` | Manual/bot stop-loss & take-profit positions |
| `strategy_definitions`, `strategy_outcomes` | Strategy overrides (`chain` since 24) + closed-trade results for Reports/ML |
| `dlmm_agent_config`, `dlmm_candidates`, `dlmm_positions` (+ RH CLMM ledger tables with `pool_key`/`fee`/`tick_spacing`, migration 25) | Meteora DLMM + RH v3/v4 CLMM agent |
| `token_mcap_tracking`, `mcap_social_pattern_24h`, `market_regime_tags` | Mcap milestones + ML cohort snapshots (chain-stamped 26) |
| `social_token_events`, `social_token_rollups`, `tracked_wallets` | Social ingest + smart-wallet tracking (chain-stamped 27) |
| `bot_job_locks`, `bot_trade_locks`, `bot_trading_state` | Locks + circuit breaker for bot cycles |

**Redis cache + invalidation**: `src/utils/redis-cache.ts` wraps ioredis with a
memory fallback (keys like `records:<wallet>:<chain>:<limit>`, 10s TTL).
Trading-record reads go through `src/utils/trading-records-cache.ts`
(`getCachedRecords`/`setCachedRecords`, request dedupe, LRU cap); every
insert/update/delete calls `invalidateTradingRecordsCache(wallet)` — clears memory
entries and `DEL records:<wallet>:*` in Redis — and the server action also runs
`updateTag(CACHE_TAGS.records(wallet))` (`src/actions/records.ts`).
`afterTradingRecordInserted` (`src/utils/trading-records-db.ts`) additionally fires an
SSE broadcast.

**SSE**: `GET /api/trading/subscribe?wallet=<addr>`
(`src/app/api/trading/subscribe/route.ts`) holds one stream per wallet (15s keepalive,
30s cleanup sweep, wallet dedupe). `POST /api/trading/subscribe` — invoked by
`broadcastTradeUpdateServer` (`src/utils/trading-notifications.ts`) — fans out
`trade_update` / `pnl_update` / `balance_update` events to that wallet's live
connections.

## 3. Trading-records model (`TrackingRecord`)

Type in `src/utils/trading-tracker.ts`; stored in `trading_records.data` JSONB.

| Field | Meaning |
|---|---|
| `id`, `walletAddress`, `timestamp` | Identity; rows are per wallet + chain |
| `operationType` | `buy` \| `sell` \| `close` |
| `chain` | `sol` \| `robinhood` (missing → `sol` for legacy rows) |
| `tokens[]` | Legs: `mintAddress`, symbol/name/logo, `tokenAmount`, per-leg `solAmount`, USD price at op time |
| `successCount`, `failureCount`, `totalTokens` | Per-operation leg outcomes (success only on confirmed settlement) |
| `solAmount`, `feesPaid`, `solPriceUsd`, `totalUsdValue` | Financials ("SOL" naming reused for RH ETH — nativeAmount rename pending, REL-1) |
| `signatures[]` | Tx hashes (GMGN legs: `orderId`/`hash`) |
| `txStatus?` | `'pending'` at submit; promoted `'confirmed'` (receipt success) / `'failed'` (revert, reject, batch non-success) — see product doc §5 |
| `status?` | Strategy lifecycle `waiting/tracking/won/lost/skipped` |
| `errors?`, `slippage`, `priorityFee`, `jupiter_swap`, `swap_route` | Extra metadata; plus bot/sim flags (`is_bot_operation`, `bot_strategy`, `is_simulation`, …) |

`shouldSkipTradingRecord` drops error- or failed-only payloads. `trackOperation` /
`updateRecord` write through the server action when online and queue to a
per-wallet+chain `localStorage` offline cache otherwise (re-synced on reconnect);
memory cache, offline keys and API queries are all `wallet:chain` scoped.

## 4. Data flows (representative)

| Flow | Path |
|---|---|
| **RPC proxy** | Browser/server → `GET/POST /api/rpc` (`src/app/api/rpc/route.ts`) → Shyft (or Raptor) RPC list with failover + per-endpoint health; RH RPC via `/api/rh/rpc` |
| **Jupiter pricing** | `/api/tokens/prices`, `/api/jupiter/*` proxy Jupiter; open-card marks come from a shared GMGN + Redis + SSE feed with Jupiter fallback (SSE via `/api/trading/subscribe`; 8s polling fallback) |
| **Solana swaps** | Raptor quote-and-swap / send / status through `/api/solanatracker/{quote,swap,send,transaction}` (server-side) |
| **RH Kyber routes+swap** | `/api/kyber/routes` (GET tokenIn/tokenOut/amountIn) and `/api/kyber/build` (POST routeSummary/sender/recipient/slippage) proxy Kyber (`https://aggregator-api.kyberswap.com/robinhood/api/v1/…`); browser helpers `clientKyberRoute` / `clientKyberBuild` (`src/utils/kyber-aggregator.ts`) |
| **RH GMGN trades** | `/api/gmgn/trade/quote` · `/api/gmgn/trade/swap` (`confirmed:true`; `from` must equal the GMGN-bound address for the chain) · `/api/gmgn/trade/order?chain&orderId` status poll |
| **RH token holdings** | `/api/rh/wallet-tokens` — GMGN holdings normalized first, then **Blockscout** ERC-20 (`https://robinhoodchain.blockscout.com`, `/api/v2/address/…/tokens`), then RPC ERC-20 fallback; WETH/USDG quote tokens always injected; Redis 20s fresh / 120s stale (`src/utils/rh-wallet-holdings.ts`) |
| **Trading records** | UI `tradingTracker` → server action `addTradingRecord` / `updateTradingRecord` (`src/actions/records.ts`) → `trading_records` → cache invalidate → SSE `trade_update` → `GET /api/trading/records?wallet&chain&limit` refetch |
| **Worker cycles** | Go cron → `POST /api/<domain>/track|sim-track|manage|screen|summary|update` (service auth) → strategies (`src/strategies/**`) → DB tables + Discord/Telegram alerts |

## 5. Deploy model (summary)

- **Host builds, containers run.** `npm run build` produces `.next/standalone`
  (`output: 'standalone'`); `Dockerfile.web` is a runner-only `node:20-slim` image
  that `COPY`s `.next/standalone`, `.next/static` and `public`, then runs
  `node server.js` (`src` changes → `--web-only`). `Dockerfile.cron` compiles the Go
  sources in a `golang:1.22-alpine` builder into a static binary on `alpine:3.19`
  (`*.go` changes → `--cron-only`).
- **Scoped deploy**: `scripts/docker-deploy.sh --web-only | --cron-only |
  --social-only | --db-only | --infra-only | --all | --auto` (plus
  `scripts/deploy-tencent.sh` subcommands and `scripts/docker-scope.sh detect` for
  auto-scoping from `git diff`). nginx/redis/db deploy as infra — `--infra-only` /
  `--db-only` skip the npm build.
- **Prod overlay** (`docker-compose.prod.yml`) adds the nginx edge + prod env;
  `docker-compose.yml` runs all core services with healthchecks
  (`depends_on: service_healthy`, e.g. cron waits on web).
- **Post-deploy**: `scripts/warm-cache.sh` hits `/api/solprice`, `/api/trending`,
  `/api/trending/stats`, `/api/rpc/health`; `scripts/deploy-smoke-scopes.sh` runs
  smoke checks; schema re-apply via `bash scripts/deploy-tencent.sh schema`; ML
  artifacts are trained on the host and ro-mounted into the web container
  (`ml/artifacts`).
