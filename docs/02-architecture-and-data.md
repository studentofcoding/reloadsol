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
| `token_risk_features`, `dev_reputation` | Shadow risk (48/49/53): per-token RugCheck features + per-creator dev verdict (with top-10 tokens by ATH, and the user-labelled rug count). Display-only, `mode` is `shadow` until the correlation is significant |
| `trending_token_tracker` (+`_dev`), `trending_token_summary` | Bot tracking rows: status `waiting/tracking/won/lost/skipped/stopped`, `trading_simulation`, `price_history`; daily rollups |
| `sl_tp_positions` | Manual/bot stop-loss & take-profit positions |
| `strategy_definitions`, `strategy_outcomes` | Strategy overrides (`chain` since 24) + closed-trade results for Reports/ML |
| `dlmm_agent_config`, `dlmm_candidates`, `dlmm_positions` (+ RH CLMM ledger tables with `pool_key`/`fee`/`tick_spacing`, migration 25) | Meteora DLMM + RH v3/v4 CLMM agent |
| `token_mcap_tracking`, `mcap_social_pattern_24h`, `market_regime_tags` | Mcap milestones + ML cohort snapshots (chain-stamped 26) |
| `social_token_events`, `social_token_rollups`, `tracked_wallets` | Social ingest + smart-wallet tracking (chain-stamped 27) |
| `bot_job_locks`, `bot_trade_locks`, `bot_trading_state` | Locks + circuit breaker for bot cycles |

**Social + Token Info are sol-only by design.** `social_token_events`, `social_token_rollups`,
`tracked_wallets` and the `token_info_detect` Freeview ledger are written for `chain = 'sol'` only
— the Robinhood twins are deliberately unwired (same "RH fog" as the macro/token-info work). The
`chain` columns exist so a later wire needs no new table, but today a query filtered on
`chain = 'robinhood'` against those tables returns nothing. The export's social sheets
(`social_rollups`, `social_enriched`, `mention_top`, and the `ledger_*` columns) inherit that
scope; only the mcap-pattern sheets carry RH rows.

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

### SOL / native price: one live source, never a literal

The app has exactly one price source, read live, and **no hardcoded fallback anywhere**:

- Server: `getSolPriceUSDCore()` (`src/utils/sol-price-core.ts`) — Bybit → CoinGecko/Jupiter in
  parallel, backed by a 30 s cache (+5 min stale). `/api/solprice` exposes it.
- Client: `useSolPrice()` (`src/hooks/useSolPrice.ts`) over `/api/solprice`.

When no source has ever returned a price, both report **unavailable** (`price: 0`,
`source: 'unavailable'`, HTTP 503 from the route) rather than a made-up number. Callers then take
their own `> 0` branch or render an explicit placeholder (`—`) — a fabricated rate is
indistinguishable from a real one downstream, so a displayed estimate or a recorded `solPriceUsd`
would be wrong without anyone noticing. `solPriceUsd` recorded on a trade is the **trade-time**
price taken from this same source, which is why history stays valid when the current price moves.

Enforced by `npm run verify:no-hardcoded-sol-price` (part of the verify gate): it scans
`src/**` for a literal feeding a price expression, so the retired `145` sentinel cannot come back.

### Strategy-outcome regime context: stamped at close, not a column

`market_regime_tags` is keyed by `tag_date` (`DATE PRIMARY KEY`) — **one regime per day**. The outcome
writer stamps it at close: `insertStrategyOutcome` (`src/strategies/db.ts`) resolves
`loadRegimeTagForDate(exitAt.slice(0, 10))` and records it with the row.

So there is deliberately **no `regime_tag_at_exit` column**, and per-close analysis does not need one:

- The stamped value is the regime **at the moment of that close**. The table's row for the same day
  holds the day's *latest* state (the writer rewrites it whenever the climate moves). The stamp is
  therefore the more accurate of the two, not a cache of it.
- A dedicated column would carry identical resolution and gain a second thing to keep in sync.

Two operational facts worth knowing when reading it:

- **The daily row is written by the mcap sim worker** (`/api/mcap-tracking/sim-track`, plus the
  on-demand `POST /api/strategies/regime`). That is a market-wide value recorded by one strategy's
  worker, so a day on which that worker does not run has no row, and its closes carry no regime. A
  strategy-agnostic daily writer (the `pnl_update` worker is the natural home) would remove that
  coupling.
- **History is not backfillable.** The climate was not recorded before the upsert existed — only 5
  rows exist, one of them from the automated path — so older closes are honestly left untagged rather
  than reconstructed.

### Execution cost model (`src/strategies/execution-model.ts`)

What the paper desk charges per fill, and why the defaults are what they are:

| Constant | Default | Basis |
| --- | --- | --- |
| `SIM_FEE_BPS` | **12** | measured round trip on a live pair (STONK: buy 0.005 SOL implied 0.00223860 SOL/token, sell 100 tokens implied 0.00223276) — **~26 bps total**, ~12 bps/side, the AMM fee at those sizes |
| `SIM_SPREAD_BPS` | **0** | on an AMM route the fee *is* the round-trip cost; a separate spread term double-counts it |
| `SIM_PRIORITY_FEE_QUOTE` | **0.00003** | what the app actually sends (30,000 lamports); the chain's recent ask is ~0 (`getRecentPrioritizationFees` → 0 micro-lamports/CU over 150 slots, globally and for Jupiter-program transactions) |
| `SIM_IMPACT_COEFF` / `_EXPONENT` | 1 / 1 | exact constant-product average-price impact |

