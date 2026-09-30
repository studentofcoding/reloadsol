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
