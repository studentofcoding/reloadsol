# SPEC — market-brain OHLC + candle patterns v1

**Status:** handoff from Wayfinder decision pack (ready to implement)  
**Map:** [Systematic strategy brain — needs lock](../MAP.md)  
**Decision pack:** [decision-pack.md](decision-pack.md)  
**Phase:** 1 of build order (B OHLC + candle patterns)  
**Date:** 2026-09-20  
**Owner lane:** autotrade & algo  
**Tooling:** Oxc linter, ponytail, graphify (repo-wide standard)

## Goal

Make **market-brain** the **source of truth that serves** per-mint **OHLCV candles** and **deterministic candle-pattern features** for Solana (and RH/0x where GMGN already works), so buy_bulk Freeview / token-chart / episodes / rug-shadow / future principal+adjuster scoring consume one shared feed instead of each path fetching GMGN/SolanaTracker ad hoc.

This is the substrate for end-to-end pattern recognition (principal strategies + adjusters → score → TP/SL). **ML closed loop stays phase 4 on buy_bulk** — this SPEC does not move ONNX train/score to the Worker.

## Non-goals (v1)

- Strategy **correlation / Freeview paint** of outcomes on the chart (stays buy_bulk; phase 2 principal+adjuster)
- **Dynamic TP/SL / auto SL** from score (phase 3 on brain)
- **ML** pattern ONNX train → score → retrain (phase 4 on buy_bulk)
- **List / reporting** polish (phase 5)
- Auto paper smart size/target or **realtrade** (follow-on map)
- Long historical OHLC archive / warehouse (v1 = recent window + cache; no multi-week cold store)
- Replacing terminal BTC `GET /api/candles` (macro climate stays terminal)
- Brain **ranking** or entry decisions (local ranking stays buy_bulk)

## System model (locked)

```
upstream klines (ST / GMGN)
        ↓
market-brain  GET /ohlc  (+ optional /ohlc/patterns)
        ↓
buy_bulk consumers: token-chart, Freeview chart, episodes, ohlc-rug shadow, later adjuster score
```

Principal vs adjuster **combination** is phase 2; this phase only **serves bars + deterministic pattern features**.

## Architecture

```
GET /ohlc?mint=&chain=&interval=&hours=|&from=&to=
  → cache key (KV)
  → miss: fetch upstream (same rules as buy_bulk fetchTokenOhlc)
  → normalize TokenOhlcBar[]
  → optional attach patterns (deterministic)

GET /ohlc/patterns?mint=&…   (or patterns nested on /ohlc?include=patterns)
  → evaluateOhlcRugRules-style features on last N 1m bars
  → return features + hit ids (no ML)
```

**Worker:** existing `market-brain` (`yonathanevanchristy.workers.dev`).  
**Auth:** Bearer `BRAIN_READ_TOKEN` (same as `/snapshot`, `/recipes`, `/regime/params`).  
**Box checkout note:** local `/workspace/market-brain` may lag live Worker (lists-only); implement against live route surface + this SPEC.

## Bar schema (canonical)

Match buy_bulk `TokenOhlcBar`:

```ts
type TokenOhlcBar = {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
```

Response (illustrative):

```ts
type OhlcResponse = {
  mint: string;
  chain: "sol" | "robinhood";
  interval: "1m" | "5m" | "15m" | "1h";
  from: number; // unix sec
  to: number;
  source: string; // e.g. solanatracker | gmgn | cache
  candles: TokenOhlcBar[];
  generatedAt: string; // ISO
  etag?: string;
  patterns?: OhlcPatternSummary; // when include=patterns
};

type OhlcPatternSummary = {
  /** Last ≤10 × 1m bars preferred for rug-shape rules */
  rug: {
    trip: boolean;
    features: {
      n: number;
      dumpPct: number | null;
      avgUpperWick: number | null;
      wickTripBars: number;
      volDeathRatio: number | null;
    };
    hits: Array<{ id: string; label: string; value: number | null; threshold: number; passed: boolean }>;
  };
  /** Optional v1.1: simple shape tags — defer if not cheap */
  tags?: string[];
};
```

Reuse thresholds from buy_bulk `DEFAULT_OHLC_RUG_THRESHOLDS` (`dumpPct` 0.4, `wickRatio` 0.6, `volDeathRatio` 0.25) unless a later ticket changes them. Port the pure functions from `ohlc-rug-rules.ts` (no Next/Redis deps) into the Worker or a tiny shared package — implement choice is PR-local; behavior must match.

