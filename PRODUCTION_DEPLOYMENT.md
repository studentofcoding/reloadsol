# reloadSOL Production Deployment Guide

Production deployment uses **Docker Compose** (Next.js web + Go cron). PM2 scripts have been removed.

## Stack

| Service | Container | Default port | Role |
|---------|-----------|--------------|------|
| **reloadsol-db** | `reloadsol-db` | 5432 (internal) | Postgres 16 (1GB cap) |
| **reloadsol-bouncer** | `reloadsol-bouncer` | 5432 (internal) | PgBouncer transaction pool |
| **web** | `reloadsol-web` | `WEB_PORT` (3000 or 80) | Next.js app + API routes |
| **cron** | `reloadsol-cron` | `CRON_PORT` (8080) | Trending track, SL/TP, DLMM, signals, social rollup/wallet-poll |
| **social-ingest** | `reloadsol-social-ingest` | (none) | Telethon → `POST /api/social/ingest` |

Host build produces `.next/standalone` (avoids OOM in-container); [`Dockerfile.web`](Dockerfile.web) packages the pre-built bundle.

## Quick deploy

```bash
git clone https://github.com/your-org/reloadsol.git
cd reloadsol

cp .env.docker.example .env
# Edit .env — POSTGRES_PASSWORD, DATABASE_URL, SHYFT_API_KEY, WALLET_SESSION_SECRET, cron secrets, Telegram

# Fresh deploy: docker compose applies db/init/*.sql on first start
# Historical: one-time Supabase migration via scripts/migrate-from-supabase.sh (see README)
bash scripts/bootstrap-social-server.sh

npm run docker:deploy
# Auto-detects web / cron / social from git diff (scripts/docker-scope.sh)
# Manual: --web-only | --cron-only | --social-only | --all
```

Production with host port 80:

```bash
WEB_PORT=80 npm run docker:deploy
```

## Selective deploy

Deploy only what changed (default `--auto`):

| Change | Typical scope | Command |
|--------|---------------|---------|
| `src/**`, frontend config | web (+ social-ingest up) | `npm run docker:deploy:web` |
| `main.go`, `worker_tracker.go` | cron | `npm run docker:deploy:cron` |
| `social-ingest/**` | social | `npm run docker:deploy:social` |
| `docker-compose*.yml`, docker scripts | all three | `npm run docker:deploy:all` |

Inspect scope without deploying:

```bash
bash scripts/docker-scope.sh detect
bash scripts/docker-scope.sh detect-working
```

Frontend-only deploys use `docker compose up -d --no-deps web` so **reloadsol-cron keeps running** without rebuild; **social-ingest** is restarted after web is healthy (always-on).

## CI / GitHub Actions

Push to `main` triggers [`.github/workflows/deploy_docker.yml`](.github/workflows/deploy_docker.yml) on a self-hosted runner:

```bash
bash scripts/docker-deploy.sh --skip-pull
```

Optional post-pull hook:

```bash
npm run docker:deploy:hook
```

## Tencent Linux quick deploy

```bash
cp .env.docker.example .env          # edit POSTGRES_PASSWORD + secrets
bash scripts/deploy-tencent.sh setup # docker, npm (registry fix), deps
bash scripts/deploy-tencent.sh db    # postgres + pgbouncer on 127.0.0.1:5432

# Historical one-time migration from hosted Supabase (already done on prod):
# export SOURCE_DATABASE_URL='...' && bash scripts/deploy-tencent.sh migrate

bash scripts/deploy-tencent.sh deploy  # or: bash scripts/deploy-tencent.sh all
bash scripts/deploy-tencent.sh smoke
bash scripts/deploy-tencent.sh backup
```

