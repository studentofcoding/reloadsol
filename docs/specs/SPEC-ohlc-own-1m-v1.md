# SPEC — Own 1m OHLC series + honest chart fetch v1

**Status:** implementing (2026-09-25)
**Date:** 2026-09-25
**Surface:** `reloadsol` Freeview Strategy correlation chart — `src/strategies/token-map-chart.ts`, `src/app/api/ohlc/sample/route.ts`, `token_ohlc_bars`, `ohlc_sampler` worker
**Lane:** autotrade & algo
**Depends on:** `token_ohlc_bars` (adopted), `signal_ohlc_labels` / `token_detect_snapshots` (seed only), Jupiter Price V3 via `getUsdPrices`
**Provenance:** `/ask` + `/debug` investigation 2026-09-25 (see `docs/specs/SPEC-trending-gmgn-feed-reentry-guard-v1.md` for the sibling trending work).

No new external dependency: the series is built from our own code and prices. GeckoTerminal and
DexScreener-for-data are deliberately out of scope (see §7).

---

## 1. Goal

Give every charted mint a real price axis even when every upstream OHLC source is down, and stop
the fetch path from wasting its budget.

## 2. As-built / evidence (measured 2026-09-25)

- Cold chart route for a candidate mint: **22.035 s**, `candles 0`,
  `ohlcSource: signal-ohlc-labels-stale-timeout` — i.e. exactly
  `TOKEN_MAP_CHART_OHLC_BUDGET_MS = 22_000`.
- Chain: brain `/ohlc` **502** (`{"error":"solanatracker empty | gmgn empty"}`, 0.70 s) →
  SolanaTracker **403 account-wide** (`Insufficient credits`, 3/3 mints, key *is* set) →
  GMGN 24 h×1 m = **16 paged calls × ~2 s gate ≈ 32 s** ⇒ over budget.
- `window=auto` ignored its own resolved window (6.9 h) and asked for the **24 h canonical** series
  (3.6× the data) before an after-the-fact windowed retry.
- `token_ohlc_bars`: **0 rows**, zero `src/` readers/writers, no `volume` column — dead scaffolding.
- No price sampler existed (28 registered workers, none matching `ohlc|price|sample|candle`).
- **No 1-minute volume exists in our stack**: Jupiter Price V3 has none, `volume_5m` columns and
  Jupiter `stats5m` are 5-minute windows, DexScreener exposes `h24` only.

## 3. Locked decisions

| Decision | Lock |
|---|---|
| Store | Adopt the existing `token_ohlc_bars` (don't add a table, don't drop it) |
| Cadence | `OHLC_SAMPLE_INTERVAL=15` s → 4 samples/minute so a real intra-minute high/low exists |
| Watch set | mcap candidates in the 30k–2M band + `trending_token_tracker` rows + mints with a sim buy in the last 24 h; capped by `OHLC_SAMPLE_MAX_MINTS` (default 300); **sol only** (pricing is Jupiter) |
| Prices | `getUsdPrices` (Jupiter Price V3, 50 mints/call, shared 5 RPS gate) — never per-mint GMGN |
| Volume | **NULL by design** for sampler bars; only the seed carries `v` |
| Source order | live upstream (brain → ST → GMGN) → **own 1m series** → storage fallback (labels/detect) → no fake axis |
| Chart honesty | never draw the synthetic flat placeholder over an upstream timeout; name the failure |
| Window | `window=auto` (and any span < 20 h) fetches exactly its own span; only a ~24 h window uses the canonical series |

## 4. Data model (`db/init/39-token-ohlc-bars-own-series.sql`)

Adds `volume NUMERIC`, `source TEXT NOT NULL DEFAULT 'sampler'`,
`samples INTEGER NOT NULL DEFAULT 1`, plus `idx_token_ohlc_retention (timestamp)`.
The pre-existing `UNIQUE (token_address, interval, timestamp)` is what makes the per-minute
upsert idempotent.

## 5. Sampler (`POST /api/ohlc/sample`, worker `ohlc_sampler`)

One batched read → one batched write per tick:

