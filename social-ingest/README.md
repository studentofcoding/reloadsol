# social-ingest

Telethon sidecar that listens to configured Telegram alpha channels and POSTs parsed token events to buy_bulk `POST /api/social/ingest`.

**Production server setup:** see [PRODUCTION_DEPLOYMENT.md](../PRODUCTION_DEPLOYMENT.md) (bootstrap script, session copy, deploy).

## Prerequisites

- Root `.env` with Telegram credentials (see `.env.docker.example` **Social ingest** section)
- buy_bulk web + cron running (rollup every ~5m, wallet poll every 300s)
- Postgres `reloadsol_db` via web API (no Supabase)
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

Startup logs print resolved channel ids (`bare=` internal id, `marked=` Telethon `event.chat_id`). Set `SOCIAL_INGEST_LOG_SKIPS=false` to hide per-message skip lines.

## Wallet seed

```bash
npm run social:seed-wallets              # reads data/tracked-wallets.txt
npm run social:seed-wallets -- --dry-run
npm run social:seed-wallets -- --file path/to/wallets.txt
```

## Egress / efficiency (defaults)

| Env | Default | Purpose |
|-----|---------|---------|
| `SOCIAL_ENRICH_GMGN` | `false` | GMGN HTTP per message (off saves latency + metadata size) |
| `SOCIAL_MAX_CAS_PER_MESSAGE` | `3` | Cap token addresses extracted from one Telegram message |
| `SOCIAL_STORE_EXCERPT` | `false` | Omit message excerpt from `raw_metadata` (biggest JSON saver) |
| `SOCIAL_EXCERPT_MAX` | `120` | Max excerpt length when `SOCIAL_STORE_EXCERPT=true` |

Mentions store `{}` or minimal metadata; `wallet_buy` keeps `sol_amount` when parsed. The ingest API trims any oversized `raw_metadata` before Postgres insert.

Set `SOCIAL_ENRICH_GMGN=true` only if you need `symbol` / `mcp` on first CA per message (one GMGN call).

## Verify

- Logs: `Listening on N channels`, `Channel … bare=… marked=…`, and `Ingest OK (200)`
- `Skip message (no token CA)` = channel message received but no parseable Solana address in text
- Admin UI: `/dev/social` → **24h Patterns**
- Postgres: `social_token_events` → cron refreshes `social_token_rollups` + `mcap_social_pattern_24h`

## GMGN hot tokens (web cron, not Telethon)

High-score GMGN SM+KOL activity is ingested by the **Node** cron worker `gmgn_activity_poll` (~180s), not this Telethon sidecar:

- `POST /api/gmgn/activity-poll` → `social_token_events` with `source = gmgn_hot` / `gmgn_smartmoney` / `gmgn_kol` (wallet_buy)
- `raw_metadata` includes `gmgn_activity_score`, wallet counts, USD sums, plus **Radar** fields (`radar_score`, `radar_action`, `radar_sm_peak`, …)
- Rollup cron picks up `gmgn_*` sources for `smart_wallet_buy_count_1h`

### Early Signals → Radar bridge

Stage-1 Early Enter (from `GET /api/trading/signals`) also writes:

- `source = signals_early`, `event_type = mention`
- `raw_metadata.early_signals_score`, `early_growth_pct`

Activity-poll Radar merges those stamps over a **2h** window so Early momentum and GMGN SM/KOL are one accumulative score (not two disconnected Telegram products).

See [docs/GMGN_STRATEGY.md](../docs/GMGN_STRATEGY.md) for Radar calibration and smoke commands.

## Deploy scope

Changes under `social-ingest/**` trigger `npm run docker:deploy:social`. Web deploys also restart social-ingest (always-on). See `scripts/docker-scope.sh`.
