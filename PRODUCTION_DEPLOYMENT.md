# reloadSOL Production Deployment Guide

Production deployment uses **Docker Compose** (Next.js web + Go cron). PM2 scripts have been removed.

## Stack

| Service | Container | Default port | Role |
|---------|-----------|--------------|------|
| **web** | `reloadsol-web` | `WEB_PORT` (3000 or 80) | Next.js app + API routes |
| **cron** | `reloadsol-cron` | `CRON_PORT` (8080) | Trending track, SL/TP, DLMM, signals |

Host build produces `.next/standalone` (avoids OOM in-container); [`Dockerfile.web`](Dockerfile.web) packages the pre-built bundle.

## Quick deploy

```bash
git clone https://github.com/your-org/reloadsol.git
cd reloadsol

cp .env.docker.example .env
# Edit .env — SUPABASE_SECRET_KEY, SHYFT_API_KEY, WALLET_SESSION_SECRET, cron secrets

# Run supabase/schema.sql in Supabase SQL Editor (includes bot_* lock tables)

npm run docker:deploy
# Auto-detects web vs cron from git diff (scripts/docker-scope.sh)
# Manual: --web-only | --cron-only | --all
```

Production with host port 80:

```bash
WEB_PORT=80 npm run docker:deploy
```

## Selective deploy

Deploy only what changed (default `--auto`):

| Change | Typical scope | Command |
|--------|---------------|---------|
| `src/**`, frontend config | web | `npm run docker:deploy:web` |
| `main.go`, `worker_tracker.go` | cron | `npm run docker:deploy:cron` |
| `docker-compose*.yml`, docker scripts | both | `npm run docker:deploy:all` |

Inspect scope without deploying:

```bash
bash scripts/docker-scope.sh detect
bash scripts/docker-scope.sh detect-working
```

Frontend-only deploys use `docker compose up -d --no-deps web` so **reloadsol-cron keeps running** without rebuild.

## CI / GitHub Actions

Push to `main` triggers [`.github/workflows/deploy_docker.yml`](.github/workflows/deploy_docker.yml) on a self-hosted runner:

```bash
bash scripts/docker-deploy.sh --skip-pull
```

Optional post-pull hook:

```bash
npm run docker:deploy:hook
```

## Environment variables

Copy from [`.env.docker.example`](.env.docker.example). Minimum for production:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...

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
```

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

curl -fsS "http://127.0.0.1:${WEB_PORT:-3000}/api/health"
curl -fsS "http://127.0.0.1:${CRON_PORT:-8080}/health"
```

Manual cron triggers (cron container port 8080):

```bash
curl -X POST http://127.0.0.1:8080/trigger/trending
curl -X POST http://127.0.0.1:8080/trigger/sltp
```

## Security checklist

- [ ] HTTPS in front of web
- [ ] Strong `WALLET_SESSION_SECRET` and cron secrets (not defaults)
- [ ] `SUPABASE_SECRET_KEY` server-only (never `NEXT_PUBLIC_*`)
- [ ] Trading keypair only in `.env` (not committed)
- [ ] Firewall: 22, 80, 443 only
- [ ] Supabase RLS enabled (`supabase/schema.sql`)

## Troubleshooting

**Deploy hangs on health check:** ensure `WEB_PORT` in `.env` matches the host port Docker publishes (e.g. `80:3000` → curl `:80`, not `:3000`).

**Cron 401 on SL/TP:** pass `TRENDING_TRACKER_SECRET` as `?key=` (configured in `main.go`).

**Real trading halted:** check `bot_trading_state` in Supabase; circuit breaker opens after `BOT_TRADING_FAILURE_THRESHOLD` failures.

**Build OOM:** host build uses `NODE_OPTIONS=--max-old-space-size=4096` in `docker-deploy.sh`.

See also [`README.md`](README.md) and [`CHANGELOG.md`](CHANGELOG.md).
