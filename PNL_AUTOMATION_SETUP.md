# Automated PnL Updates - Simple Setup

> **Note (Jul 2026):** Production DB is Docker Postgres **`reloadsol_db`**. Supabase is no longer used. PnL cron runs via Go worker on VPS, not Vercel.

## What This Does

Automatically calculates and updates each user's total trading PnL in the `token_operations` table daily (02:00 UTC via `pnl_update` cron worker).

## Setup (3 Steps)

### 1. Database schema

Schema is in [`db/init/02-schema.sql`](../db/init/02-schema.sql) (`trade_pnl`, `last_pnl_update` on `token_operations`). Apply on fresh Docker deploy automatically, or:

```bash
bash scripts/deploy-tencent.sh schema
# or
docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < db/init/02-schema.sql
```

### 2. Environment variable

Add to `.env`:

```bash
PNL_UPDATE_SECRET=your-secret-token-here
```

Auth: query `?key=`, Bearer header, or legacy `PNL_UPDATE_TOKEN`.

### 3. Cron worker

The Go cron container calls `POST /api/pnl/update` at **02:00 UTC** daily. Ensure `reloadsol-cron` is running:

```bash
curl -fsS http://127.0.0.1:8080/health
docker compose logs -f cron
```

## Manual testing

```bash
curl -X POST "http://127.0.0.1/api/pnl/update?key=${PNL_UPDATE_SECRET}" \
  -H "Content-Type: application/json"
```

Or from inside Docker network:

```bash
docker exec reloadsol-cron wget -qO- --post-data='' \
  "http://web:3000/api/pnl/update?key=${PNL_UPDATE_SECRET}"
```

## How it works

1. Fetches trading records (last 30 days for performance)
2. Groups by wallet address
3. Calculates PnL per user (buy/sell matching)
4. Updates `token_operations.trade_pnl`

Scheduling: Go cron `pnl_update` worker (not Vercel).