See also [README.md](../README.md#npm-install-fails-on-tencent-cloud-http-451--xrpl).

## Memory limits

[`docker-compose.yml`](docker-compose.yml) caps each container so one service cannot OOM the whole host (~3.6 GB Tencent VPS):

| Container | Limit |
|-----------|-------|
| reloadsol-db | 768M |
| reloadsol-web | 768M |
| reloadsol-social-ingest | 256M |
| reloadsol-cron | 128M |
| reloadsol-bouncer | 64M |

Limits apply after **recreate** (not `docker restart`):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate
docker stats --no-stream
```

Each row should show `MEM USAGE / LIMIT` with its cap (e.g. `91MiB / 768MiB`), not the full host size.

If **reloadsol-web** restarts with OOM in `docker logs reloadsol-web` or `dmesg`, raise web to `896M` or `1G` and optionally lower db to `512M` in compose.

**Deploy/build on &lt;4 GB RAM** still needs swap — run `sudo bash scripts/ensure-swap.sh` before first deploy. Container limits do not cover host-side `npm ci` / `next build`.

## Environment variables

Copy from [`.env.docker.example`](.env.docker.example). Minimum for production:

```bash
POSTGRES_PASSWORD=...
DATABASE_URL=postgresql://postgres:...@reloadsol-bouncer:5432/reloadsol_db
DATABASE_URL_DIRECT=postgresql://postgres:...@reloadsol-db:5432/reloadsol_db

SHYFT_API_KEY=...
RPC_URL=https://rpc.shyft.to?api_key=...
NEXT_PUBLIC_RPC_URL=https://rpc.shyft.to?api_key=...

WALLET_SESSION_SECRET=...   # openssl rand -hex 32
TRENDING_TRACKER_SECRET=...
PNL_UPDATE_SECRET=...
DLMM_SCREEN_SECRET=...
DLMM_MANAGE_SECRET=...

WEB_PORT=80                 # host → container :3000
API_HOST=http://web:3000    # cron → web (inside compose network)

# Social ingest (Telethon — see social-ingest/README.md)
API_ID=
API_HASH=
PHONE_NUMBER=
GMGN_ID=
GMGN_TRACKER_ID=
GMGN_SOLANA_FDV_AND_SMART_MONEY_ID=
FINDER_TRENDING_ID=
JUNGOOL_ID=
GAMBLES_ID=
JOJI_INNER_ID=
STONK_CALLS_ID=
```

Telethon session (not in `.env`): copy `social-ingest/sessions/session_search.session` to the server before first deploy (gitignored).

### Bot automation (real trading)

```bash
BOT_TRADING_FAILURE_THRESHOLD=3   # halt after N consecutive real buy failures
BOT_TRADING_HALT_MINUTES=20       # auto-resume after halt
BOT_TRADE_LOCK_TTL_SEC=120        # duplicate-buy lock TTL
```

Sim-only deployments can omit these (defaults apply; circuit breaker affects real buys only).

### Live trading

```bash
TRADING_KEYPAIR_JSON=[1,2,3,...]
MAX_SOL_AT_RISK=1.0
MIN_SOL_BALANCE=0.1
```

## SSL / HTTPS

Solana wallets require HTTPS in production. Terminate TLS at nginx (or your load balancer) and proxy to `WEB_PORT`:

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo certbot --nginx -d yourdomain.com
```

## Monitoring

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose logs -f web
docker compose logs -f cron
docker compose logs -f social-ingest

curl -fsS "http://127.0.0.1:${WEB_PORT:-3000}/api/health"
curl -fsS "http://127.0.0.1:${CRON_PORT:-8080}/health"
curl -X POST "http://127.0.0.1:${WEB_PORT:-3000}/api/social/rollup?key=${TRENDING_TRACKER_SECRET}"
```

Manual cron triggers (cron container port 8080):

```bash
curl -X POST http://127.0.0.1:8080/trigger/trending
curl -X POST http://127.0.0.1:8080/trigger/sltp
```

## Security checklist

- [ ] HTTPS in front of web
- [ ] Strong `WALLET_SESSION_SECRET` and cron secrets (not defaults)
- [ ] `DATABASE_URL` points at PgBouncer (`reloadsol-bouncer`) in Docker
- [ ] `POSTGRES_PASSWORD` set (not placeholder)
- [ ] Trading keypair only in `.env` (not committed)
- [ ] Firewall: 22, 80, 443 only
- [ ] RLS enabled on app tables (`db/init/02-schema.sql`)
- [ ] Telethon session on server at `social-ingest/sessions/session_search.session`
- [ ] `bash scripts/bootstrap-social-server.sh` run once (migration + wallet seed)

## Troubleshooting

**Deploy hangs on health check:** ensure `WEB_PORT` in `.env` matches the host port Docker publishes (e.g. `80:3000` → curl `:80`, not `:3000`).

**Cloudflare 521 (web server is down):** Next.js may be healthy inside Docker while Cloudflare cannot reach the origin. Check:

- Exactly **one** `WEB_PORT=` line in `.env` (duplicate keys make Compose use the last value — e.g. `WEB_PORT=3000` while Cloudflare hits `:80`).
- `docker port reloadsol-web 3000/tcp` shows `0.0.0.0:80` when using `WEB_PORT=80`.
- Cloudflare SSL **Flexible** when Docker publishes HTTP on `:80` with no nginx on `:443`.

**Cron: `address already in use` / container stuck `Created`:** merged compose used to bind the same host port twice (`docker-compose.yml` + `docker-compose.prod.yml` both define cron `ports`). Fixed with `ports: !override` on the key in `docker-compose.prod.yml`. Verify:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep -A8 '^  cron:'
# expect ONE published port (e.g. 127.0.0.1:8082 -> 8080)
docker rm -f reloadsol-cron 2>/dev/null
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate cron
curl -fsS "http://127.0.0.1:${CRON_PORT:-8080}/health"
docker exec reloadsol-web wget -qO- http://cron:8080/health
```

Keep exactly **one** `CRON_PORT=` line in `.env`. `CRON_SERVICE_URL` must stay `http://cron:8080` (container port, not host port).

**Cron 401 on SL/TP:** pass `TRENDING_TRACKER_SECRET` as `?key=` (configured in `main.go`).

**Social wallet poll: Shyft API failed (401):** `/dev/social` shows `Unauthorized` on every wallet `Last poll`. The web container sends `SHYFT_API_KEY` to `api.shyft.to/sol/v1/wallet/all_tokens`.

- Set a real key from [shyft.to](https://shyft.to) dashboard (not `your-shyft-api-key`).
- Keep exactly **one** `SHYFT_API_KEY=` line; align `RPC_URL=https://rpc.shyft.to?api_key=...`.
- Recreate web: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate web`
- Verify: `bash scripts/verify-shyft-env.sh` then `curl -X POST "http://127.0.0.1:${WEB_PORT:-80}/api/social/wallet-poll?key=${TRENDING_TRACKER_SECRET}"`

**Social wallet poll: Shyft 429 (rate limit):** wallet poll bursts Shyft REST calls. Set `SHYFT_MAX_REQ_PER_SEC=5` in `.env` (default). Recreate web after change. On 429 the client retries with backoff automatically.

**Social wallet poll: Shyft 400 (validation):** truncated wallet addresses in `tracked_wallets` — re-parse seed file and upsert:

```bash
npx tsx scripts/seed-tracked-wallets.ts
# Remove stale truncated rows in Postgres if duplicates remain (addresses missing suffix)
docker exec reloadsol-db psql -U reloadsol -d reloadsol_db -c "DELETE FROM tracked_wallets WHERE length(address) < 32;"
```

**Social wallet poll: stale / Client.Timeout exceeded:** cron default HTTP timeout is 30s but wallet poll can run up to 300s (Shyft rate limit + many wallets). `main.go` uses a 300s client timeout for `/api/social/wallet-poll` — redeploy **cron** after updating: `npm run docker:deploy:cron`.

**Telegram channel activity:** UI at `/dev/social` → **Recent channel activity** (from `social_token_events`, Telegram sources only). Live sidecar logs:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f social-ingest
```

Look for `Ingest OK (200): N events`. After events exist, refresh rollups: `curl -X POST "http://127.0.0.1:${WEB_PORT:-80}/api/social/rollup?key=${TRENDING_TRACKER_SECRET}"`.

**Real trading halted:** check `bot_trading_state` in Postgres (`docker exec reloadsol-db psql -U reloadsol -d reloadsol_db -c 'SELECT * FROM bot_trading_state;'`); circuit breaker opens after `BOT_TRADING_FAILURE_THRESHOLD` failures.

**Build OOM / deploy stops during `npm ci`:** on a **4 GB** VPS, `npm ci` + Puppeteer + `next build` can exceed RAM while the old web container is still running. Deploy mitigations in [`scripts/docker-deploy.sh`](scripts/docker-deploy.sh):

- `PUPPETEER_SKIP_DOWNLOAD=true` (env in deploy/docker scripts, not `.npmrc`) — skips Chromium download on the server
- `npm ci --omit=dev` via [`scripts/npm-ci-sync.sh`](scripts/npm-ci-sync.sh) — smaller install footprint
- `NODE_OPTIONS=--max-old-space-size=2048` — leaves headroom for OS + Docker
- Live-streamed npm output + `free -h` on failure (check `dmesg | tail` for OOM killer)

If the new web container fails health after swap, deploy **rolls back** to the previous image automatically (CI still exits non-zero).

Override heap for larger hosts: `NODE_OPTIONS=--max-old-space-size=4096 npm run docker:deploy`.

**Puppeteer capture locally:** deploy sets `PUPPETEER_SKIP_DOWNLOAD=true` by default; run `PUPPETEER_SKIP_DOWNLOAD=false npm install` when you need `/api/capture`.

**Postgres connection errors / circuit breaker:** web logs may show DB timeouts when `reloadsol-db` or PgBouncer is down. Mitigations: social rollup every 5m, rollup query without `raw_metadata`, 60s DB circuit breaker, job locks fail closed when DB is down. **Fix:** verify `DATABASE_URL` points at `reloadsol-bouncer`; run `bash scripts/deploy-tencent.sh schema`; `docker restart reloadsol-web`.

See also [`README.md`](README.md) and [`CHANGELOG.md`](CHANGELOG.md).
