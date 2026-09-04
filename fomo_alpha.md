# fomo_alpha — RobinhoodTrenches (fomo.family) integration plan

**Status:** Planning · **Owners:** planning phase only
**Last verified:** 2026-09-04 (live REST + WS probed)
**Data grade:** research-grade external source — mirror & cache everything; do **not** treat as source of truth for execution.

---

## 1. The source — what robinhoodtrenches.com actually is

A read-only public indexer of **108 tracked fomo.family traders** on Robinhood Chain (EVM **4663**). Site header states: *"read-only, no keys, no trading, nothing here is advice."* It is a **data source, not a venue.**

Two transport layers, both open, no auth:

| Layer | Where | Notes |
|---|---|---|
| **Live websocket** | `wss://robinhoodtrenches.com/ws` | JSON text frames; client keepalive = `ws.send('p')` every 20s; reconnects after 2.5s |
| **REST** | `https://robinhoodtrenches.com/api/*` | windowed snapshots + history, see §3 |

**WS protocol** (verified live):

```
on connect  → {"type":"hello","data":{...status object}}
on trade    → {"type":"fills","data":[{fill...}, ...]}   // one or more, as blocks land
keepalive   → client sends text "p" every 20s (server otherwise drops idle)
reconnect   → client-side: onclose → setTimeout(connect, 2500)
```

- Indexer lag is ~0.1s (`status.lag_seconds`); it's a transfer-log → fill decoder, so a fill arrives ~as the tx confirms.
- Status object fields: `chain`, `chain_id`, `wallets`, `uptime`, `source`, `lag_seconds`, `last_block`, `indexer_age`, `trades` (fills indexed), `first_ts`, `latency`, `viewers`, `last_ts`, `server_ts`.

**Identities and links** (every fill/row carries both a wallet and a token):

| Entity | Format | Example |
|---|---|---|
| wallet | EVM `0x` (also `solana_address` twin on `/trader`) | `0x9ce0cb4a...` |
| token | EVM `0x` | `0x42afa212...` |
| handle | fomo.family handle | `PoorGoat_`, `orangie` |
| profile | `https://fomo.family/profile/{handle}` | |
| token pair | dexscreener pair URL | `https://dexscreener.com/robinhood/{pair}` |
| explorer | `https://robinhoodchain.blockscout.com/{address,tx,token}/{id}` | |

---

## 2. Why it matters for this codebase

This repo is `solana-bulk-buy` — a Next.js 16 + Go cron + Postgres/Redis system. Robinhood chain is uniformly **`sim_only`** (no live RH execution). The codebase already consumes GMGN OpenAPI (`chain=robinhood`) for SM/KOL buys → `wallet_buy` → `social_token_events` → discovery/gating → sim opens, plus a wallet-digger roster watch (`alpha_roster_trade_events`, `alpha_concurrence_signals`). **No reference to robinhoodtrenches.com exists anywhere in the repo.**

RobinhoodTrenches covers the **same 0x token space from a different wallet universe** (fomo.family 108), and — the differentiator — it already computes **per-wallet realized PnL, win rate, closed trades, hold time, and open bags marked live.** GMGN does not give a clean per-position PnL history. That unlocks:

- **Wallet edge scoring** — weight signals by a trader's measured realized PnL / profit factor, not raw follower count.
- **Leader→follower chains with lag + outcome** (`/api/flow`) — a pre-built copy-trade cohort signal.
- **Fresh-pool radar with pool age at first buy** (`/api/radar`) — an earlier discovery feed than GMGN market-rank.
- **A user-facing live tape** mirroring the existing GMGN UI (which lacks a tracked-wallet portfolio view).

**What it is NOT:** an execution venue, an SLA'd feed, or a GMGN replacement. Keep GMGN as source of truth for execution-critical token/price data.

---

## 3. REST endpoints (all verified live)

Query params: `window=1h|24h|7d|30d|all`, `stocks=true|false`, `limit`.

