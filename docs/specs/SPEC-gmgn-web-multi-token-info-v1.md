# SPEC — GMGN public web multi-token info v1

**Status:** client shipped behind a flag (default OpenAPI). Ledger table is a follow-on.  
**Date:** 2026-09-27  
**Related:** [PR #91](https://github.com/studentofcoding/reloadsol/pull/91) `docs/specs/SPEC-token-info-universal-ledger-v1.md` (not on `main` yet — immutable Token Info ledger). When that SPEC lands, capture SoT is this client while `GMGN_TOKEN_INFO_SOURCE=web`.

## Goal

Read Freeview's nine Token Info tiles from gmgn.ai's **public website** batch endpoints (no API key, no login), with a hard batch cap of **8** and traffic controls that keep ledger capture and Freeview off a tight retry loop.

OpenAPI (`src/utils/gmgn-api.ts`) stays the client for signed and keyed routes: trades, search, rank, smart-money, kline. This module does not replace those.

Default remains OpenAPI until an operator sets the flag.

## Locked decisions

| Lock | Value |
|------|--------|
| Source flag | `GMGN_TOKEN_INFO_SOURCE=web` or `openapi`. Unset and any other value = **openapi** |
| Chains | Web multi is **sol** only. `robinhood` stays OpenAPI even when the flag is `web` |
| Batch cap | **8** addresses per POST. Env `GMGN_WEB_MULTI_MAX_BATCH` clamps to 1–8. Never 9 or 10 |
| Why 8 | Observed server cap is 10. **11 → HTTP 400** `invalid argument`. 8 leaves headroom |
| Rate | Separate process gate from OpenAPI. Default **0.4 POST/sec** (`GMGN_WEB_MAX_POST_PER_SEC`). Serial queue, no parallel stampede |
| Live cache | Redis (memory fallback) **10–30s**, default 20s, key `gmgn:web-multi:sol:{mint}` (case-sensitive). Freeview snapshot key stays `gmgn:token-snapshot:…` at 10s |
| Ledger skip | Interim key `gmgn:web-ledger-seen:sol:{mint}` until `token_info_detect` exists. Ledger queue skips a mint already marked. Live Freeview does **not** skip |
| Negative cache | 429 and 403 / Cloudflare HTML challenge: cooldown **30–120s** (default 60). Fail that call. No tight retry |
| Holder stat | GET only when a sniper count is required and full_info did not include one |
| Hard ban | Unchanged. `CONCENTRATION_BAN_PCT` = **65** on the **live** snapshot (Top 10 / Dev / Bundlers). Web-mapped rows feed that same function when the flag is on |
| Fingerprint | `Accept`, `Content-Type`, `Origin`, `Referer` only. No cookie jar, no device id, no fake User-Agent |

## Endpoints (public, unofficial)

Host `https://gmgn.ai` (override `GMGN_WEB_HOST`). On production (Singapore VPS) set `GMGN_WEB_HOST` to the `gmgn-web-proxy` Worker URL and `GMGN_WEB_PROXY_SECRET` to the Worker secret — direct VPS egress gets Cloudflare 403. Body for both POSTs: `{"chain":"sol","addresses":["<mint>",...]}`.

| Call | Path | Used for |
|------|------|----------|
| POST | `/mrwapi/v1/multi_token_full_info` | Top 10, creator/dev, sniper %, bundler %, bot degen, mint/freeze renounced, burn |
| POST | `/api/v1/mutil_window_token_info` | Window price + `dev.dexscr_boost_fee` / `dev.dexscr_boost_ts` |
| GET | `/vas/api/v1/token_holder_stat/sol/{mint}` | Sniper / insider / bundler **counts**, only when the sniper count is missing |

Rows are adapted to `{ info, security }` and passed through the existing `buildGmgnTokenSnapshot`. Tile percents stay 0–100. Freeze/Mint auth stays "active when not renounced".

These routes are unofficial. A Cloudflare challenge or a shape change should fail soft (cooldown or empty panel), not spin.

Light check on 2026-09-27: VPS / SIN egress POST receives **HTTP 403** Cloudflare HTML (`Attention Required`); US colo (PDX/LAX) and the `workers/gmgn-web-proxy` Durable Object (`locationHint: wnam`) receive **200**. The client treats 403 as `BLOCKED` and cools down. Do not add a browser or Playwright dependency. Production uses the Worker proxy (see `workers/gmgn-web-proxy/README.md`).

## Anti-spam

All of these are in `src/utils/gmgn-web-multi.ts`:

1. **Own serial gate**, not the OpenAPI `GMGN_MAX_REQ_PER_SEC` gate. Web and OpenAPI do not share a token bucket. Holder-stat GETs use the same web gate so they cannot run beside a POST.
2. **Jitter** on top of the gap (about 15%, capped at 250ms). A tiny configured gap (tests) adds none. 5xx backoff is exponential, capped at 2s, **one** retry. 429 / 403 / challenge: **zero** retries.
3. **In-flight coalesce.** A second caller for a mint that already has a request in flight waits on that promise. An overlapping set fetches only the mints that are not already in flight.
4. **Positive cache** for live reads (10–30s).
5. **Ledger write-once skip.** `enqueueGmgnWebLedgerMints` debounces **200–500ms** (default 350) and flushes unique mints in chunks of ≤8. `markGmgnWebLedgerCaptured` after a future insert wins. `ledgerWriteOnce` then skips that mint. The interim store is Redis TTL 30 days, not Postgres.
6. **Negative cache** in process memory and Redis key `gmgn:web-multi:negative`.
7. **Metrics.** `getGmgnWebMultiMetrics()` counts upstream calls, addresses sent, last batch size, 429s, 403s, cache hits, coalesced joins, negative skips, ledger skips. Each upstream call logs one `[gmgn-web-multi]` line.

Invalid mints are dropped before the POST so one bad address cannot 400 the batch. A genuine HTTP 400 is `INVALID` and does **not** open the cooldown.

## How to enable

```bash
# default — leave unset
# GMGN_TOKEN_INFO_SOURCE=openapi

# Freeview + getGmgnTokenSnapshotCached on sol use the public web client
GMGN_TOKEN_INFO_SOURCE=web

# optional tuning
GMGN_WEB_MULTI_MAX_BATCH=8          # clamped ≤ 8
GMGN_WEB_MAX_POST_PER_SEC=0.4       # separate from GMGN_MAX_REQ_PER_SEC
GMGN_WEB_POSITIVE_TTL_S=20          # clamped 10–30
GMGN_WEB_NEGATIVE_COOLDOWN_S=60     # clamped 30–120
GMGN_WEB_LEDGER_DEBOUNCE_MS=350     # clamped 200–500
GMGN_WEB_HOST=https://gmgn.ai
# Production (flowey-vps): route through CF Worker DO in wnam — direct VPS→gmgn is 403
# GMGN_WEB_HOST=https://gmgn-web-proxy.yonathanevanchristy.workers.dev
# GMGN_WEB_PROXY_SECRET=...
```

`GET /api/gmgn/token-snapshot` on sol does **not** require `GMGN_API_KEY` when the flag is `web`. Robinhood and OpenAPI mode still require the key. The route still runs `evaluateConcentrationBan` on the live panel. The 65% threshold is not part of this flag.

## What this PR does not do

`token_info_detect` is not on `main` (SPEC PR #91 is docs-only and not merged). This PR does **not** add `db/init/41-token-info-detect.sql` or strategy capture seams.

Follow-on, after that SPEC is on `main`:

1. Migration + write-once insert (`ON CONFLICT DO NOTHING`).
2. At each Sol detect seam, `enqueueGmgnWebLedgerMints([mint])` when the flag is `web` (OpenAPI snapshot when it is not).
3. `markGmgnWebLedgerCaptured(mint)` only after the insert wins.
4. `hasGmgnWebLedgerCapture` should also `SELECT` `token_info_detect`, and the interim Redis key can retire.
5. Hard ban keeps using the live snapshot already in hand. It does not read the ledger.

Until then, `enqueueGmgnWebLedgerMints` / `markGmgnWebLedgerCaptured` are the capture API. Nothing in the strategy loop calls them yet.

## Files

| File | Role |
|------|------|
| `src/utils/gmgn-web-multi.ts` | Client, gate, caches, ledger debounce |
| `workers/gmgn-web-proxy/` | CF Worker + wnam Durable Object reverse proxy |
| `src/utils/gmgn-web-multi.fixtures.ts` | Minimal observed field names for tests |
| `src/utils/gmgn-web-multi.test.ts` | Chunk, dedupe, coalesce, caches, tile map |
| `src/utils/gmgn-snapshot-cache.ts` | Flag switches the live panel source |
| `src/app/api/gmgn/token-snapshot/route.ts` | Sol + `web` does not require an API key |

OpenAPI trade, search, and rank callers are unchanged.
