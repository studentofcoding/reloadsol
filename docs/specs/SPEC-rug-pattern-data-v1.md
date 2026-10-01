# SPEC — Rug-pattern data + backtest v1

**Status:** to-spec (docs only — no code changed)
**Date:** 2026-10-01
**Depends on:** [SPEC-rug-signal-v1.md](./SPEC-rug-signal-v1.md) (the score itself), [SPEC-strategy-data-pipeline-v1.md](./SPEC-strategy-data-pipeline-v1.md) (the metric series this needs)
**Related:** [SPEC-ohlc-own-1m-v1.md](./SPEC-ohlc-own-1m-v1.md) (own 1m series + sampler)

## Goal

Make the staircase / manufactured-ramp pattern **collectable, backtestable and calibratable** on real pre-dump windows, and make its inputs usable as an ML pattern feature.

**Non-goals.** Not changing the score's shape or weights; not enforcing anything (this pass is collection + measurement); not touching the reactive OHLC spine's rules.

## Evidence — why this SPEC exists (measured 2026-10-01, read-only)

| # | Finding | Measurement |
|---|---|---|
| 1 | The score's parameters are **unvalidated** | `SPEC-rug-signal-v1` §Calibration: the band anchors did not separate rug from rising on the corpus; the weights/threshold came from a human. |
| 2 | **No backtest is possible today** | The only volume-bearing windows are 10×1m cards *anchored at the label event* — a rug card's window **ends in the dump**, so it cannot represent a live pre-dump ramp. |
| 3 | The long series has **no volume** | `token_ohlc_bars`: 875,512 rows, Sep 29 → Oct 1, `volume IS NULL` on **875,535 / 875,535** rows. |
| 4 | There is **no mcap or liquidity history** | `token_risk_features`: 1,127 rows, 2 days, upsert (latest only). `token_mcap_tracking`: latest only + milestone timestamps. |
| 5 | The one usable signal **test was refuted** | Absolute thinness tracks *flat*, not risky (turnover p50: crash 0.70 · loss 0.34 · flat 0.24 · win<100% 0.44 · win≥100% 0.75). |

## The five gaps and their fixes

### G1 — Volume in our 1m series
`POST /api/ohlc/sample` (`src/app/api/ohlc/sample/route.ts:81`) upserts a Jupiter **spot price** into `open/high/low/close` and never writes `volume` (the column exists since `db/init/39-token-ohlc-bars-own-series.sql`).

**CORRECTED (2026-10-01, measured).** The original claim here — *"no source in our stack exposes volume"* — was **wrong**, and so was the sampler's own comment (`ohlc/sample/route.ts:14-16`). Per-candle volume is already **fetched, parsed and cached** from four sources we call today:

| Source | Where the volume is read |
|---|---|
| market-brain `GET /ohlc` | `src/utils/market-brain.ts:434,521` — `BrainOhlcBar.volume` (`volume` or `v`) |
| Solana Tracker `/chart/{token}` | `src/strategies/token-map-chart.ts:291` — `mapStBars` reads `r.volume` |
| GMGN `/v1/market/token_kline` | `src/strategies/token-map-chart.ts:340` — `r.volume ?? r.v` |
| GMGN web `/api/v1/token_mcap_candles` | `src/utils/gmgn-web-extra.ts:183` — `row.volume` → `GmgnWebCandle.v` |

Live proof: `ohlc:v1:24h1m:last:4DnRgzbu…` in Redis holds `{"close":11000.2129,"volume":5143.55684952}, …`. The **read path is already wired** (`loadOwnOhlcBars` SELECTs and maps `volume`, `token-map-chart.ts:884,909`).

**The drop point is one statement:** the 15s sampler's UPSERT (`src/app/api/ohlc/sample/route.ts:81-92`) omits the `volume` column and only ever has a Jupiter *spot price* in scope.

**Fix (as built, 2026-10-01):** persist the volume we already receive into `token_metrics_history` (§G2). **Storage granularity is 1 minute, not 5** — 5m is *derivable* from 1m and is a lossy dead end, while the existing rules already consume 1m (`ohlc-rug-rules` is ≤10×1m, `volume_death` is a 1m rule). 5m is computed on read by `derive5mVolume`, which returns a volume only when all five of its minutes were observed — mirroring `aggregateTo5m` in `rug-signal.ts` and pinned by a 300-trial differential test.

