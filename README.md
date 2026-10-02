# ReloadSOL

Next.js + Go-cron Solana trading platform: bulk token buys, trending tracker, mcap analytics, SL/TP monitoring, and an autonomous Meteora DLMM agent. Bulk buy/sell uses Solana Tracker Raptor for quotes/swaps; Shyft `all_tokens` (cached) for wallet holdings with Jupiter Portfolio fallback; Shyft `send_many_txns` for multi-tx sends; Docker Postgres + PgBouncer for persistence; and Jupiter [Wallet Kit](https://developers.jup.ag/docs/tool-kits/wallet-kit) for universal wallet connectivity.

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

Condensed entry points (5 categories + diagrams hub):

| Doc | Use when |
|-----|----------|
| [docs/README.md](docs/README.md) | **Start here** — category + diagram index |
| [docs/01-product-and-trading.md](docs/01-product-and-trading.md) | Product, networks, trading surfaces, swap execution, confirmation lifecycle |
| [docs/02-architecture-and-data.md](docs/02-architecture-and-data.md) | Topology, Postgres/Redis, records model, data flows, deploy model |
| [docs/03-strategies-and-automation.md](docs/03-strategies-and-automation.md) | Strategies/workers, sim vs live, kill switches |
| [docs/04-machine-learning.md](docs/04-machine-learning.md) | ML pipeline, artifacts, shadow-vs-enforce |
| [docs/05-operations-and-deployment.md](docs/05-operations-and-deployment.md) | Env keys, Docker stack, deploy runbook, ops |
| [docs/CLIMATE_GATE.md](docs/CLIMATE_GATE.md) | Optional S5 DLMM paper climate gate (default off; ask before live) |
| [docs/DATA_PUBLIC_SCOUT.md](docs/DATA_PUBLIC_SCOUT.md) | `/dev/insight` data-public scout + Safe-gated paper notes (no live exec) |
| [docs/STRATEGY_SCOUT.md](docs/STRATEGY_SCOUT.md) | `buybulk-datapublic-scout` vs `rhtape-datapublic-scout` (separate) |
| [handoff.md](handoff.md) | Session handoff — Pattern ML focus, ops checklist |

Diagrams: [`docs/diagrams/`](docs/diagrams/) (trading surfaces, confirmation lifecycle,
system topology, strategy engine, ML pipeline, deploy runbook).

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
# Wallet tokens: Shyft all_tokens via /api/shyft/wallet/all_tokens (cached; Jupiter Portfolio fallback)
# Swaps: Solana Tracker Raptor (bulk /sell and /buy; /sell custom outputMint optional); GMGN charts only (no GMGN swap execution)
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
| `bash scripts/ship-standalone-to-vps.sh` | web (on VPS from shipped `.next`) | On the **Mac/CI** machine, not the VPS |
| `bash scripts/deploy-tencent.sh deploy web` | web (+ social) | Only if standalone is missing **and** RAM ≥4Gi or `DEPLOY_ALLOW_HOST_BUILD=1` |
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

**How it works:** `scripts/docker-up.sh` runs `npm ci` first, then reuses a verified `.next/standalone` or builds Next.js on the host (`npm run build`) and packages via `Dockerfile.web`. Host `next build` is refused on &lt;4Gi RAM unless `DEPLOY_ALLOW_HOST_BUILD=1` — prefer [`scripts/ship-standalone-to-vps.sh`](scripts/ship-standalone-to-vps.sh). **`docker:deploy`** uses `scripts/docker-scope.sh` to rebuild only web or cron when possible (frontend-only changes do not restart cron). Dev default is **web only**; use `docker:dev:full` when you need cron locally. Cron calls the web service at `API_HOST=http://web:3000`.

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
| `DATABASE_POOL_MAX` | App pool size (code default `10`; **prod runs 25**). One client is held for the whole of a query *including the client-side parse*, so a multi-MB hydration occupies one for seconds. |
| `DATABASE_POOL_CONN_TIMEOUT_MS` | How long a query waits for a free client before failing (default `5000`). This is the `timeout exceeded when trying to connect` message. |
| `DB_SLOW_QUERY_MS` | Any query holding a client longer than this is logged as `[db-slow-query]` with its SQL and caller frames (default `5000`; `0` off). Slow queries never error — they fail their *neighbours*, so this is the only way to see them. |
| `SHYFT_API_KEY` | Shyft dashboard API key — `all_tokens` holdings, `send_many_txns` batch sends, and `/api/rpc` fallback |
| `RPC_URL` | Comma-separated RPC URLs (max 5). Server `/api/rpc` proxy with failover. |
| `NEXT_PUBLIC_RPC_URL` | Optional — browser uses `/api/rpc` proxy by default; set only for legacy direct-RPC paths. |
| `RAPTOR_API_BASE` | Optional override for Solana Tracker Raptor swap API (default `https://raptor-beta.solanatracker.io`) |
| `RAPTOR_MAX_HOPS` | Hop ceiling for a route touching SOL/USDC/USDT (default `1` — those usually have a direct pool). Arb uses `RAPTOR_MAX_HOPS_ARBITRAGE`. **The pool assumption is direction-dependent**: measured 2026-10-01, 8 of 40 real mints had no direct SOL pool on a **SOL→token** buy and failed at `1`. That no longer surfaces as a failure — a no-route answer now retries once at a wider ceiling on the free lane (`escalateRaptorHops`) instead of escalating to the keyed Jupiter picker |
| `RAPTOR_TOKEN_TOKEN_HOPS` | Hops for a token→token pair, where no direct pool exists (default `3`). **Do not raise `RAPTOR_MAX_HOPS` to fix a token→token quote** — at `1` Raptor answers `500 "No direct route found"`, which escalated to the Jupiter picker and spent the 0.5 rps execution budget. Resolved per pair by `src/utils/raptor-hops.ts`; set `=1` to restore the old behaviour exactly |
| `JUPITER_MAX_RPS` | Sustained Jupiter rate (default `0.5`, the measured-clean rate) |
| `JUPITER_BURST` | Bucket capacity (default `8`; measured tolerance is ~8 sequential before 429) |
| `JUPITER_TRADE_RESERVE` | Tokens held for the trade lane, never spent by background work (default `2`) |
| `JUPITER_QUOTE_CACHE_MS` | Coalescing/quote cache window for non-taker quotes (default `4000`) |
| `SWAP_PRIORITY_FEE_LAMPORTS` | Exact priority-fee tip for a swap build when the caller passes **no** fee. Unset (default) → auto-high, a 0.003 SOL *cap* rather than a flat charge; a caller-supplied fee always wins. A tx broadcast with no tip is how one lands nowhere |
| `READINESS_MIN_SAMPLE` | Counted closes required before `/dev/paper-trade` gives a readiness verdict (default `30`); below it the verdict reads `insufficient`, and the UI can toggle the gate off |
| `WALLET_SESSION_SECRET` | httpOnly wallet session cookie signing |

### Solana Tracker OHLC

Chart fetches (`GET {origin}/chart/{token}`, response `oclhv`) use `SOLANATRACKER_DATA_API_BASE`, or `SOLANATRACKER_CHART_BASE` when that is set. Both are an origin (a trailing `/chart` is ignored). Unset defaults to `https://ivory-badger-5278.secure.data.solanatracker.io`. Hosts under `*.secure.data.solanatracker.io` authenticate by subdomain — do not send `x-api-key` or `api_key`. The public host `https://data.solanatracker.io` is used only when configured, and then `SOLANATRACKER_DATA_API_KEY` is sent as `x-api-key`. Empty Solana Tracker responses still fall back to GMGN `tokenKline`.

`SOLANATRACKER_OHLC_RPS` (default `3`) is a process-wide queue for those Solana Tracker chart starts. Live `fetchTokenOhlc` and the mcap refill share it, so `MCAP_OHLC_CONCURRENCY` (default `3`) cannot burst past the rate. `bash scripts/mcap-ohlc-refill-daemon.sh` refills Sol mints active in the last 7 days (`--since-days=7`) with `--sol-only` and does not start an EVM phase.

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
| `CLIMATE_GATE` | off | `1` enables paper/dry-run climate sizing on DLMM opens ([docs/CLIMATE_GATE.md](docs/CLIMATE_GATE.md)) |
| `CLIMATE_GATE_LIVE` | off | `1` also gates live (`dry_run=false`) — **ask before enabling** |
| `DATA_PUBLIC_FEED_URL` | public feed | Optional override for the buy-bulk observe BFF ([docs/DATA_PUBLIC_SCOUT.md](docs/DATA_PUBLIC_SCOUT.md)); no secrets |
| `TRADING_KEYPAIR_JSON` | — | `[1,2,3,...]` array for live trading |

### Trending discovery (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `TRENDING_FEED` | `jupiter` (`gmgn` in prod) | Discovery source for the trending bot. `gmgn` reads the same cached GMGN market-rank snapshot the Trending Tokens list uses (one call / chain / `GMGN_TRENDING_TTL_SECONDS`). Discovery only — pricing and execution are unchanged. |
| `TRENDING_REENTRY_COOLDOWN_MIN` | `1440` | Minutes a `(strategy, mint)` is blocked after a close, keyed on `strategy_outcomes`. Stops the open → close → reopen churn. `0` disables it. |
| `TRENDING_MAX_PURCHASES_PER_TOKEN` | `2` | Opens per `(strategy, mint)`, counted over the loader window (not truly lifetime — see `loadClosedTrendingOutcomes`). `0` disables it. |
| `TRENDING_DROP_RUGGED` | on | `false` disables dropping `token_rug_list` mints from the trending feed (list + bot candidates). |
| `GMGN_TRENDING_LIMIT` | `100` | Volume-ranked rows requested per chain, before the local filters. The RH sim selects its candidates from this list. |

### Robinhood sim levers

The RH path picks candidates from the volume-ranked feed and filters them locally, so **this band decides
what `att_rh` can ever open** — and it is the gate that binds before the re-entry guard does.

| Variable | Default | Description |
|----------|---------|-------------|
| `RH_MCAP_MIN` | `300000` | Lower bound of the RH candidate band. Was chosen when most volume-ranked rows sat inside it; on 2026-10-02 the live feed was mostly **below** it (36k / 66k / 70k), so the floor rejects most of the book. |
| `RH_MCAP_MAX` | `2000000` | Upper bound of the same band. |
| `RH_MAX_OPEN_POSITIONS_DEFAULT` | `10` | Fallback concurrent-position cap when a strategy row sets no `max_open_positions`. |
| `RH_BUY_AMOUNT_ETH` | `0.0015` | RH sim entry size, ETH-denominated. |
| `RH_SIM_BUY_ETH` | `0.001` | RH paper size. |
| `RH_FILTER_*` | see `DEFAULT_FILTER_CONFIG` | `RH_FILTER_MCAP_MIN/MAX`, `RH_FILTER_PRICE_CHANGE_5M/1H/6H_MAX`, `RH_FILTER_ORGANIC_SCORE_MIN`, `RH_FILTER_TOP_HOLDERS_MAX`. **Currently inert** — nothing in the trending_bot chain reads `filtering`; `passesConditions` reads `strategy.conditions`, which is the `RH_MCAP_*` band above. |

Every one of these falls back to its code default when unset, blank or unparseable, and reads at module
load — so a change needs a container restart. `0` is a real value for the limiter-style knobs; deleting the
variable is how you return to the default.

### Shadow risk — dev reputation + RugCheck (display-only)

Both default **off**, and neither gates anything: they record + label only, suffixed `(shadow)`
([docs/specs/SPEC-dev-reputation-rugcheck-v1.md](docs/specs/SPEC-dev-reputation-rugcheck-v1.md)).

| Variable | Default | Description |
|----------|---------|-------------|
| `RUGCHECK_ENABLED` | `false` | Free keyless `GET /v1/tokens/{id}/report` → `token_risk_features` (`score_normalised`, named risks, insider graph, LP lock, creator balance) |
| `RUGCHECK_MAX_REQ_PER_SEC` | `3` | Serial gate (~30 % of the measured ~10 rps clean ceiling) |
| `RUGCHECK_TTL_S` | `900` | Per-mint cache |
| `DEV_REPUTATION_ENABLED` | `false` | Score each creator from GMGN `created_tokens` (graduation rate + per-coin ATH) → `dev_reputation` |
| `DEV_REPUTATION_MODE` | `shadow` | `enforce` only once the correlation is significant — it is **not** today |
| `DEV_REPUTATION_KILL_SWITCH` | `false` | `true` forces shadow |
| `DEV_REPUTATION_TTL_S` | `86400` | Per-creator cache |
| `DEV_MIN_SAMPLE` · `DEV_BAN_MAX_GRADUATION` · `DEV_GOOD_MIN_GRADUATION` · `DEV_GOOD_MIN_ATH_MC` | `5` · `0.05` · `0.25` · `1000000` | Verdict thresholds (in-code defaults, env-tunable) |

UI `/dev/dev-reputation` (profitable devs vs ban list, top-10 tokens each). Read APIs:
`GET /api/dev/reputation`, `GET /api/gmgn/risk-chips` (bulk chips for list surfaces).

### Metrics series — 1m volume + market-cap candles (`metrics_copier`)

The durable per-token series (`token_metrics_history`: one row per (token, UTC hour) carrying five 1m arrays —
`vol_min` (USD volume) plus `o_min`, `h_min`, `l_min`, `c_min`, which are **market-cap** candle values from
GMGN's `token_mcap_candles`). Filled by `POST /api/metrics/copy`, cheapest lane first: the 24h 1m candle cache
for free (volume only — its bars are *prices*, and the two differ by ~10⁹, so it must not write the mcap
columns), then one paced GMGN-web candle call per remaining watch mint. Each field is first-writer-wins
independently, and `NULL` means *not observed* — never 0. Its only hazard is a **cadence longer than the window
a single call covers** (501 × 1m ≈ 8.35 h): the minutes in the gap are never re-served, so a daily sweep would
silently hole the series. See [docs/GMGN_RATE_BUDGET.md](docs/GMGN_RATE_BUDGET.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `METRICS_COPY_INTERVAL` | `900` | Go cron cadence for `metrics_copier` (seconds; `0` disables). Must stay below the window one call covers. |
| `METRICS_COPY_RPS` | `2` | Copy-lane rate budget — **its own lane**, independent of `GMGN_WEB_MAX_POST_PER_SEC`. Measured on the **candle** endpoint (the one the sweep uses): 96 requests / 2.6 MB clean at ~1.1 rps sustained, while a 240-call burst at 8 rps tripped a 429 across the whole Worker path (shared with the live chart/risk lanes). Ramp only while watching for 403/429. |
| `METRICS_COPY_TIMEOUT_SEC` | `240` | Go cron's client timeout for one sweep. The default 30 s sits below a cold sweep and logged a successful one as a failure. |
| `METRICS_COPY_CONCURRENCY` | `8` | Max in-flight candle calls per sweep. |
| `METRICS_COPY_MAX_MINTS` | `300` | Watch-set cap for the sweep (shared with `ohlc_sampler`). |
| `METRICS_COPY_LOOKBACK_MIN` | `240` | How far back a cached series must reach to skip the vendor call entirely. |
| `METRICS_COPY_MAX_STALENESS_MIN` | `30` | A cache older than this counts as stale → fetch regardless (its recent minutes are missing). |
| `METRICS_COPY_KILL_SWITCH` | — | `1` makes every sweep a no-op. |
| `TOKEN_METRICS_RETENTION_DAYS` | `30` | Whole-hour retention prune. |

### Market-brain (optional)

Read-only client for [market-brain](https://market-brain.yonathanevanchristy.workers.dev) lists + recipes + `/regime/params` + `/ohlc` + `/risk/from-score`. Universe plugs default off. OHLC prefers brain when a read token is set (set `MARKET_BRAIN_OHLC=0` to keep SolanaTracker/GMGN). Principal sim-open **score risk** (`GET /risk/from-score`) defaults on when a read token is set — set `MARKET_BRAIN_SCORE_RISK=0` to keep today's recipe / `DEFAULT_MCAP_TRACKER_EXIT` knobs. Climate `sizeScale` still comes from `/regime/params`. Does not change live execute.

| Variable | Default | Description |
|----------|---------|-------------|
| `MARKET_BRAIN_URL` | `https://market-brain.yonathanevanchristy.workers.dev` | Optional base override |
| `MARKET_BRAIN_TOKEN` / `MARKET_BRAIN_READ_TOKEN` | — | Bearer read token (`BRAIN_READ_TOKEN`). Never logged. |
| `MARKET_BRAIN_ADMIN_TOKEN` | — | Bearer admin token (`BRAIN_ADMIN_TOKEN`) for recipe writes (promote / deactivate / dormant / seed). Missing token is fail-soft: log once, local promote continues. Never logged. |
| `MARKET_BRAIN_TRENDING` | off | `1` intersects the trending-assign discovery feed (GMGN rank when `TRENDING_FEED=gmgn`, else Jupiter `toptrending/1h`) with `GET /union` (membership). Skipped if the token is missing. |
| `MARKET_BRAIN_MCAP` | off | `1` intersects mcap sim-track opens with `GET /union` (membership) and default recipe gates (mcap≥50k, liq≥10k, climateSafe). Does not change live execute. Skipped if the token is missing. |
| `MARKET_BRAIN_SIGNALS` | off | `1` intersects signals sim-track enter candidates with `GET /union` (or the matching signals recipe universe) and default recipe gates. Skipped if the token is missing. |
| `MARKET_BRAIN_OHLC` | on when token set | Prefer `GET /ohlc` (Bearer) for Freeview / token-chart / rug-shadow 1m bars. Falls back to SolanaTracker/GMGN on 5xx/timeout. Set `0` to force the local path. |
| `MARKET_BRAIN_SCORE_RISK` | on when token set | Principal sim-open (`mcap_enter_first_seen`, `mcap_enter_at_80`) calls `GET /risk/from-score` after combined score and applies returned TP/SL/hold. Set `0` to disable. Brain miss → `riskSource=fallback_default`. |

**Sim-open risk order** (every sim domain, via `resolveSimOpenSize()` in `src/utils/brain-regime-risk.ts`):

1. Live `GET /regime/params?profile=<recipe.profileId|default>` wins for **sizeScale** (and first-cut TP/SL/hold)
2. Else embedded `recipe.riskGrid[climate state]`
3. Else keep local TP / SL / size (log once)
4. Principal sim-opens then overlay TP/SL/hold from `GET /risk/from-score?score=&rugTrip=` (does not replace climate size). Disable with `MARKET_BRAIN_SCORE_RISK=0`.

`sizeScale` multiplies size; `0` is stand-down (skip new sim opens). It is **tiered, not a curve**:
`climateGate.ts` assigns `scale = SIZE_SCALE[sizeKind]` over `stand-down 0 · trim 0.25 · reduced ·
neutral · full`, and a cascade/news veto caps the kind at `trim` — so a sustained de-risk regime holds a
constant 0.25 by design. (The type comment describes `scale` as a continuous `Cash=0 … Hype=1` hint; the
assignment is the lookup.)

**Reach.** Before 2026-10-01 the scalar resolved on mcap/search, signals and the Solana trending cycle only,
so gmgn, social and the Robinhood trending twin ran at full configured size with no stamp — staking ~9× the
per-trade SOL of the scaled family. All domains now go through one path, so cross-family PnL/ROI compares
strategies rather than wiring. Set `SIM_FOLDED_STRATEGIES` (comma-separated; default the four families the
proposal register measured as losing) to control which families the `/dev/paper-trade` fold toggle removes —
an explicit empty value folds nothing. See [docs/diagrams/12-proposal-register.html](docs/diagrams/12-proposal-register.html).

Smoke: `GET /health` is public. Authenticated `GET /union` / `/jupiter` / `/bubble` / `/recipes` / `/regime/params?profile=default` / `/ohlc` / `/ohlc/patterns` / `/risk/from-score` need `Authorization: Bearer $MARKET_BRAIN_TOKEN`. Recipe writes need `Authorization: Bearer $MARKET_BRAIN_ADMIN_TOKEN`.

Seed known-winner recipes (`mcap_enter_first_seen`, `mcap_enter_at_80`, `signals_sell_over_100`) as active fat payloads (union universe, default gates, `profileId: default`, embedded risk grid, **no bmScore**):

```bash
export MARKET_BRAIN_ADMIN_TOKEN=   # same value as brain BRAIN_ADMIN_TOKEN
npx tsx scripts/seed-brain-recipes.ts            # idempotent PUT
npx tsx scripts/seed-brain-recipes.ts --dry-run
# optional: --activate=ID --deactivate=ID --dormant=ID
npx tsx scripts/seed-brain-recipes.ts --tidy            # deactivate thin/losing; dormant n=0
npx tsx scripts/seed-brain-recipes.ts --tidy --dry-run  # plan only (needs local outcomes)
```

**Recipe tidy rules** (same ladder as `passesLegoPromoteGate` in `src/utils/brain-recipe-sync.ts`; never hard-delete):

| Condition | Action |
|-----------|--------|
| n ≥ 10 and avg PnL > 0 | keep active (promote path activates) |
| active and (n < 10 or avg PnL ≤ 0) | deactivate (remove from active assign; params stay) |
| n = 0 (zero-trade) | dormant (params kept) |
| already dormant | leave dormant (do not drop from store) |

`strategy_search` runs this tidy each cycle (skips a canonical id just promoted). Stats `n` / avg PnL are the same 28-day fitness window the search cycle already uses (`closes` / `expectancyPct`).

Unit tests: `npx vitest run src/utils/brain-gates.test.ts src/utils/market-brain.test.ts src/utils/brain-recipe-sync.test.ts src/utils/brain-union-universe.test.ts src/utils/brain-regime-risk.test.ts src/strategies/token-map-chart.test.ts src/strategies/trending-track/brain-universe.test.ts src/strategies/mcap-track/brain-universe.test.ts src/strategies/signals/brain-universe.test.ts`.

Smoke (opt-in, fail-soft without a token):

```bash
export MARKET_BRAIN_TOKEN=          # same value as brain BRAIN_READ_TOKEN
export MARKET_BRAIN_MCAP=1
export MARKET_BRAIN_SIGNALS=1
# sim-track logs: "market-brain /union membership: kept N/M … candidates"
# missing token keeps the existing tracker path
```

### ML closed loop + eval engine (optional)

Closed-loop `mlScore` is an adjuster on combined score (so phase-3 TP/SL can see it). The eval engine is **shadow-by-default**: it scores + logs predictions and measures per-run accuracy. It does not auto-open. **Live trade is stubbed.** Full how-to: [ml/README.md](ml/README.md#closed-loop--eval-engine-phase-4).

| Variable | Default | Description |
|----------|---------|-------------|
| `ML_CLOSED_LOOP` | off | Enable `mlScore` infer + combined-score `ml` weight |
| `ML_CLOSED_LOOP_ARTIFACT` | `data/ml-closed-loop/model.json` | Persisted model version |
| `EVAL_ENGINE` | off | Candidate scan / decision + prediction logging |
| `EVAL_SHADOW` | **on** | `shadow_predict` only; set `0` with `EVAL_ENGINE=1` to allow opens (discouraged) |
| `EVAL_EXEC_MODE` | `paper` | `paper` or `live` adapter (opens only if shadow is off) |
| `LIVE_TRADE_ENABLED` | `0` | Hard gate; live adapter refuses without it |
| `ML_PAPER_MIN_COMBINED` | `0.35` | Skip predict/open below this combined |
| `ML_PAPER_MIN_ML` | `0.5` | Skip when ML is on and `mlScore` is below this |
| `EARLY_ENTER_ML_SOFT_GATE` | **on** | Toast+Telegram emit only when closed-loop `mlScore` (`cl-*`) is finite and ≥ `EARLY_ENTER_ML_MIN`. `0`/`false` restores pre-SPEC emit. Does **not** change paper / sim-open. |
| `EARLY_ENTER_ML_MIN` | `0.55` | Closed-loop cut for the Early Enter soft gate |
| `EARLY_ENTER_NOUL_SHADOW` | **on** | Write `early_enter_noul_shadow` rows + call TypeSafe Noul on locked mcap arms. Soft-fail → SPEC. |
| `EARLY_ENTER_NOUL_SOFT_ACTIVE` | **off** | When on (ops after §7 bar), Noul keep/suppress may drive toast; mid/api_miss still → SPEC. Kill switch forces off. Never auto-flips from N/agreement in v1. |
| `EARLY_ENTER_NOUL_API_MISS_KILL_RATE` | `0.10` | #54 miss% kill: api_miss / all rows above this blocks flip (all-time, or 24h when that window N≥20) and holds soft-active off. Does not enable it. api_miss is excluded from A and M. |
| `EARLY_ENTER_NOUL_DISAGREEMENT_KILL_RATE` | `0.15` | Not the miss kill. Keep/suppress disagreement is the agreement bar (A≥85%). api_miss rows are excluded from A and M. |
| `EARLY_ENTER_NOUL_NO` / `YES` | `0.2` / `0.8` | Mid-band edges for Noul soft-fail. |
| `TYPESAFE_API_KEY` | (ops) | TypeSafe/Jev creds (#56). Missing → `api_miss`. Do not commit secrets. |

```bash
npm run ml:backfill-labels -- --principals
npm run ml:train-closed-loop
export ML_CLOSED_LOOP=1 EVAL_ENGINE=1 EVAL_SHADOW=1 EVAL_EXEC_MODE=paper LIVE_TRADE_ENABLED=0
```

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
| `/dev/search-token` | Token search (name/symbol/CA); chain pages `/solana`, `/robinhood` |
| `/dev/search-token/detail` | Token map — Freeview (lanes + chart) or List (`?address=&view=`) |
| `/dev/algo-tester` | Algo tester — config, open positions, closed reports (all domains) |
| `/dev/dlmm` | Meteora DLMM agent — pools, positions, deploy/edit/close |

Legacy routes redirect via `proxy.ts` (e.g. `/charts` → `/dev/signals?tab=board`, `/dev/trending-tracker` → `/dev/algo-tester`, `/dev/strategies` → `/dev/algo-tester?tab=config`). `/search-token*` → `/dev/search-token*`; `/dev/token-search` → `/dev/search-token/detail`.

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
# Optional paper climate gate (default off). Live force needs CLIMATE_GATE_LIVE=1 after an ask.
# CLIMATE_GATE=1
```

Regime climate (`GET https://terminal.reloadsol.app/api/regime/climate`) can scale or block **new** DLMM risk when `CLIMATE_GATE=1`. Kill switch / capital caps still win. Details: [docs/CLIMATE_GATE.md](docs/CLIMATE_GATE.md). Buy-bulk observe (`GET /api/scout/data-public`) uses the Header climate **display** label only to allow paper notes when Safe — it does not enable live climate force.

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
