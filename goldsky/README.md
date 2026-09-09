# Goldsky RH wallet ledger

Turbo pipeline configs that stream the app's Robinhood-wallet ERC-20 activity
into the reloadSOL Postgres. See `../GOLDSKY_RH_LEDGER.md` (repo root) for the
end-to-end architecture and runbook.

## Layout

| File | Purpose |
|---|---|
| `pipelines/rh-wallet-ledger.yaml` | Live tail pipeline (`start_at: latest`) |
| `jobs/rh-wallet-ledger-backfill.yaml` | One-time genesis→tip history backfill (job mode) |

Both consume `robinhood_mainnet.erc20_transfers` and deliver **only** events
where a tracked wallet is sender or recipient, as HTTP batches to
`POST <APP_HOST>/api/rh/ledger/ingest` (see `src/app/api/rh/ledger/ingest/route.ts`).

## Deploying (fresh setup)

**One-command path (preferred):** export the env vars below and run
`bash scripts/goldsky-rh-ledger-deploy.sh --apply` — it renders the YAMLs from
`GMGN_BOUND_EVM_ADDRESS` (+ optional `RH_TRACKED_PARENT_ADDRESS`), fetches the RH
tip for the backfill bound, validates, and applies backfill then tail. Run
without `--apply` to just render + validate. Set `RH_LEDGER_WEBHOOK_SECRET_NAME`
to the secret name shown by `goldsky secret list` (the CLI often auto-names it,
e.g. `HTTPAUTH_SECRET_…`).

Manual path (templates use `<WALLET_WHERE>`, `<APP_HOST>`, `<WEBHOOK_SECRET_NAME>`,
`<TIP_BLOCK>` placeholders):

1. Pin the dataset version (do not trust the YAML blindly):
   ```bash
   goldsky dataset get robinhood_mainnet.erc20_transfers --outputFormat json
   ```
2. Fill placeholders in both YAMLs (no secrets — just addresses + host):
   - `<WALLET_1>`, `<WALLET_2>` — lowercased `0x` wallets (typically the
     `GMGN_BOUND_EVM_ADDRESS` bound wallet + your Rabby parent wallet).
   - `<APP_HOST>` — the public hostname that reaches `/api/rh/ledger/ingest`.
   - `<TIP_BLOCK>` (job only) — RH chain tip at deploy:
     `curl -s https://edge.goldsky.com/standard/evm/4663?key=... -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`
3. Create the webhook auth secret once (header `Authorization: Bearer <RH_LEDGER_WEBHOOK_SECRET>`):
   ```bash
   goldsky secret create RH_LEDGER_WEBHOOK_SECRET   # type: httpauth
   ```
4. Validate + deploy (Turbo binary required: `curl https://install-turbo.goldsky.com | sh`):
   ```bash
   goldsky turbo validate goldsky/jobs/rh-wallet-ledger-backfill.yaml
   goldsky turbo apply goldsky/jobs/rh-wallet-ledger-backfill.yaml   # backfill first
   goldsky turbo validate goldsky/pipelines/rh-wallet-ledger.yaml
   goldsky turbo apply goldsky/pipelines/rh-wallet-ledger.yaml       # then the tail
   ```

## Adding a wallet later

1. Add its address to the `IN (...)` list in the tail pipeline YAML and
   `goldsky turbo apply` it again (checkpoint is preserved).
2. Backfill its history with a one-off job — edit `jobs/rh-wallet-ledger-backfill.yaml`
   to the new wallet list + current tip, apply, wait for completion, then delete.
   Upserts are idempotent so overlap with the tail is harmless.

## Costs / sizing

The transform filters to wallet events, so sink writes (billed per record) are
tiny; the backfill job scans chain-wide transfers once and self-deletes. If the
tail ever lags, check `goldsky turbo list` runtime details and bump
`resource_size`.

## Notes

- Webhook sink delivers **batches** (`one_row_per_request: false`) with
  at-least-once semantics; retries on 5xx/429/timeouts with backoff. The ingest
  route upserts `ON CONFLICT DO NOTHING`, so duplicates/replays are no-ops and
  every successful batch gets a 2xx ack.
- Decimals are **not** present in the curated transfers dataset. The app
  resolves metadata lazily into `rh_token_meta` (Blockscout → GMGN) and applies
  decimals at read time, so never store UI amounts derived from decimals here.