Two writers, cheapest first:
1. **`metrics_copier`** (`POST /api/metrics/copy`, worker `metrics_copier`, every 15 min) — the filler. Reads the 24h 1m candle cache for free, then makes **one paced GMGN-web call per remaining watch mint** on its own rate lane, writes real candles (`gmgn_web` / `cache_copy`).
2. The trending route (`POST /api/trending`) stamps the current-hour **snapshot** (`mcap_close` / `price_close`), structurally unable to touch `vol_min` — a rolling-window reading is not a per-minute candle (E15).

**Consequence if skipped:** the 30-point volume band is inert on the own-1m path and a ramp caps at 40 + 20 = 60 < 80 — it can never trip.

**Density finding (measured 2026-10-01) — read this before trusting the 5m series.** GMGN's 1m endpoint returns **only minutes that traded**, so completeness is a function of token activity, not of our cadence:

| Population (hottest 4 mints by 7d buy count) | bars | wall span | newest hour filled | last 8 hours fully complete |
|---|---|---|---|---|
| 1 | 501 | 502 min | 36/60 | **5/8** |
| 2 | 501 | 500 min | 36/60 | **7/8** |
| 3 | 501 | 834 min | 23/60 | 0/8 |
| 4 | 501 | 1115 min | 3/60 | 0/8 |

For genuinely active tokens the series is effectively **one bar per minute** (501 bars over ~500 min) and past hours come out complete — which is the rug scorer's target population, since a token in a staircase is trading continuously. Quiet tokens leave most minutes absent, so their 5m buckets derive NULL.

**The same property, taken to its extreme (found on prod, first sweep 2026-10-01):** a *barely*-traded token's last 501 traded minutes span **years**, so the writer received bars stamped 2024 and created 1,438 rows outside the window (205 hours across 6 tokens in 2024, 702 across 8 in 2025). They were idempotent, invisible to any range-bounded read, and self-clearing under the 30-day prune — but they skewed the series' reported span, so the copier now clips each lane to its own reach (copy lane `limit × resolution`; cache lane its 24 h TTL) before writing.

**Open semantic choice, not changed here:** an absent minute inside a fetched window is read as **NULL = not observed** (the locked invariant). For a quiet token it could equally be read as **0 volume = no trades**. That would make more of the series usable but would weaken the one rule that keeps "we didn't look" distinct from "nothing happened" — so it stays NULL until deliberately decided.

### G2 — A durable per-token metric series
No table stores a per-token mcap/liquidity series. `token_mcap_tracking` is one overwritten row; `token_risk_features` is one overwritten row.

**Fix (as built, 2026-10-01):** `token_metrics_history` — **one row per (token, chain, UTC hour) carrying five one-minute arrays** (`db/init/54-token-metrics-history.sql` + `db/init/55-token-metrics-ohlcv.sql`), written by `src/strategies/token-metrics-history.ts`:

```
token_address, chain, hour_bucket,
vol_min float8[60], o_min float8[60], h_min float8[60], l_min float8[60], c_min float8[60],
mcap_close, liquidity_close, price_close, holders, sources text[], updated_at
-- PK (token_address, chain, hour_bucket); slot i = minute (i-1); NULL = NOT OBSERVED
```

**The full 1m candle, not just the volume.** 54 stored volume alone because that is what the scorer's band needed; the vendor actually returns complete OHLCV per bar and the fetch already parsed open/high/low/close — the writer was discarding them. 55 keeps them, so one row now carries the whole candle and no join is needed. The four price arrays are **per-minute**; the `*_close` columns are **end-of-hour snapshots** of different quantities (market cap, pool liquidity) and must never be read as per-minute. First-writer-wins applies **per field**, so an absent incoming price never erases a stored one.