```sql
INSERT INTO token_ohlc_bars (token_address, interval, open, high, low, close, timestamp, source, samples)
SELECT m, '1m', p, p, p, p, date_trunc('minute', now()), 'sampler', 1
  FROM unnest($1::text[], $2::float8[]) AS u(m, p)
ON CONFLICT (token_address, interval, timestamp) DO UPDATE SET
  high    = GREATEST(token_ohlc_bars.high, EXCLUDED.high),
  low     = LEAST(token_ohlc_bars.low, EXCLUDED.low),
  close   = EXCLUDED.close,
  samples = token_ohlc_bars.samples + 1;
```

`open` is never overwritten (first sample of the minute wins). Retention prunes rows older than
`OHLC_BARS_RETENTION_HOURS` (default 48) in the same tick. Auth = `?key=` / `Bearer`
`TRENDING_TRACKER_SECRET`; a job lock returns **409** so a slow tick skips instead of stacking.

**Seed** (`scripts/seed-ohlc-bars.ts`, `npm run ohlc:seed-bars`) copies the 1 m bar sets we already
own — `signal_ohlc_labels.bars` (~21.8 k rows) and `token_detect_snapshots.bars` (~2.5 k) — with
their own `v` → `volume` and `source='seed:…'`, `ON CONFLICT DO NOTHING`. This is what stops the
chart being flat on day 1 for mints we have already labelled.

## 6. Verification

- Units: window-first bar size, GMGN paging deadline + consecutive-empty bail (+ keeps bars on a
  mid-walk error) — `src/strategies/token-map-chart-paging.test.ts`; existing window-load tests
  still pass.
- Gate: `npm run lint` && `npm run verify:no-raw-useeffect` && `npm run build` && `npm run start`.
- Live: apply migration 39 → trigger `/trigger/ohlc-sampler` → rows land with `samples ≥ 2` after a
  minute; chart API for the mints that used to time out returns `ohlcSource: 'own-1m'`.
- Seed: `npm run ohlc:seed-bars -- --dry-run` then a real run.

## 7. Non-goals

- **GeckoTerminal / CoinGecko paid tiers** — deferred. Measured: GT is fast and fresh (a 6.9 h@1m
  window in one 3.9 s call) but its demo tier 429s after ~8 calls with no rate-limit headers, and
  commercial use needs a paid plan (Basic $29–35/mo).
- **DexScreener as an OHLC source** — it has none: 13 documented endpoints, no candles; the pair
  schema is scalar-only; the WebSocket API mirrors the listing streams (no trade feed); the internal
  `io.dexscreener.com/dex/chart/...` host is Cloudflare-403 even with browser headers. It stays our
  pair/price/volume source.
- **Backfilling 1 m volume** — not obtainable from any source we have.
- **The 24 h canonical Redis series** behind Telegram CLOSE charts and `signal_ohlc_labels` — still
  degraded until SolanaTracker credits are topped up. That is **ops**, not code; this SPEC makes the
  *chart* independent of it, not the Telegram path.

## 8. Open items

1. **Volume enrichment** — if a per-minute volume source ever appears (e.g. a trades feed), backfill
   `volume`; today the chart's volume pane is sparse for `own-1m` bars.
2. **Robinhood coverage** — the sampler is sol-only because pricing is Jupiter; RH mints still rely
   on GMGN/DexScreener.
3. **Open-position set** — v1 uses "a sim buy in the last 24 h" as a cheap proxy rather than
   reconstructing open cycles every 15 s; revisit if it misses real opens.
4. **Cold start** — forward-only; a mint sampled for the first time today has no earlier axis.

## 9. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-25 | Store | Adopt `token_ohlc_bars` (+ volume/source/samples), keep the unique key |
| 2026-09-25 | Cadence | 15 s → real 1 m OHLC |
| 2026-09-25 | Watch set | Candidates + tracked + recent sim buys, capped, sol only |
| 2026-09-25 | Volume | NULL by design; seed carries `v` |
| 2026-09-25 | Source order | upstream → own-1m → label/detect fallback → no fake axis |
| 2026-09-25 | Dependency | Own code only; GT/DexScreener deferred |

## 10. Related docs

- Trending/feed + re-entry guard: [SPEC-trending-gmgn-feed-reentry-guard-v1.md](./SPEC-trending-gmgn-feed-reentry-guard-v1.md)
- Architecture / workers / tables: [../architecture.md](../architecture.md), [../03-strategies-and-automation.md](../03-strategies-and-automation.md)
