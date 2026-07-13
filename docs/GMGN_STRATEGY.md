# GMGN Smart Money Strategy

Paper-trading strategy domain that discovers entries from **GMGN smart money / KOL buys** via OpenAPI HTTP (CLI optional fallback), gates candidates with GMGN token security scoring, scores 60-minute SM+KOL activity, and records outcomes in `strategy_outcomes`.

## Architecture

```text
Go cron (gmgn_activity_poll, ~180s)
  → POST /api/gmgn/activity-poll?key=...
    → OpenAPI track smartmoney + kol
    → 60m activity score (hot tokens only)
    → Jupiter market hints (price + mcap)
    → 2h Radar accumulator (peak SM/KOL/activity + Early Enter stamps)
    → Radar review + config.radar price/comeback rules
    → Telegram single-thread card (edit until dead; new msg on comeback)
    → insertSocialEvents (cooldown) → social rollup

Signals poll (GET /api/trading/signals)
  → Stage-1 Early Enter (growth < 100%)
  → insertSocialEvents (source signals_early)  ← Radar reads this in 2h window
  → Telegram Early Signals Enter

Go cron (gmgn_sim_track, ~120s)
  → POST /api/gmgn/sim-track?key=...
    → OpenAPI track + token info/security
    → score-sorted discovery → security gate + same Radar accumulator
    → open/close sim in trading_records (wallet: gmgn-sim)
    → strategy_outcomes on close
```

## Strategies (code defaults)

| ID | Source | Default |
|----|--------|---------|
| `gmgn_smartmoney_default` | smartmoney | inactive, sim_only |
| `gmgn_kol_momentum` | kol | inactive, sim_only |
| `gmgn_sm_kol_combined` | both (score-sorted) | inactive, sim_only |

Configure at `/dev/strategies` → **GMGN strategies**.

## VPS setup

1. Add to app `.env` (HTTP read paths — **no CLI required**):

```bash
GMGN_API_KEY=gmgn_...
# optional overrides
GMGN_API_HOST=https://openapi.gmgn.ai
GMGN_TRANSPORT=http          # default; set cli to force gmgn-cli subprocess
GMGN_CLI_BIN=gmgn-cli        # only when GMGN_TRANSPORT=cli
GMGN_SIM_INTERVAL=120
GMGN_ACTIVITY_POLL_INTERVAL=180
GMGN_ACTIVITY_SCORE_THRESHOLD=50
GMGN_ACTIVITY_WINDOW_MINUTES=60
GMGN_ACTIVITY_POLL_LIMIT=50
GMGN_ACTIVITY_INGEST_COOLDOWN_MIN=15
GMGN_SIM_TRACK_SECRET=...    # defaults to TRENDING_TRACKER_SECRET
GMGN_SIM_WALLET_ADDRESS=gmgn-sim
```

2. Apply DB migrations on existing volumes:

```bash
psql "$DATABASE_URL" -f db/init/10-gmgn-strategy-domain.sql
psql "$DATABASE_URL" -f db/init/11-gmgn-sm-kol-combined.sql
psql "$DATABASE_URL" -f db/init/13-radar-alert-threads.sql
```

(`radar_alert_threads` is also auto-created at runtime if missing.)

3. Rebuild web + cron so `gmgn_sim_track` and `gmgn_activity_poll` workers are scheduled.

## Enable and smoke test

1. `/dev/strategies` → activate **`gmgn_sm_kol_combined`** or **`gmgn_smartmoney_default`** (`is_active: true`, `execution_mode: sim_only`).
2. Manual triggers:

```bash
curl -X POST "http://127.0.0.1:8080/trigger/gmgn-activity-poll"
curl -X POST "http://127.0.0.1:8080/trigger/gmgn-sim-track"
# or direct API:
curl -X POST "http://127.0.0.1:3000/api/gmgn/activity-poll?key=$TRENDING_TRACKER_SECRET"
curl -X POST "http://127.0.0.1:3000/api/gmgn/sim-track?key=$TRENDING_TRACKER_SECRET"
```

3. Verify:
   - Hot tokens in `social_token_events` (`source LIKE 'gmgn_%'`, `raw_metadata.gmgn_activity_score`)
   - Open Telegram lifecycle card (one message edited in place; dead card frozen; comeback = new message)
   - Rows in `radar_alert_threads` (`status` open/dead)
   - Open buys in `trading_records` (`wallet_address = gmgn-sim`)
   - `entry_features` includes `gmgn_activity_score`, `sm_wallet_count_60m`, etc.
   - Closes write `strategy_outcomes` with `domain = gmgn`

## 60-minute activity score

Per-token score from SM + KOL buys in the activity window (default 60m):

```
score =
  min(sm_wallets, 10) * 15
+ min(kol_wallets, 5) * 10
+ log1p(sm_usd + kol_usd) * 10
+ (sm >= 2 ? 20 : 0)
+ (sm >= 1 && kol >= 1 ? 30 : 0)   // mogdog overlap bonus
+ recency bonus (≤15m: +20, ≤60m: +10)
```

