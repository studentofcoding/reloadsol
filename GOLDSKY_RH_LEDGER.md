# Goldsky RH Wallet Ledger — Holdings, History & PnL

Chain-truth data path for Robinhood-wallet token holdings, transfer history and
PnL, replacing the flaky indexer ladder (GMGN → Blockscout → raw RPC candidate
probing) that surfaced stale/partial tokens in the RH buy/sell/swap token lists
(`HoldingsTokenList`).

## Architecture

```
Goldsky Turbo pipeline (robinhood_mainnet.erc20_transfers)
   │  filter: sender/recipient ∈ {tracked RH wallets}
   ▼
webhook sink ──POST batches──▶ /api/rh/ledger/ingest   (Bearer RH_LEDGER_WEBHOOK_SECRET)
                                      │ upsert ON CONFLICT DO NOTHING
                                      ▼
                     Postgres reloadsol_db (docker-internal)
                     rh_ledger_transfers   ← every ERC-20 transfer per wallet side
                     rh_token_meta         ← lazy decimals/symbol/name cache
                     tracked_rh_wallets    ← env-seeded wallet roster
                                      │
   GET /api/rh/wallet-tokens ────────┘ (tier 0 = ledger; GMGN/Blockscout/RPC
   GET /api/rh/ledger/history             remain as fallback when ledger empty)
```

- **Holdings** = SQL net of the ledger per wallet+token (`in - out`, exact
  NUMERIC math), decimals applied at read from `rh_token_meta` (Blockscout →
  GMGN), USD via the shared cached GMGN price path (`rh:token-usd:` 60 s).
- **History** = `GET /api/rh/ledger/history?wallet=0x…&token=…&limit=` — newest
  transfer events, per wallet side, with UI amounts.
- **PnL** = unchanged average-cost engine (`calculateWalletPnL`) over the app's
  own price-marked fills in `trading_records`. RH quote-mode fills already carry
  per-token `priceUsd`/`tokenAmount` (`src/utils/rh-trade-record.ts`); the daily
  cron (`POST /api/pnl/update`, 02:00 UTC) scans all chains, so RH is included.

## Key files

| File | Role |
|---|---|
| `db/init/30-rh-ledger.sql` | ledger + token meta + tracked wallets schema |
| `goldsky/pipelines/rh-wallet-ledger.yaml` | live tail pipeline (config) |
| `goldsky/jobs/rh-wallet-ledger-backfill.yaml` | genesis→tip backfill job (config) |
| `src/app/api/rh/ledger/ingest/route.ts` | Goldsky webhook target (idempotent upsert) |
| `src/app/api/rh/ledger/history/route.ts` | ledger history API |
| `src/utils/rh-ledger.ts` | ledger helpers (expand/insert/holdings/meta/history) |
| `src/app/api/rh/wallet-tokens/route.ts` | holdings endpoint — ledger is now tier 0 |
| `src/utils/rh-wallet-holdings.ts` | shared USD price fill + token meta fetch |

## Deploy runbook

1. Apply the migration to the live DB (fresh Docker deploys apply `db/init/*`
   automatically):
   ```bash
   docker exec -i reloadsol-db psql -U reloadsol -d reloadsol_db < db/init/30-rh-ledger.sql
   ```
2. Add env to the VPS `.env` (the web container reads it via `env_file`):
   `RH_LEDGER_WEBHOOK_SECRET` (+ optional `RH_TRACKED_PARENT_ADDRESS`), then
   deploy the app (git pull + docker rebuild on flowey-vps).
3. Follow `goldsky/README.md`: pin dataset version, fill placeholders, create
   the `httpauth` Goldsky secret, validate, apply the **backfill job**, then the
   **tail pipeline**.
4. Sanity: `curl -s "https://<host>/api/rh/wallet-tokens?wallet=<bound>&fresh=1"`
   should report `"source":"ledger"` and match on-chain holdings; see
   `goldsky/README.md` for adding wallets and cost notes.

## Failure semantics

- Ledger tier throws/empty → the route falls through to the old
  GMGN/Blockscout/RPC ladder unchanged, so nothing regresses while the ledger
  backfills or if Postgres is down.
- Webhook deliveries are at-least-once with retries on 5xx/429/timeouts;
  duplicate rows are no-ops. Reorg convergence relies on chain-absolute primary
  keys — a reorged-away block leaves no stale id (ids embed the tx hash).
- Decimals/`amount` live raw (`NUMERIC(78,0)`); UI amounts are only ever
  computed at read time once metadata is known. Unknown tokens are skipped (and
  logged) rather than guessed at 18 decimals.

## Known limits

- Covers ERC-20 `Transfer` events only (the curated dataset). Native ETH
  balance and ERC-721/1155 positions are out of scope.
- Realized PnL is computed from the app's own fills, not from raw transfers —
  external Rabby-only trades outside the app won't move `trade_pnl` (their
  tokens still appear in holdings/history via the ledger).