## Upstream fetch (locked to current buy_bulk behavior)

Port semantics of `fetchTokenOhlc` in `buy_bulk/src/strategies/token-map-chart.ts`:

| Chain / mint | Upstream | Notes |
|--------------|----------|--------|
| `sol` (base58) | SolanaTracker chart/kline | Primary for Sol |
| `robinhood` or `0x…` | GMGN `token_kline` | ms timestamps → unix sec |

**Interval default:** if omitted, use `ohlcIntervalForHours(hours)` (≤6h → 1m, ≤24h → 5m, else 15m).  
**Hours default:** 24; clamp 1…168.  
**Explicit `from`/`to`:** override hours window (unix seconds).  
**Supported intervals:** `1m`, `5m`, `15m`, `1h` (align `strategy_episodes` check).

Secrets: reuse/add Worker secrets for ST / GMGN as required (do not put keys in buy_bulk for brain path). Document env names in PR.

## Cache

- KV (or DO) key: `ohlc:v1:{chain}:{mint}:{interval}:{from}:{to}` (or hours bucket).  
- TTL: **90s** for the common `24h`/`1m` path (match `OHLC_24H_1M_CACHE_TTL_SEC`); other windows may use 90–180s.  
- On upstream failure with stale cache: return stale + `source` suffix `:stale` if age &lt; 15m; else 502 with empty candles.  
- No stampede lock required in v1 if TTL short; nice-to-have.

## Consumer migration (buy_bulk)

Same implement PR or immediate follow-up PR (prefer same release train):

1. Add brain client helper (Bearer `MARKET_BRAIN_TOKEN`) `fetchBrainOhlc(...)`.
2. `fetchTokenOhlc` / `getCachedTokenOhlc24h1m`: **prefer brain**, fallback to today’s ST/GMGN on brain 5xx/timeout (feature flag `MARKET_BRAIN_OHLC=1` default on when token set).
3. Freeview `TokenMapStrategyChart` keeps calling `/api/strategies/token-chart`; that route uses brain-backed OHLC — **no UI rewrite required** for v1.
4. `ohlc-rug-shadow` / label capture: prefer brain 1m bars when flag on.
5. Do **not** move strategy-presence / correlation markers off buy_bulk in this SPEC.

## API surface

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/ohlc` | Bearer read | Candles (+ optional patterns) |
| GET | `/ohlc/patterns` | Bearer read | Patterns only (same window rules; forces 1m for rug eval when possible) |
| GET | `/health` | public | Already exists — add `ohlc: true` capability bit if cheap |

Query params: `mint` (required), `chain` (`sol`\|`robinhood`, default from mint shape), `interval`, `hours`, `from`, `to`, `include=patterns`.

## Acceptance tests

1. `GET /ohlc?mint=<known sol>&hours=24` → 200, `candles.length > 0`, times ascending, OHLC finite.  
2. Same mint twice within TTL → second hit `source` indicates cache (or identical `etag`).  
3. RH/0x mint → GMGN-backed bars (or skip if no key in CI; document).  
4. `include=patterns` → `patterns.rug` present; trip boolean stable for fixed fixture bars (unit-test ported rules).  
5. buy_bulk with flag on: Freeview chart still renders; brain outage falls back without blanking UI.  
6. Unauthorized → 401.

## Implementation notes

- Prefer pure TS for bar map + rug rules (copy/adapt from buy_bulk; avoid pulling Next/Redis into Worker).  
- Live Worker already has recipes + `/regime/params`; merge OHLC routes without regressing lists.  
- Sync box checkout of market-brain with live before coding if local tree is lists-only.

## Out of scope reminders

- Phase 2: principal foundation + adjuster score (incl. detail correlation).  
- Phase 3: TP/SL + auto SL from combined score.  
- Phase 4: ML closed loop.  
- Phase 5: list polish.  
- Follow-on: auto paper smart size/target → realtrade.

## Open questions → defaults (locked unless Architype overrides)

| # | Question | Default for v1 |
|---|----------|----------------|
| Q1 | Patterns on `/ohlc` vs separate route? | Both: nested via `include=patterns` + dedicated `/ohlc/patterns` |
| Q2 | Shape `tags[]` beyond rug rules? | Defer tags; rug features only |
| Q3 | Multi-chain beyond sol + robinhood? | No |
| Q4 | Historical archive? | No — windowed fetch + short TTL only |
| Q5 | buy_bulk cutover | Prefer brain with fallback; flag gated |

