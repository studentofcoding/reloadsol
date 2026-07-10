# GMGN Smart Money Strategy

Paper-trading strategy domain that discovers entries from **GMGN smart money / KOL buys** via `gmgn-cli`, gates candidates with GMGN token security scoring, and records outcomes in `strategy_outcomes`.

## Architecture

```text
Go cron (gmgn_sim_track, ~120s)
  → POST /api/gmgn/sim-track?key=...
    → gmgn-cli track smartmoney|kol
    → gmgn-cli token info + security (max 5 candidates/tick)
    → open/close sim in trading_records (wallet: gmgn-sim)
    → strategy_outcomes on close
```

## Strategies (code defaults)

| ID | Source | Default |
|----|--------|---------|
| `gmgn_smartmoney_default` | smartmoney | inactive, sim_only |
| `gmgn_kol_momentum` | kol | inactive, sim_only |

Configure at `/dev/strategies` → **GMGN strategies**.

## VPS setup

1. Install CLI globally on the host (or in the web container):

```bash
npm install -g gmgn-cli
gmgn-cli config --apply <YOUR_GMGN_API_KEY>
```

2. Add to app `.env`:

```bash
GMGN_API_KEY=gmgn_...
# optional overrides
GMGN_CLI_BIN=gmgn-cli
GMGN_SIM_INTERVAL=120
GMGN_SIM_TRACK_SECRET=...   # defaults to TRENDING_TRACKER_SECRET
GMGN_SIM_WALLET_ADDRESS=gmgn-sim
```

3. Apply DB migration on existing volumes:

```bash
psql "$DATABASE_URL" -f db/init/10-gmgn-strategy-domain.sql
```

4. Rebuild web + cron so `gmgn_sim_track` worker is scheduled.

## Enable and smoke test

1. `/dev/strategies` → activate **`gmgn_smartmoney_default`** (`is_active: true`, `execution_mode: sim_only`).
2. Manual trigger:

```bash
curl -X POST "http://127.0.0.1:8080/trigger/gmgn-sim-track"
# or direct API:
curl -X POST "http://127.0.0.1:3000/api/gmgn/sim-track?key=$TRENDING_TRACKER_SECRET"
```

3. Verify:
   - Open buys in `trading_records` (`wallet_address = gmgn-sim`, `bot_strategy = gmgn_smartmoney_default`)
   - `entry_features` includes `gmgn_*` fields + `discovery_*`
   - Closes write `strategy_outcomes` with `domain = gmgn`

## Security gate (defaults)

- Mint + freeze renounced (SOL)
- Creator exited (`creator_close`)
- Top-10 holders ≤ 20%
- Rug ratio ≤ 0.30 (when present)
- Min smart wallets ≥ 3
- Min liquidity ≥ $10k (warning if below; mixed verdict)
- Max sniper wallets ≤ 20 (warning)
- Only **`clean`** verdict opens sim (`minVerdict: clean`)

Tune in strategy config or via PATCH `/api/strategies/{id}`.

## Rate limits

GMGN leaky bucket (~20 capacity). Per cron tick budget:

- 1× track call (weight 3)
- Up to **5** candidates × (info + security) = 10 calls

Do not lower `maxCandidatesPerTick` above 5 without reviewing rate limits. On 429, CLI wrapper waits once using `reset_at` / `X-RateLimit-Reset`.

**IPv6:** gmgn-cli requires IPv4 outbound. If 401/403 with valid key, check IPv6 routing.

## Entry features (for analysis / future ML)

Stored on sim buy `entry_features`:

- `discovery_source`, `discovery_wallet`, `discovery_trade_usd`, `discovery_trade_at`
- `gmgn_price_usd`, `gmgn_market_cap_usd`, `gmgn_liquidity_usd`
- `gmgn_smart_wallets`, `gmgn_top_10_holder_rate`, `gmgn_security_verdict`

## Live execution (prepared, not enabled v1)

`src/strategies/gmgn-execution.ts` stubs `gmgn-cli swap` behind `GMGN_PRIVATE_KEY`.

Go-live checklist (future):

1. Set `GMGN_PRIVATE_KEY` (wallet bound to API key)
2. Run `gmgn-cli token security` manually before first live buy
3. Flip strategy `execution_mode` to `live_only` only after sim review
4. Use explicit operator confirmation (mirror gmgn-swap skill)

## Key files

- `src/utils/gmgn-cli.ts` — CLI wrapper
- `src/strategies/gmgn-pipeline.ts` — discovery + dedupe
- `src/strategies/gmgn-security-gate.ts` — scoring card
- `src/app/api/gmgn/sim-track/route.ts` — cron target
- `src/strategies/registry.ts` — `GMGN_STRATEGIES` defaults
- `main.go` — `gmgn_sim_track` worker
