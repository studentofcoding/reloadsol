# social-ingest

Telethon sidecar that listens to configured Telegram alpha channels and POSTs parsed token events to buy_bulk `POST /api/social/ingest`.

**Production server setup:** see [PRODUCTION_DEPLOYMENT.md](../PRODUCTION_DEPLOYMENT.md) (bootstrap script, session copy, deploy).

## Prerequisites

- Root `.env` with Telegram credentials (see `.env.docker.example` **Social ingest** section)
- buy_bulk web + cron running (rollup every 120s, wallet poll every 300s)
- Telethon session file in `social-ingest/sessions/session_search.session` (copied from dev or created on first login)

## First-time server bootstrap

```bash
bash scripts/bootstrap-social-server.sh --check   # env + session only
bash scripts/bootstrap-social-server.sh           # + seed tracked_wallets
npm run docker:deploy                             # web + cron + social-ingest
```

## First-time Telethon login (local)

```bash
cd social-ingest
pip install -r requirements.txt
export $(grep -E '^(API_ID|API_HASH|PHONE_NUMBER)=' ../.env | xargs)
export SESSION_DIR=sessions
python main.py
# Enter Telegram code when prompted — session saved under sessions/
```

## Run with Docker

Full stack (web + cron + social-ingest):

```bash
npm run docker:up              # foreground
npm run docker:prod              # detached (prod-daemon)
```

Social-ingest only (web must already be healthy):

```bash
npm run docker:social
```

Session files persist via volume `./social-ingest/sessions:/app/sessions`.

### Production session permissions

On the server, Telethon session files must be readable by the Docker container (runs as root):

```bash
chmod 755 social-ingest/sessions
chmod 644 social-ingest/sessions/session_search.session*
```

Do **not** use `chmod 700` on the directory or `chmod 600` on the session file in production — the container may fail auth and crash-loop with `SendCodeRequest` / `FloodWaitError`. Host-only interactive login can use tighter perms temporarily, then relax before `docker compose up social-ingest`.

## Run locally against dev server

```bash
SOCIAL_INGEST_URL=http://127.0.0.1:3000/api/social/ingest \
SOCIAL_INGEST_SECRET=r3l0ads0l-trending \
SESSION_DIR=social-ingest/sessions \
python social-ingest/main.py
```

## Channel env vars

| Env | Source label |
|-----|----------------|
| `GMGN_ID` | GMGN |
| `GMGN_SOLANA_FDV_AND_SMART_MONEY_ID` | GMGN_Smart_Money_FOMO |
| `FINDER_TRENDING_ID` | FINDER_Trending |
| `GMGN_TRACKER_ID` | GMGN_copy_trade |
| `JUNGOOL_ID` | JUNGOOL |
| `GAMBLES_ID` | GAMBLES |
| `JOJI_INNER_ID` | JOJI |
| `STONK_CALLS_ID` | STONK_CALLS |

Startup logs print resolved Telethon peer IDs (`env=… raw=… → peer_id=…`).

## Wallet seed

```bash
npm run social:seed-wallets              # reads data/tracked-wallets.txt
npm run social:seed-wallets -- --dry-run
npm run social:seed-wallets -- --file path/to/wallets.txt
```

## Verify

- Logs: `Listening on N channels` and `Ingest OK (200)`
- Admin UI: `/dev/social`
- Supabase: `social_token_events` → cron refreshes `social_token_rollups`

Optional GMGN enrichment (`mcp`, `net_in_volume_1m`, `symbol` in `raw_metadata`): set `SOCIAL_ENRICH_GMGN=false` to disable.

## Deploy scope

Changes under `social-ingest/**` trigger `npm run docker:deploy:social`. Web deploys also restart social-ingest (always-on). See `scripts/docker-scope.sh`.