Only tokens with `score >= GMGN_ACTIVITY_SCORE_THRESHOLD` (default 50) are ingested into the social pipeline as `gmgn_hot` / `gmgn_smartmoney` / `gmgn_kol` wallet_buy events.

## Radar review (Telegram + entry features)

Separate from the **activity score** (used for hot ingest). Radar is a 0–100 decision card: **SKIP &lt;45**, **WATCH 45–77**, **ENTER ≥78**.

**Telegram:** only **WATCH** and **ENTER** are shared. SKIP is still scored and stored on `raw_metadata` / entry features, but not posted.

### Accumulators (2h per mint)

Before scoring, activity-poll and gmgn-pipeline merge:

| Peak | Source |
|------|--------|
| `smPeak` / `kolPeak` | max(current poll, prior `gmgn_*` social events) |
| `activityScorePeak` | max(current activity score, prior events) |
| Early Signals | `social_token_events` with `source = signals_early` (stamped on Stage-1 Early Enter) |

### Point budget (then clamp 0–100)

| Component | Max | Notes |
|-----------|-----|-------|
| Base | 10 | Always |
| Accumulated SM | 25 | `min(sm, 10) × 2.5` |
| Accumulated KOL | 15 | `min(kol, 10) × 1.5` |
| Activity score | 35 | Map 0→200 → 0→35 |
| Early Signals | 20 | +20 if early score ≥50; else +8 if growth ≥20% |
| Quality | 20 | holders / **top10** / buy-sell return only |
| Soft cap | 35 | If no SM, no KOL, and no early |

**Not scored:** tax, liquidity (dropped by design).

**top10:** GMGN `gmgn_top_10_holder_rate` first; if missing, Jupiter `audit.topHoldersPercentage` (fetch only when about to alert). Telegram line shows e.g. `top10 18% (jup)`.

SKIP copy uses “insufficient confirmation” when SM/KOL alone are weak — it does **not** treat “smart money present” as a risk reason.

### Price growth rules (reappearances)

On each hot Radar pass, fetch USD price + mcap (Jupiter market hints) and compare to the previous `radar_price_usd` / `radar_mcap_usd` on `social_token_events`. Thresholds live on strategy `config.radar` (defaults below):

| Rule | Default | Effect |
|------|---------|--------|
| Sticky pump WATCH | `stickyPumpPct` 50 | Force **WATCH**; sticky baseline = previous price |
| Hold sticky | price &gt; baseline | Keep **WATCH** until ≤ baseline |
| Dump ban | `dumpBanPct` -80 | SKIP + `markTokenRug(gmgn-radar)` + close sims |

Low absolute mcap (e.g. staying under $30k after a micro start) is **not** treated as rug — tokens can keep being tracked at any mcap. Soft death still uses comeback drawdown stages.

### Comeback (configurable)

`config.radar.comeback` stages (defaults): `drawdownPct` 70, `troughMcapMax` 30k, `recoverMultiple` 1.5, `minRadarScore` 45, `unbanOnComeback` false, `allowSimReopen` false.

- Soft/hard death → final-edit open Telegram to **RUG / DEAD**, freeze that message in chat.
- Recover after dead lifecycle → **new** COMEBACK message (old dead card stays). Optional unban via `unbanOnComeback`.

### Telegram single thread

When `config.radar.telegram.singleThread` is true (default): one editable card per lifecycle with initial price/MC, now + % vs last, peak SM/KOL. Ingest stays cooldown-gated; **thread refresh** runs every hot poll. Persist in `radar_alert_threads`.

Metadata: `radar_price_usd`, `radar_mcap_usd`, `radar_growth_pct`, `radar_watch_baseline_usd`, `radar_dump_banned`, `radar_thread_action`.

### Key files

- `src/strategies/gmgn-radar-accumulate.ts` — 2h peak merge
- `src/strategies/gmgn-radar-review.ts` — score / action / Telegram HTML (live thread + rug)
- `src/strategies/gmgn-radar-price.ts` — sticky / dump (config thresholds)
- `src/strategies/gmgn-radar-comeback.ts` — drawdown death + comeback evaluators
- `src/strategies/gmgn-radar-thread-sync.ts` — send/edit lifecycle cards
- `src/strategies/gmgn-radar-dump.ts` — dump/rug ban + sim close
- `src/app/api/gmgn/activity-poll/route.ts` — accumulator + thread refresh + ingest
- `src/app/api/trading/signals/route.ts` — Early Enter → `signals_early` stamp

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

GMGN leaky bucket (~20 capacity). Per poll tick: **2** track calls (SM + KOL). Per sim tick: 1–2 track + up to **5** candidates × (info + security).

On 429, HTTP client waits once using `reset_at` / `X-RateLimit-Reset`.

## Entry features (analysis + ML logging)

Stored on sim buy `entry_features`:

- `gmgn_activity_score`, `sm_wallet_count_60m`, `kol_wallet_count_60m`, `sm_buy_usd_60m`, `kol_buy_usd_60m`
- `discovery_source`, `discovery_wallet`, `discovery_trade_usd`, `discovery_trade_at`
- `gmgn_price_usd`, `gmgn_market_cap_usd`, `gmgn_liquidity_usd`
- `gmgn_smart_wallets`, `gmgn_top_10_holder_rate`, `gmgn_security_verdict`
- Radar peaks when present: `radar_action`, `radar_score`, `radar_sm_peak`, `radar_kol_peak`, `radar_activity_peak`, `early_signals_score`, `top10_source`