### `GET /api/tape`
Last raw fills (page boot fetches `limit=400`, replay last 120). **Same shape as the WS `fills` frames.**

```
id, ts, tx, side(buy|sell), usd, amount, price,
new_position(0|1), is_stock(0|1), block, priced(cash_leg|estimate),
handle, display_name, followers, wallet(0x), token(0x),
symbol, name, mark, liquidity, pair_url, flags[]
```

> `priced:'estimate'` = size from price feed, **no readable cash leg** → shown as `~$X` on the site. Filter on `cash_leg` for decision-critical logic.

### `GET /api/traders`
Leaderboard row per wallet:

```
address(0x), handle, display_name, followers, profile_url,
volume, fills, buys, sells, last_ts,
realized_pnl, closed_trades, wins,
best_trade, worst_trade, open_bags, open_cost, open_value,
unrealized_pnl, net_pnl, win_rate, state(flat|...), active
```

### `GET /api/tokens`
Token aggregates for the window — **who bought and who is still holding**:

```
token(0x), symbol, name, is_stock,
traders, buyers, holders,
usd_in, usd_out, net_usd, first_ts, last_ts,
mark, liquidity, change24, volume24, pair_url, pair_created_at,
first_buyer:{ ts, price, handle, followers }, since_first_buy_pct
```

### `GET /api/flow`
**The copy-trade cohort signal.** Lead buyer + who piled in after, with lag:

```
token(0x), symbol, name, is_stock,
lead:{ ts, usd, price, handle, followers, profile_url, wallet(0x) },
followers:[{ ts, usd, price, handle, followers, profile_url, wallet(0x), lag_seconds }],
follower_count, mark, pair_url, since_lead_pct, total_usd
```

### `GET /api/closed`
Positions taken all the way back to flat (one row per position, not per sell):

```
wallet(0x), token(0x), opened_ts, closed_ts,
cost_sold, proceeds_usd, pnl_usd, pnl_pct, hold_seconds,
buys, sells, handle, followers, profile_url, symbol, is_stock
```

### `GET /api/radar`
Fresh pools (site uses `minutes=120`):

```
token(0x), symbol, name, is_stock, first_ts, buyers, usd_in,
mark, liquidity, pair_created_at, pair_url, change24, volume24,
pool_age, age_at_first_buy, fresh,
first_buyer:{ handle, followers, ts }
```

### `GET /api/overview`, `GET /api/status`
Window stats + indexer health. Overview has `biggest_win`, `biggest_buy`, `last_5m{buys,sells,volume}`, `win_rate`, `open_bags`, `realized/unrealized/net_pnl`. Status is the WS `hello` object.

### `GET /api/trader/{handle}` (URL-encoded)
Drill-down: `joined`, `num_trades`, `volume_usd`, `solana_address`, `streak`, plus:
- `stats`: realized/unrealized/net_pnl, win_rate, closed_trades, profit_factor, best/worst_trade, avg_hold_seconds, open_bags
- `bags[]`: token, amount, cost_usd, avg_price, opened_ts, last_buy_ts, **mark/liquidity/change24/value/pnl/pnl_pct (marked live)**, priced, age_seconds
- `history[]`: closed positions (see `/api/closed` shape, incl. symbol per leg)
- `curve[]`: running realized PnL sparkline `{ts, pnl}`

---

## 4. Goals & non-goals

### Goals
1. **Stand up an ingestion + storage layer** for fomo.family fills → queryable history (backtestable).
2. **Derive algo signals** — wallet edge, roster-concurrence, /flow-style leader→follower chains, fresh-pool radar — and run them through the existing discovery/gating/sim pipeline (**RH = sim only**, so this is the correct sandbox).
3. **Expose a user-facing info path** — robinhoodtrenches tab / tracked-wallet portfolio with live-marked bags.
4. **Follow the house data policy:** env-tunable rates, Redis TTL caches, dedupe keys, cooldowns, fail-fast, Telegram alert dedupe.

