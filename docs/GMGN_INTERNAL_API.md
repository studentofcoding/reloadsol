# GMGN internal web API — reverse-engineered inventory

**Recorded:** 2026-09-30 · **Method:** opened `https://gmgn.ai/sol/token/<mint>` in a real Chrome
(puppeteer + system Chrome, `--disable-blink-features=AutomationControlled`) and recorded every
network call.

## Auth reality (do not re-litigate)

**The internal API is not public.** Every path returns **Cloudflare 403** to any non-browser client —
`curl` with a browser UA + referer, from this machine *and* from the VPS. Only a real browser clears
the challenge (`POST /api/<id>/envelope/` + `challenges.cloudflare.com` were in the trace).

The **only** server-side route is our own [`workers/gmgn-web-proxy`](../workers/gmgn-web-proxy/README.md)
Cloudflare Worker, whose allow-list is exactly three prefixes:

```
/mrwapi/   /api/v1/   /vas/api/
```

Anything outside those (`/defi/...`, `/pf/...`) answers `{"error":"path not allowed"}` from the Worker.
Query noise the app sends (`device_id`, `tab_id`, `client_id`, `from_app`, `app_ver`, `tz_name`,
`tz_offset`) is **telemetry** — Worker calls succeed without it.

## Recorded calls (token page, 31 total, all 200)

**`/mrwapi/`**
- `POST /mrwapi/v1/multi_token_full_info` — batch `{chain, addresses[]}` (≤8). **Our primary**
  (`src/utils/gmgn-web-multi.ts`), flat fields.
- `POST /mrwapi/v1/multi_token_info` — the app's own batch token info.
- `GET  /mrwapi/v1/timestamp`

**`/api/v1/`**
- `POST /api/v1/mutil_window_token_info` — batch window stats (our secondary).
- `POST /api/v1/meme_quote_info` — batch `{chain, addresses[]}` → `liquidity`, `is_honeypot`, `is_safe`.
- `POST /api/v1/logo/logo_dup_detail` — duplicate-logo count (reused-logo rug signal).
- `POST /api/v1/major_coin_prices` — BTC/SOL/BNB/ETH.
- `GET  /api/v1/token_stat/sol/{mint}` — rat/bundler/entrapment/bot-degen %, `private_vault_hold_rate`,
  `creator_created_count`, `top_10_holder_rate`, `dev_team_hold_rate`, `top70_sniper_hold_rate`.
- `GET  /api/v1/token_mcap_candles/sol/{mint}?resolution=1m|5m|1h` — **OHLCV candles**
  (`time` ms, `open/high/low/close/volume`). `resolution` is **required** (omit → `P_GMGN_IN_INVALID_ARGUMENT`).
- `GET  /api/v1/token_fee_info/sol/{mint}` · `GET /api/v1/token_pool_fee_info/sol/{mint}` — per-pool
  `liquidity`, `fee_ratio`, `pool_type`.
- `GET  /api/v1/tokens/top_buyers/sol/{mint}` — holder disposition (`sold`, `hold`, `smart_pos`).
- `GET  /api/v1/recommend_slippage/sol/{mint}` — slippage, `has_tax`, `volatility`.
- `GET  /api/v1/launchpad_platform_tax_policy/sol` · `GET /api/v1/token/sol/{mint}/community/messages`
- `GET  /api/v1/dex_trades_polling` · `GET /api/v1/gas_price_list` · `GET /api/v1/live/twitch_kol`
  · `GET /api/v1/activity/s12/my_rank_info`

**`/vas/api/`**
- `GET /vas/api/v1/token_holder_stat/sol/{mint}` — smart/renowned/insider/dev/bundler/sniper counts.
- `GET /vas/api/v1/token_holders/sol/{mint}` · `GET /vas/api/v1/token_trades/sol/{mint}`
  · `GET /vas/api/mul-region/token_trades_v2/sol/{mint}` · `GET /vas/api/v1/agged_token_transfers/sol`
  · `GET /vas/api/v1/similar_coin`
- `POST /vas/api/v1/batch_handler` — **internal multiplexer** (`{api_list:[…]}` fans out N internal
  GETs in one request; the app used it for `.../agged_token_trades?period=1m&tag=dev_team`).

**Outside the allow-list**
- `GET /defi/quotation/v1/smartmoney/sol/wallet/{wallet}` — creator/wallet profile (balances, twitter, tags).
- `GET /pf/api/v1/fomo/thesis/token` — FOMO thesis.

## Server-side verified matrix (through our Worker, **no browser**)

| Endpoint | Result |
|---|---|
| `GET /api/v1/token_mcap_candles/sol/{m}?resolution=1m` | ✅ **200** — real OHLCV |
| `POST /api/v1/meme_quote_info` (2 mints) | ✅ **200** — `is_honeypot`/`is_safe`/`liquidity` per mint |
| `GET /api/v1/token_stat/sol/{m}` | ✅ **200** |
| `GET /vas/api/v1/token_holder_stat/sol/{m}` | ✅ **200** |
| `GET /api/v1/recommend_slippage/sol/{m}` | ✅ **200** |
| `POST /vas/api/v1/batch_handler` | ❌ `403 Endpoint not allowed` (browser-only) |
| `GET /defi/...`, `GET /pf/...` | ❌ not on the Worker allow-list |