Mcap/signals sim opens also stamp GMGN fields from recent `gmgn_*` social events when present.

### Pattern ML (v1.1)

Three new pattern-gate features (TS + Python in sync):

- `gmgn_activity_score_60m`
- `log_gmgn_sm_wallets_60m`
- `has_gmgn_hot_before_entry`

Retrain pattern when export fill rate is non-zero: `npm run ml:export-patterns` → `npm run ml:train-pattern`. Keep `ML_PATTERN_MODE=shadow` until `pattern_ready`.

## Live boost after entry

When a token is **already tracked** or has an **open sim position**, and `gmgn_hot` arrives later via activity poll, the system applies a **live boost** (not an entry-time ML feature):

- Patches open buy `entry_features`: `has_gmgn_hot_after_entry`, `gmgn_hot_after_entry_at`, `gmgn_live_boost_score`, etc.
- Increases `social_boost_score` on the open position
- Optional TP widen via `GMGN_LIVE_BOOST_EXIT=shadow|apply|off` (default shadow)
- Optional operator toast via `GET /api/mcap-tracking/sim-open-alerts` (category predictive)

```bash
GMGN_LIVE_BOOST_ENABLED=true
GMGN_LIVE_BOOST_SCORE=25
GMGN_LIVE_BOOST_MIN_SCORE=50
GMGN_LIVE_BOOST_EXIT=shadow
GMGN_LIVE_BOOST_TOAST=true
```

Triggers: **activity poll** (primary) + **sim-track ticks** on mcap/signals/gmgn (backup).

### Smoke test

With an open mcap/signals/gmgn sim position and `DATABASE_URL` set:

```bash
npm run smoke:gmgn-live-boost
# optional:
npx tsx scripts/smoke-gmgn-live-boost.ts --mint=YOUR_MINT
npx tsx scripts/smoke-gmgn-live-boost.ts --http    # API ingest + sim-track (no direct DB writes)
npx tsx scripts/smoke-gmgn-live-boost.ts --skip-ingest  # use existing gmgn_hot row
```

Exits 0 when `has_gmgn_hot_after_entry=1` on the open buy after the run.

## Live execution (prepared, not enabled v1)

`src/strategies/gmgn-execution.ts` stubs `gmgn-cli swap` behind `GMGN_PRIVATE_KEY`.

Go-live checklist (future):

1. Set `GMGN_PRIVATE_KEY` (wallet bound to API key)
2. Run security check manually before first live buy
3. Flip strategy `execution_mode` to `live_only` only after sim review
4. Use explicit operator confirmation

## Key files

- `src/utils/gmgn-api.ts` — OpenAPI HTTP client (default)
- `src/utils/gmgn-cli.ts` — barrel + CLI fallback (`GMGN_TRANSPORT=cli`)
- `src/strategies/gmgn-activity-score.ts` — 60m scorer
- `src/strategies/gmgn-radar-accumulate.ts` — 2h SM/KOL/activity/early peaks
- `src/strategies/gmgn-radar-review.ts` — Radar 0–100 ENTER/WATCH/SKIP
- `src/strategies/gmgn-radar-price.ts` — reappearance growth → sticky WATCH / dump ban
- `src/strategies/gmgn-radar-comeback.ts` — configurable drawdown death + comeback
- `src/strategies/gmgn-radar-thread-sync.ts` — single Telegram card per lifecycle
- `src/strategies/gmgn-radar-dump.ts` — ban + close open sims on dump/rug
- `src/strategies/gmgn-live-boost.ts` — post-entry live boost
- `src/strategies/gmgn-pipeline.ts` — score-sorted discovery + security gate + Radar
- `src/app/api/gmgn/activity-poll/route.ts` — hot token → Radar + social ingest
- `src/app/api/gmgn/sim-track/route.ts` — cron sim target
- `src/strategies/registry.ts` — `GMGN_STRATEGIES` + `DEFAULT_GMGN_RADAR`
- `src/strategies/gmgn-radar-threads-db.ts` — `radar_alert_threads` persistence
- `db/init/13-radar-alert-threads.sql` — thread table
- `main.go` — `gmgn_sim_track` + `gmgn_activity_poll` workers

## Next build (Radar)

| Priority | Item | Why |
|----------|------|-----|
| **P0** | Strategy Admin **GMGN → Radar** knobs (`config.radar` + comeback + singleThread) | Knobs exist in registry/DB merge but **GmgnCard UI has no Radar section** — operators cannot tune without raw PATCH |
| P1 | Wire `allowSimReopen` on comeback (sim open only) | Flag exists; reserved in thread sync |
| P2 | Sticky TTL / score-override for ENTER during sticky | Still blocks ENTER on grinders like Wukong |
| — | ML enforce / live GMGN swap | Explicit non-goals until sim review + `*_ready` |