### Non-goals
- Live RH execution (blocked by repo-wide `sim_only` for robinhood).
- Replacing GMGN as discovery source of truth.
- Scraping fomo.family or the Robinhood chain directly (site already does the indexing).
- Relying on the source for anything execution-critical without a mirror.

---

## 5. Proposed architecture

```
robynhoodtrenches.com
   │  wss://…/ws  (fills, live)          REST /api/* (snapshots)
   ▼                                     ▼
┌─ ws-feed worker (own process / Go cron worker id, secret-gated route) ─┐
│  WS client: connect, 'p' keepalive ×20s, reconnect ×2.5s,              │
│  heartbeat lag + last-heard watchdog                                    │
│  on 'fills' → normalize → batch insert                                  │
│  on 'hello' → record status (viewers/lag/last_block)                    │
└──────────────┬──────────────────────────────────────────────────────────┘
               ▼
┌───────────── fomo_fills (Postgres) ─────────────┐
│  raw tape, deduped on tx+wallet+side; unique id │
└──────┬──────────────────────┬───────────────────┘
       ▼                      ▼
  fomo_token_rollups    fomo_closed_positions / fomo_bags
  (window agg, like     (per-position PnL: opened/closed_ts,
   /api/tokens)          cost_sold, proceeds, pnl, hold_s)
       │                       │
       ▼                       ▼
  ┌───────────────────────────────────────────────┐
  │ Signal layer (reuse repo seams):              │
  │  • social_token_events producer (chain=robinhood) │
  │  • alpha_roster_trade_events / concurrence mirror │
  │  • mcap tracker + gates                        │
  │  • Telegram + SSE toast drains (existing)      │
  └───────────────────────────────────────────────┘
```

---

## 6. Storage layer (draft schema, Postgres)

> New tables under `db/init/` in a new numbered migration. Follow existing patterns: `chain` col, `jsonb raw_metadata`, PK dedupe, indexes on `(token_address, ts)`, `(wallet_address, ts)`.

### `fomo_fills` — append-only raw tape (primary mirror)

```sql
CREATE TABLE fomo_fills (
  id             BIGSERIAL PRIMARY KEY,
  source_fill_id BIGINT NOT NULL,          -- site's monotonic id
  tx             TEXT NOT NULL,
  wallet_address TEXT NOT NULL,            -- 0x…
  token_address  TEXT NOT NULL,            -- 0x…
  symbol         TEXT,
  name           TEXT,
  handle         TEXT,                     -- display_name too, jsonb
  side           TEXT NOT NULL CHECK (side IN ('buy','sell')),
  usd            NUMERIC(28,12),           -- null when not priced
  amount         NUMERIC(40,18),
  price          NUMERIC(40,18),
  mark           NUMERIC(40,18),           -- price feed mark at index time
  liquidity      NUMERIC(28,12),
  followers      BIGINT,
  new_position   BOOLEAN,
  is_stock       BOOLEAN NOT NULL DEFAULT FALSE,
  priced         TEXT,                     -- 'cash_leg' | 'estimate'
  block          BIGINT,
  pair_url       TEXT,
  flags          JSONB,
  occurred_at    TIMESTAMPTZ NOT NULL,     -- ts (unix) → timestamptz
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  dedupe_key     TEXT UNIQUE NOT NULL,     -- source_fill_id | tx | wallet | side
  chain          TEXT NOT NULL DEFAULT 'robinhood',
  UNIQUE (source_fill_id)
);
CREATE INDEX idx_fomo_fills_token_ts  ON fomo_fills (token_address, occurred_at DESC);
CREATE INDEX idx_fomo_fills_wallet_ts ON fomo_fills (wallet_address, occurred_at DESC);
```

> The site's `id` is **monotonic and already present in both WS and `/tape`** — use it as the high-water mark (`last_id`) for resume/reconnect and for dedupe, not just tx hash (a wallet can re-buy the same token).