## What we use it for

- `src/utils/gmgn-web-multi.ts` — batch token info/security (`multi_token_full_info` + window + holder stat), the `GMGN_TOKEN_INFO_SOURCE=web` path.
- `src/utils/gmgn-web-extra.ts` — the extra endpoints: `fetchGmgnWebCandles` (OHLC fallback in
  `src/strategies/token-map-chart.ts`, source label `gmgn-web`), `fetchGmgnWebSafety` (batch
  `is_honeypot`/`is_safe`), `fetchGmgnWebTokenStat` (the percentages). Both feed the shadow risk row
  (`token_risk_features`, shadow-only).

## Caveats

Unofficial and **Cloudflare-tunnelled by our own Worker**: GMGN can rename a path or tighten the
challenge at any time. Every call is **fail-soft** (`null`/`[]`), shares the existing
`GMGN_WEB_MAX_POST_PER_SEC` gate, and parks on a 403/429. Never the critical path — keep the
official `openapi.gmgn.ai` client as the fallback.

---

## Volume inventory — what actually carries traded volume, and what it costs

**Recorded:** 2026-10-01 · **Method:** same recipe (puppeteer + system Chrome,
`--disable-blink-features=AutomationControlled`), trenches page then
`https://gmgn.ai/sol/token/<mint>`; 29 distinct paths captured. Every candidate then re-tested
**server-side through our own Worker** to separate usable from browser-only.

### The candle call (the only per-minute volume we can get)

`GET /api/v1/token_mcap_candles/sol/{mint}` — the app's own call shape is
`?resolution=1m&limit=501&pool_type=tpool` (so `resolution` **is** required, and `limit` allows up
to ~501 bars ≈ 8.3 h of 1m). Payload: `data.list[]` with
`{time (ms), open, close, high, low, volume, source, amount}` — numbers arrive as **strings**, and
`amount` is the token-unit volume. Measured ~18.7 KB for 120 bars (≈155 B/bar).
**Verified through the Worker: 200, real volume** (`"volume":"15.17204669"`).

### Everything else, ranked by cost

| Endpoint | Batched? | Volume? | Granularity | Verdict for the backbone |
|---|---|---|---|---|
| `GET /api/v1/token_mcap_candles/sol/{mint}` | ❌ 1 call/token | ✅ `volume` + `amount` | **per candle (1m/5m/1h)** | the only per-minute source |
| `POST /vas/api/v1/batch_handler` | ✅ fans out N sub-requests | — | — | ❌ **`403 Endpoint not allowed`** for candle sub-requests — the multiplexer has its own allow-list and candles are not on it (re-confirmed 2026-10-01) |
| `POST /api/v1/mutil_window_token_info` | ✅ `{chain, addresses[]}` | ❌ | — | gives liquidity / holder_count / price / dev / pool — **no volume field at all** |
| `POST /mrwapi/v1/multi_token_full_info` · `multi_token_info` | ✅ (≤8/call) | ❌ | — | our primary info path; no volume |
| `GET /api/v1/dex_trades_polling` | ✅ one call | ✅ but **global** | market-wide | `data.allAggregationResult` = whole-SOL-market `tradeVolume`/`buyVolume`/`sellVolume`/`tradeCount`; **not per token** |
| `GET /vas/api/mul-region/token_trades_v2/sol/{mint}` | ❌ | ✅ per trade | trade-level (52 KB) | per-token, heavy; would need aggregation |
| `GET /vas/api/v1/token_trades/sol/{mint}` | ❌ | ✅ per trade | trade-level | same |
| `GET /api/v1/token_holders/sol/{mint}` | ❌ | `buy_volume_cur`/`sell_volume_cur` per wallet | per holder | wallet-level, not token-minute |
| `GET /api/v1/market/rank` (OpenAPI, not web) | ✅ paged | ✅ `volume`/`swaps`/`buys`/`sells` | **queried interval (1h)** | cheap per-token volume, but 1h — too coarse for a 1m series |

### Cost model (why there is no cheap path)

Per-minute volume is **one call per token** — that is the whole finding. `batch_handler` would have
changed that and it is closed; the batched endpoints that *do* work carry no volume, and the ones
that carry volume in bulk are interval aggregates.

At the current gate `GMGN_WEB_MAX_POST_PER_SEC=0.4`:

| Sweep | Calls | Wall clock |
|---|---|---|
| 300 mints (the sampler watch-set cap) @ 0.4 rps | 300 | **≈ 12.5 min** |
| 300 mints via **Solana Tracker** @ `SOLANATRACKER_OHLC_RPS=3` (if credits restored) | 300 | **≈ 100 s** |
| 60 mints @ 0.4 rps (reduced copy set) | 60 | ≈ 2.5 min |

So the metric backbone's 1m volume should be filled from the **cheap lane that already exists**
(Solana Tracker, keyless secure host, 3 rps) — GMGN's candle endpoint alone cannot sweep the watch
set without eating the budget live trading uses. See `SPEC-rug-pattern-data-v1` §G1 and
`~/.commandcode/plans/token-metrics-backbone.md`.