The previous defaults (100 bps fee + 50 bps spread **per side** = 300 bps, and a 0.002 priority fee)
modelled **300 bps round trip against a measured 26**, and the priority term alone
(`0.002 x 2 x 17,684 ≈ 70 SOL`) was the whole `-61.78` drag the 14-day ledger showed against a `+0.33`
gross. That drag was a modelling artefact, which is why the ledger now exposes
`summary.costModel` and `/dev/paper-trade` renders it: a paper edge is only real once the cost
constants are.

**Sizing follows the fixed cost.** A round trip costs ~0.00006 SOL in priority fee + tx fees regardless
of size, so the fixed cost is ≤1% of a trade at **≥0.006 SOL**. The design size (0.005 SOL) sits at that
edge; the desk's actual mean (~0.0017 SOL) is ~3x below it, which is where the remaining drag comes from.

### Paper-desk readiness: what the dashboard measures, and what it refuses to

`/dev/paper-trade` answers one question — is a strategy worth arming — and the value is in what it
declines to report.

**Source.** The per-token table is the **ledger**: `summarizeLedgerPositions`
(`src/strategies/ledger-pnl.ts`) rebuilds each position from the raw `trading_records` legs
(`proceedsSol += tokenSol` on sells, `pnlPct = pnlSol / costSol`). It never reads the writer's exit
valuation, so it is only as good as the legs — which is why the next two rules exist.

**Pre-fix positions are excluded, not summed.** The old writer stamped `const sellPriceUsd = 0.000001`
in place of an exit valuation, so those positions compute proceeds ~0 and read as −99%. They are a data
defect, not a loss. `isNominalPrice` detects exactly that sentinel — a genuine rug records a *real* tiny
price and is left alone — and such positions carry `nominalLegs`: listed, but measured out of every
aggregate. `summarizeLedger` reports `nominalPositions` and `buildStrategyReadiness` reports
`excludedNominal` per strategy, so the omission is visible rather than silent. Measured at the fix:
**967 of ~17.7k positions** in a 3-day window.

**Per-strategy readiness** (`buildStrategyReadiness`): median return per trade (never a mean — one
5,000% winner carries it), median stake, gross, the calibrated drag, **net per trade**, and **peak
concurrent positions** (`peakConcurrentPositions`, interval overlap) — the number that has to fit
`MAX_SOL_AT_RISK` at the live size.

**The sample floor is a view, not a computation.** Below `READINESS_MIN_SAMPLE` (default 30) counted
closes, `verdict` reads `insufficient`; `verdictUngated` always carries the raw judgement and
`minSample` the floor, so a UI toggles between them with no round trip. A median on a handful of trades
is noise, and "no result yet" must not read as a result.

**Stakes are post-regime.** Every sim stake is its base multiplied by the brain's `sizeScale` —
`/api/regime/climate` returns it (`{ state, sizeKind, cascadeVeto, scale }`), and the recipe grid is
`Hype 1 · Range 0.75 · Mixed 0.5 · De-risk 0.25 · Cash 0`. So a small median stake is usually the
regime trimming risk, not a weak strategy; the readiness header states the multiplier beside the table.
Sizing to clear a fixed cost at *today's* climate is fragile — at De-risk (0.25) the stake is a quarter
of the same base in Hype.

## 4. Data flows (representative)

| Flow | Path |
|---|---|
| **RPC proxy** | Browser/server → `GET/POST /api/rpc` (`src/app/api/rpc/route.ts`) → Shyft (or Raptor) RPC list with failover + per-endpoint health; RH RPC via `/api/rh/rpc` |
| **Jupiter pricing** | `/api/tokens/prices`, `/api/jupiter/*` proxy Jupiter; open-card marks come from a shared GMGN + Redis + SSE feed with Jupiter fallback (SSE via `/api/trading/subscribe`; 8s polling fallback) |
| **Solana swaps (desk)** | Jupiter Swap V2 `/api/jupiter/quote` → wallet-signed v0 → `/api/rpc` or Shyft send; Lite `/api/jupiter/lite/*` only when V2 fails |
| **Solana swaps (arb)** | Raptor `quote-and-swap` / send / status through `/api/solanatracker/{quote,swap,send,transaction}` (server-side, `maxHops` set) |
| **RH Kyber routes+swap** | `/api/kyber/routes` (GET tokenIn/tokenOut/amountIn) and `/api/kyber/build` (POST routeSummary/sender/recipient/slippage) proxy Kyber (`https://aggregator-api.kyberswap.com/robinhood/api/v1/…`); browser helpers `clientKyberRoute` / `clientKyberBuild` (`src/utils/kyber-aggregator.ts`) |
| **RH GMGN trades** | `/api/gmgn/trade/quote` · `/api/gmgn/trade/swap` (`confirmed:true`; `from` must equal the GMGN-bound address for the chain) · `/api/gmgn/trade/order?chain&orderId` status poll |
| **Solana token holdings** | `/api/shyft/wallet/all_tokens` — cached Shyft `all_tokens` (15s fresh / 120s stale, `fresh=1` after trade); Jupiter Portfolio fallback (`/api/jupiter/portfolio`); RPC `fetchUserTokens` last resort |
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