### `fomo_traders` — wallet snapshot (edge scoring)

```sql
CREATE TABLE fomo_traders (
  wallet_address TEXT PRIMARY KEY,
  handle         TEXT,
  display_name   TEXT,
  followers      BIGINT,
  profile_url    TEXT,
  solana_address TEXT,
  joined         TEXT,                     -- '2025-11-11'
  volume_usd     NUMERIC(28,12),
  num_trades     BIGINT,
  realized_pnl   NUMERIC(28,12),
  unrealized_pnl NUMERIC(28,12),
  net_pnl        NUMERIC(28,12),
  win_rate       NUMERIC(6,4),
  profit_factor  NUMERIC(10,4),
  closed_trades  BIGINT,
  open_bags      BIGINT,
  open_cost      NUMERIC(28,12),
  open_value     NUMERIC(28,12),
  state          TEXT,
  last_ts        BIGINT,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `fomo_closed_positions` — per-position realized PnL

```sql
CREATE TABLE fomo_closed_positions (
  id            BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol        TEXT,
  handle        TEXT,
  followers     BIGINT,
  is_stock      BOOLEAN DEFAULT FALSE,
  opened_ts     TIMESTAMPTZ NOT NULL,
  closed_ts     TIMESTAMPTZ NOT NULL,
  cost_sold     NUMERIC(28,12),
  proceeds_usd  NUMERIC(28,12),
  pnl_usd       NUMERIC(28,12),
  pnl_pct       NUMERIC(12,6),
  hold_seconds  BIGINT,
  buys          INT,
  sells         INT,
  source_json   JSONB,
  dedupe_key    TEXT UNIQUE NOT NULL,      -- wallet|token|opened_ts|closed_ts
  chain         TEXT NOT NULL DEFAULT 'robinhood',
  UNIQUE (wallet_address, token_address, opened_ts, closed_ts)
);
```

### `fomo_bags` — open bags marked live (trader drill-down refresh)

```sql
CREATE TABLE fomo_bags (
  id            BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol        TEXT,
  amount        NUMERIC(40,18),
  cost_usd      NUMERIC(28,12),
  avg_price     NUMERIC(40,18),
  opened_ts     TIMESTAMPTZ,
  last_buy_ts   TIMESTAMPTZ,
  mark          NUMERIC(40,18),            -- last live mark from site/DS
  value         NUMERIC(28,12),
  pnl           NUMERIC(28,12),
  pnl_pct       NUMERIC(12,6),
  age_seconds   BIGINT,
  priced        BOOLEAN,
  chain         TEXT NOT NULL DEFAULT 'robinhood',
  UNIQUE (wallet_address, token_address)
);
```

> Consider pruning: this universe is ~108 wallets; `fomo_fills` is the only unbounded table. Set a retention window (e.g. keep 90d raw) and/or downsample.

---

## 7. Ingestion design

### WS feed worker — two options (pick in planning)
- **A. Go cron worker** (`main.go`/`worker_tracker.go` pattern, + secret-gated POST route like `/api/workers/trigger`). Long-lived process; the repo's Go scheduler is the natural home for a persistent WS connection (can't poll a WS from a request-scoped cron POST).
- **B. A tiny standalone Node WS daemon** (new, modeled on `src/app/api/trading/subscribe/route.ts` SSE + `redis-cache.ts` pub/sub). Weigh restart supervision burden vs. option A.

**Regardless of host:**
- Connect `wss://robinhoodtrenches.com/ws`, send `p` every 20s, reconnect with 2.5s backoff, exponential cap.
- Watchdog: if no frame in >N s or `lag_seconds` > threshold, alert + reconnect (house rate-limit philosophy: fail-fast, immediate 429-style signal, no long sleeps).
- On connect, **backfill gap** from `/api/tape` using `last_id` high-water mark.
- Batch-write fills (house `WriteBatch` pattern); dedupe via `dedupe_key` `ON CONFLICT DO NOTHING`.
- Env knobs (house convention): `FOMO_WS_URL`, `FOMO_MAX_FILLS_PER_BATCH`, `FOMO_WS_KEEPALIVE_MS`, `FOMO_WS_RECONNECT_MS`, `FOMO_LAG_ALERT_SECONDS`, `FOMO_IDLE_ALERT_SECONDS`.
- Auth/gating: internal secret + IP allow, matching existing cron POST routes.
- Redis pub/sub (`publishJson`) on every ingested fill → existing SSE drains / live-boost style toast consumers.