The hour-array shape was chosen on **measured** byte costs (prod, 2026-10-01): `float8[60]` = 504 B vs `numeric[60]` 744 B vs jsonb array 968 B vs jsonb object 1,320 B; an all-NULL `float8[60]` is 32 B. A row-per-minute would be 440k rows/day → 4.6–8.7 GB per 30 days against 11 GB free disk, and its index could never stay resident in a 256 MB `shared_buffers` (existing indexes already total 817 MB). Per-token window reads touch ~2 rows instead of ~100. Carrying all five arrays costs ~2.5 KB/row when full (~0.5 GB per 30 days at 300 tokens × 720 h) against 11 GB free; `ADD COLUMN` with a NULL default does not rewrite the table, so 55 applies instantly on a live database.

Coverage is **derived, never stored**: `count(x) FROM unnest(vol_min)`. `slots_filled` was deliberately dropped mid-build — it would duplicate that expression, and `array_remove(v, NULL)` does not actually remove NULLs.

Writers are one atomic statement per (token, hour): slots fill with `COALESCE(vol_min[slot], value)`, so the **first writer to supply a minute wins** and a duplicate write is a no-op. Retention `TOKEN_METRICS_RETENTION_DAYS`, default **30**. `sources` records provenance per row (`gmgn_web` / `cache_copy` / `snapshot`).

This one table is what makes both deliverables possible: it is the rug backtest's feature source and the pipeline's history layer.

### G3 — Pre-dump windows
The corpus anchors at the event. **Fix:** with G1+G2 landed, build windows retrospectively by joining `token_ohlc_bars` and `token_metrics_history` on minute, and take the window ending at `event_at − RUG_ASOF_LEAD_MIN` (default e.g. 15) — i.e. *before* the dump, not at it.

### G4 — An independent label + a control cohort
Existing labels are circular: `token_rug_list` is `gmgn-radar` 4,117 + `concentration` 218 + the tracker auto-`rugged` sync 3,608 = **97%**, with the human surfaces totalling ~40 rows.

**Fix:** derive the primary label from the recorded series — a **rug event** = mcap collapse ≥ `RUG_EVENT_DROP` (e.g. −60%) within `RUG_EVENT_WINDOW` (e.g. 30 min) — and draw a **control cohort** from the same period (tracked tokens that did *not* collapse), so the report carries a base rate. Keep `token_rug_list` as a second, separately reported arm.

### G5 — Retention
`token_ohlc_bars` prunes at **48h** inline (`route.ts:140`); social 24h; `mcap_social_pattern_24h` 24h. **Fix:** G2 becomes the durable series; extend bar retention only for the watch set if the window join needs it, and state the storage cost per extension.

## Backtest harness

For each token with a known event:
1. Rebuild the last `RUG_SIG_WINDOW` 5m bars ending at `event_at − lead`.
2. Compute the score (`evaluateRugSignal`, pure — already unit-tested).
3. Record: score, the four component breakdowns, and each band's `risk01`.

Report:
- **Both label arms side by side** — (a) derived-from-series, (b) existing `token_rug_list` — with (b)'s circularity stated in the report, never hidden.
- Score distribution per class; precision/recall at the operating threshold (80); CIs.
- An explicit **`inconclusive`** below a minimum-sample floor (do not print a headline metric at small n).
- **Held-out weeks** — fit on weeks 1–2, validate on 3+. Four weights + ~3 anchors against one label set overfits trivially.

## Acceptance

- A reproducible script prints both arms with CIs and the held-out split, and says `inconclusive` when the sample is too small.
- An anchor may be labelled *fitted* only when the validation weeks agree with the fit weeks.
- `token_ohlc_bars.volume` is non-null for fresh rows; `token_metrics_history` grows and is retained for the configured window.

## Open items

1. ~~Volume source per minute (there is no free per-minute traded-volume feed in the stack; this is the one genuinely new integration).~~ **Closed (2026-10-01).** There is no new integration: four already-integrated sources return per-candle volume, and it was being dropped at one UPSERT. The series is built at **5m**, the scorer's own unit — see §G1.
2. Cadence and retention defaults for `token_metrics_history` — retention defaulted to **30** days (see §G2); the trending-sweep and snapshot cadences inherit their existing cron ticks.
3. Whether the ramp score becomes a live gate — a separate decision, and only after this report.
4. Should the **sampler** also persist candle volume into `token_ohlc_bars` (rather than only the metrics series)? It would make the own-1m series whole, but it needs candle calls the sampler does not make today — deferred.
