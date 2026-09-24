# SPEC — OHLC rug spine + Freeview efficiency v1

**Status:** implemented (2026-09-24)  
**Date:** 2026-09-24  
**Related:** [SPEC-brain-ohlc-patterns-v1.md](./SPEC-brain-ohlc-patterns-v1.md) (brain as candle SoT)

## Goal

One spine for how buy_bulk gathers OHLC, evaluates the 10×1m rug trip, and stays useful under GMGN AI-tier rate limits (~0.5 rps).

## Locked model

### Entry tidy (context)

`rug fact → score → size → execute → resolve`. OHLC rug rules are a **reactive short-window filter**, not a predictive rug oracle. Holder concentration / mint-freeze are separate axes.

### Candle vendors

`fetchTokenOhlc`: market-brain (when configured + `MARKET_BRAIN_OHLC` not off) → Solana Tracker (Sol) → GMGN `GET /v1/market/token_kline`. Same OpenAPI as GMGN Agent Skills / `gmgn-cli market kline` — Skills are agent UX, not a second feed.

### OHLC 10/10m trip ([`ohlc-rug-rules.ts`](../src/strategies/ohlc-rug-rules.ts))

Sliding **last ≤10 × 1m** at eval time (not anchored to launch). OR of:

| Rule | Trip when |
|------|-----------|
| `dump_10m` | `(first.c − last.c) / first.c ≥ 40%` |
| `wick_reject` | avg upper-wick ≥ 0.60 and ≥2 ranged bars |
| `volume_death` | `lastVol / mean(earlier) ≤ 0.25` (≥2 vols) |

`n<10` uses whatever bars exist. Freeview label (`system` / `rug` / `potential`) is human; trip badge is live recompute.

### Triggers

- Freeview: `GET /api/gmgn/detect-snapshot` + Strategy correlation `GET /api/strategies/token-chart`
- Concentration ban: `captureDetectSnapshot`
- Shadow (`enforce: false`): signals / mcap / trending entry / GMGN radar pipeline  
- **Not** wired: social `sim-track`, gmgn `sim-track` HTTP open

### Efficiency (priority)

| ID | Lock |
|----|------|
| Gate | Process-wide `gmgnRateGate`; default **0.5 rps** (`GMGN_MAX_REQ_PER_SEC`) |
| A | `hours≤24` Freeview chart uses `getCachedTokenOhlc24h1m` |
| B | Soft TTL **10m**; last-good key; on fail/429 return `*-stale` |
| C | Prefer brain/ST so GMGN kline is rare; ops: ensure `MARKET_BRAIN_TOKEN` + ST host |
| D | Empty live → detect-snapshot bars → signal_ohlc_labels before flat axis |
| E | No extra chart bypass of the shared cache |
| F | Later: single-flight `ohlc:inflight:{mint}`; optional last-15m rug window |
| G | **Redis GMGN extend**: merge GMGN into Redis (24h trim); skip GMGN when span already ~24h; brain/ST still full-replace |
| H | **Chart paint**: gray = Redis extended; amber = frozen Postgres `detectCandles` (separate layers) |

### Redis extend vs Postgres (G/H)

- **Postgres** (`token_detect_snapshots` / labels): unchanged point-in-time capture — not extended by GMGN merge.
- **Redis** (`ohlc:v1:24h1m:*`): chart series; GMGN results **merge** (union by time, trim to last 24h). When Redis already spans ~24h, **do not** call GMGN again.
- **Strategy correlation**: paints Redis as gray “extended” and detect-snapshot bars as amber “detect”.

### Out of scope v1

Hard `enforce: true`, Redis cross-replica GMGN limiter, weight-aware per-route spacing, changing dump/wick/vol thresholds.

## Ops checklist (C)

1. `MARKET_BRAIN_TOKEN` set → brain OHLC default on (`MARKET_BRAIN_OHLC=0` forces ST/GMGN).
2. Solana Tracker secure host / key so Sol mints rarely need GMGN kline.
3. Unset or set `GMGN_MAX_REQ_PER_SEC=0.5` on VPS (code default is 0.5; an env of `5` overrides and can 429).
4. IPv4 only for GMGN (IPv6 → 401/403).