### REST snapshot pollers
- `/api/traders` every N (60–120s) → upsert `fomo_traders`.
- `/api/tokens` + `/api/closed` every M (60s) → update rollups / closed positions.
- `/api/trader/{handle}` for the *actively-held* wallet subset (skip the 100+ flat wallets) every few minutes → `fomo_bags` (live marks) + history.
- Rate discipline: single consumer, TTL cache (10–30s), env knobs `FOMO_MAX_REQ_PER_SEC` default 1–2, negative cache on non-200 (house `gmgn-api.ts` rate-limit + `negative cache` pattern). **Do not hammer** — research-grade source, no SLA.

---

## 8. Signal layer (algo / information)

### 8a. `social_token_events` producer (sim pipeline, highest leverage)
Reuse `insertSocialEvents` (`src/strategies/social/db.ts`) as the seam. Map every fomo wallet **buy** fill to an event:

| Field | Value |
|---|---|
| `token_address` | fill.token |
| `event_type` | `wallet_buy` |
| `source` | `fomo_family` (new) |
| `chain` | `robinhood` |
| `wallet_address` | fill.wallet |
| `wallet_label` | fill.handle |
| `raw_metadata` | `{side, usd, amount, price, followers, liquidity, mark, new_position, priced, is_stock, tx, block, pair_url}` |
| `dedupe_key` | `fomo_family|{fill_id}` |

This automatically flows into:
- **RH sim strategies** via `discoverAndGateGmgnCandidates` / `gmgn_open_sim` — the pipeline already reads the event bus. (`sim_only`, mcap band `RH_MCAP_MIN/MIN` ~ $300K–$2M in `src/strategies/registry.ts`.)
- **mcap tracker** — token-level gate on mcap range + liquidity floor (pool must be real — check `liquidity`, not just presence).
- **Early-signal toasts/Telegram** via existing drains (add to `src/strategies/gmgn-live-boost.ts`-style drain with `TOAST_DEDUP_MS`).

### 8b. Wallet edge scoring (new, distinct from GMGN raw-follower weighting)
Compute from `fomo_traders` / `fomo_closed_positions`:

```
edge_score = f(realized_pnl, win_rate, profit_factor, closed_trades,
              avg_hold_seconds, recency/volume)
```

- Prefer **profit_factor** + win_rate on ≥ N closed trades over raw PnL (a whale can have huge PnL and negative edge).
- Fold into the existing **roster scoring** (`buildScoreParts` in `src/strategies/wallet-digger/digger.ts`) as a fomo-family weight.
- Verify against the site's own `win_rate`/`net_pnl` display semantics.

### 8c. Concurrence / leader→follower chain (mirror of `/api/flow`)
- Model after `findConcurrenceClusters` (`src/strategies/wallet-digger/concurrence.ts`), but with the **follower lag_seconds + since_lead_pct** the site already computes.
- Definition: ≥N fomo wallets buy same fresh token within a window → candidate (like `alpha_concurrence_signals`), then apply repo gates: pool age, `liquidity`, `RH_MCAP` band, security gate.
- Because `/api/flow` is windowed, derive the chain from **`fomo_fills`** (buy fills per token ordered by ts) so it's backtestable and not dependent on a live aggregation endpoint.

### 8d. Fresh-pool radar (`/api/radar` mirror)
- Poll `/api/radar` (minutes=120) → new `fomo_fills`-adjacent rows give `pool_age`/`age_at_first_buy`/`liquidity`/`change24`.
- Ideal **early discovery** input: pool-age-at-first-buy is a feature GMGN market-rank doesn't expose at this resolution.

### 8e. User-facing info path (information-based for users)
- **robinhoodtrenches tab** in the RH trading UI (mirror of existing GMGN/trending tabs) with:
  - Live tape (WS-fed via an SSE route modeled on `/api/trading/subscribe`; client keeps no WS directly).
  - Leaderboard with WON/LOST-tinted results — **status color must track `status`** (per house alert standard: 🟢 WON / 🔴 LOST), and sizes show `~` when `priced:'estimate'`.
  - **Tracked-wallet portfolio with live-marked open bags** (the data GMGN UI lacks).
  - Token "who's still holding" (holders vs buyers divergence) + first-buyer.
- Cross-referencing: fomo wallets have `solana_address` twins — a later phase could surface a wallet's Solana-side activity via existing Sol feeds.

---

## 9. What NOT to build (anti-scope)

- **No live RH trading** — sim only (repo-wide `sim_only`).
- **No direct chain indexing** — the site already does transfer-log → fill decoding; mirror, don't re-derive.
- **No scraping fomo.family** — profile URLs are for humans; the fill data already carries the PnL.
- **No reliance on the site for execution** — it's research-grade; mirror + cache, GMGN/Blockscout/DexScreener remain the execution-grade sources (site's dexscreener `pair_url`/`liquidity` still useful as a cross-check).

---

## 10. Phased build plan

### Phase 0 — spike (unblocks everything)
- [ ] Verify WS stream end-to-end from a local daemon (I confirmed handshake + `hello`; need fills capture over ≥10min to confirm shape + cadence + whether `fills` frames ever batch >1).
- [ ] Characterize REST rate tolerance (1 req/s OK? bursts?) — do NOT plan tighter than ~2 req/s sustained.
- [ ] Decide WS host: Go worker vs Node daemon vs (fallback) REST-only poll.
- [ ] Confirm `/api/flow` lag semantics are reproducible from `fomo_fills` alone.

### Phase 1 — ingestion + storage
- [ ] Migration: `fomo_fills`, `fomo_traders`, `fomo_closed_positions`, `fomo_bags`.
- [ ] WS worker (option A/B) with keepalive, reconnect, watchdog, high-water backfill.
- [ ] REST pollers (traders/tokens/closed/radar) with TTL cache + env rate knobs.
- [ ] Redis pub/sub on ingest + metrics/health endpoints (lag, last_id, fills/min).
- [ ] Retention/pruning policy for `fomo_fills`.

### Phase 2 — signals (sim pipeline)
- [ ] `insertSocialEvents` producer (`source: fomo_family`) + cooldown/dedupe.
- [ ] Wallet edge scorer → roster score fold-in.
- [ ] Concurrence-from-fills + fresh-pool radar candidates → repo gating (pool age, liquidity, RH_MCAP band, security).
- [ ] RH sim strategy def(s) (e.g. `fomo_family_*` in registry + `strategy_definitions` config) → sim opens/closes → `strategy_outcomes`.
- [ ] Telegram + SSE toasts (dedupe) on high-signal events.

### Phase 3 — user info path
- [ ] API routes (auth/network-gated like existing RH routes): live tape (SSE), leaderboard, wallets/bags, tokens, closed.
- [ ] UI tab mirroring GMGN tabs with WON/LOST-tinted statuses, `~` estimate sizes, live-marked portfolio.
- [ ] Chain/network gating consistent with `reloadsol.appNetwork=robinhood`.

### Phase 4 — evaluation & hardening
- [ ] Backtest concurrence/edge signals against `fomo_fills` history + repo mcap/price history.
- [ ] Compare win rates vs GMGN sm/kol strategies (same `strategy_outcomes` table → head-to-head).
- [ ] Data-grade review: add SLA/backpressure notes, re-verify source stability, prune if the site dies or rate-limits.
- [ ] Decide whether `pattern-ready`-style gating applies before any *live* (non-sim) use (unlikely given sim-only).

---

## 11. Open questions / risks

| # | Question | Why it matters | Who/What |
|---|---|---|---|
| 1 | WS fills frame cadence & batch size over sustained observation | Determines worker batching + replay | Phase 0 |
| 2 | Site uptime/SLA & rate tolerance | Research-grade source — need fail-fast + backoff, not hard dependency | Phase 0/4 |
| 3 | Does `id` stay monotonic across restarts? (it does within a session) | Resume/backfill correctness | Phase 0 |
| 4 | Are `mark`/`liquidity` values trustworthy for gates? | Don't open sims on phantom pools | Phase 1–2 |
| 5 | fomo roster overlap with existing GMGN sm/kol wallets | Avoid double-counting the same wallet | Phase 2 |
| 6 | Should edge scoring use closed-trade PnL only, or include open bags? | Signal quality vs freshness | Phase 2 |
| 7 | CORS/ToS — confirm the source tolerates programmatic access | Operational/legal | Phase 0 |
| 8 | Which wallets to `/trader` deep-poll for live bags (subset of 108) | Rate budget | Phase 1 |

---

## 12. Reference seams (codebase)

| Concern | Where |
|---|---|
| Event bus | `insertSocialEvents`, `social_token_events` — `src/strategies/social/db.ts` |
| Discovery/gating → sim | `discoverAndGateGmgnCandidates`, `openGmgnSimPosition` — `src/strategies/gmgn-pipeline.ts`, `gmgn-open-sim.ts` |
| RH sim twin | `runTrendingBotRhSimCycle` — `src/strategies/trending-bot-rh-sim.ts` |
| Roster watch + concurrence | `alpha_roster_trade_events`, `findConcurrenceClusters` — `src/strategies/wallet-digger/*` |
| Registry/bands | RH mcap band `RH_MCAP_MIN/MAX` — `src/strategies/registry.ts` |
| SSE push pattern | `/api/trading/subscribe` — `src/app/api/trading/subscribe/route.ts` |
| Redis pub/sub + TTL cache | `redis-cache.ts`, `cacheGet/cacheSet/publishJson/subscribeJson` |
| Rate gate / negative cache | `createSerialRateLimiter` — `src/utils/serial-rate-limit.ts`; GMGN rate-limit+cooldown pattern in `gmgn-api.ts` |
| DexScreener price | RH DexScreener helper — `src/utils/dlmm/rh-clmm/dexscreener.ts` |
| Workers/Go cron | worker registry — `src/utils/workers/config.ts`, `main.go`, `worker_tracker.go` |
| Block explorer | `https://robinhoodchain.blockscout.com` (already used in `rh-wallet-holdings.ts`) |
| Source (verify) | `wss://robinhoodtrenches.com/ws`, `https://robinhoodtrenches.com/api/*` |

---

## 13. Notes & caveats

- **Data grade:** no SLA/ToS found on the source; treat as research-grade. Cache, mirror, and never block production on it.
- **`priced:'estimate'`** — site may show `~$` sizes when the tx has no cash leg; filter for decision logic.
- **Sim only:** robinhood is uniformly `sim_only` in this repo today. All of this is paper-trading until that changes.
- **House standards to honor:** env-tunable constants, fail-fast (no long sleeps), negative-cache on rate-limit/error, receipt-gating (never call a result final before it settles), WON/LOST status-tinted indicators, full data parity when mirroring lists, and a plain `todo.md`-style execution checklist for the build phases above.
- Verify endpoint shapes again before Phase 1 — external APIs drift (I validated these live on 2026-09-04).
