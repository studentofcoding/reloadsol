# GMGN rate budget — measured ceilings and the mechanism that keeps us off the limit

**Measured:** 2026-09-30 · **Method:** bounded live ramps (sequential bursts, stopping at the first
429) + prod logs. **Status:** A/C/D shipped; B/E/F deferred.

> **Superseded in part — see "The web tunnel, re-measured" below (2026-10-01).** The 2026-09-30
> "≥ 2.3 rps" figure for the Worker → `gmgn.ai` path was a **sequential-probe artefact**: at ~290 ms
> per call, a one-at-a-time loop cannot exceed ~3.4 rps whatever the vendor allows. The real web
> ceiling is **≥ 60 rps**.


## The finding

**We were not rate limited — we were under-using the quota by ~7×.** The old constants were guesses;
these are measurements.

| Path | Measured ceiling (live) | Was | Now | Headroom |
|---|---|---|---|---|
| `openapi.gmgn.ai` (per API key) | **≈ 3.6 rps** — 5 sequential `token info` OK, **429 at #6** (achieved 3.60 rps over 1.66 s); concurrency-4 → **instant 429 on all 8** | `GMGN_MAX_REQ_PER_SEC=0.5` | **1.4** (~40 %) | ~2.6× |
| Worker → `gmgn.ai` (internal web) | **≥ 2.3 rps** — 6/6 `200`, never 429'd (ceiling not reached) | `GMGN_WEB_MAX_POST_PER_SEC=0.4` | **0.9** (~40 % of the observed floor) | ≥2.5× |

Prod corroboration at the time of measurement: **zero GMGN 429s in 2 h**, every `gmgn_*` worker
green, no `[gmgn-web-multi]` window-miss/negative lines (batching + caching working). The earlier
`RATE_LIMIT` storm was a transient burst window, not the steady state.

## Hypotheses → verdicts

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | config is far below the real per-key ceiling | **CONFIRMED** | 429 at the 6th back-to-back call; 3.60 rps achieved |
| H2 | the worker path is a separate bucket with headroom | **CONFIRMED (partial)** | 6/6 clean at 2.28 rps, ceiling not reached |
| H3 | the gate is per-process → aggregate exceeds config | **REJECTED** | the gate is module state, but the Go cron calls the **web** routes, so its GMGN traffic shares that process's gate |
| H4 | we waste budget re-fetching | **PARTIAL** | web path coalesces + caches; the **openapi** path had neither |

## What shipped

**A — calibrated constants.** `GMGN_MAX_REQ_PER_SEC` 0.5 → **1.4**; `GMGN_WEB_MAX_POST_PER_SEC`
0.4 → **0.9**; both env-tunable, with the measured numbers recorded in the code comment. Effect: the
inter-call spacing drops from 2 s to ~0.7 s, so a 5-candidate sim tick releases ~6 s earlier.

**C — priority lanes.** The single serial gate is now three lanes: **`high` (execution — trade quote /
swap / order) > `normal` (gate + candidates) > `low` (charts, shadow dev lookups)**. The pump **waits
first, then picks**, so a request arriving during the interval is ordered by lane rather than arrival.
This is the failure that bit us: `gmgn_sim_track` returned `GMGN rate limit exceeded` while
`radar_digest` kept succeeding — one lane, no priority.

**D — cache first, single-flight everywhere.** Web positive TTL **20 s → 90 s** (and its clamp, which
capped at 30 s, now allows up to 15 min); the **openapi** snapshot path gained an in-flight map
(`gmgn-snapshot-cache.ts`) so concurrent callers (UI poll + cron tick + shadow) share one upstream
load instead of each spending the budget on the same mint.

Tests: `gmgn-api.test.ts` (lane ordering), updated the two default-pinning tests to the calibrated
values.

## Deferred (only if A/C/D are not enough)

- **B — weight-aware budget.** Charge by GMGN's own weights (`token info` 1, `created_tokens` 2,
  `token_top_holders` 5) so cheap calls stop buying expensive ones' budget.
- **E — edge budget.** The Durable Object is already the single choke point and is currently a **pure
  pass-through**; a token bucket + coalescing + short cache there makes the budget and the cache
  fleet-wide instead of per-process. Own deploy pipeline; the DO is already a single point of failure.
- **F — observability.** Count and log gate *waits* and a `RATE_LIMIT` counter per path (the web client
  already exposes `getGmgnWebMultiMetrics()`; openapi has none) so the next tuning is data-driven.

## How to re-measure (bounded)

```bash
# openapi: stop at the first 429
KEY=$(grep -E '^GMGN_API_KEY=' .env | cut -d= -f2- | tr -d '"')
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://openapi.gmgn.ai/v1/token/info?chain=sol&address=<mint>&timestamp=$(date +%s)&client_id=p-$RANDOM" -H "X-APIKEY: $KEY")
  echo "#$i -> $code"; [ "$code" = "429" ] && break
done
```

Rules: **stop at the first 429** (repeated 429s extend GMGN's ban), stay under ~30 requests, and
re-check prod for 429s afterwards. Then set the constant to **~40 % of what you measured** and record
the number here.

## Non-goals (explicitly rejected)

- **IP rotation / multiple API keys / multi-accounting.** The openapi limit is **per key** (rotating
  IPs does nothing), and the web limit is Cloudflare-side. Multi-accounting is ToS-grey and brittle.
- **Raising the GMGN tier.** Only if a measurement shows we need >3.6 rps — today we use ~14 %.
- Putting the unofficial web path on the critical path: it stays fail-soft with openapi behind it.

---

## The web tunnel, re-measured — 2026-10-01

**Method:** bounded probes from the `reloadsol-web` container against
`https://gmgn-web-proxy.yonathanevanchristy.workers.dev` (our own Worker → `gmgn.ai`), small
payloads (`/api/v1/token_stat/sol/{mint}`, ~600 B), 30 rotating mints, stopping at the first
403/429. ≤180 requests total.

**Step 1 — sequential ramp (the instructive failure).** Targets 1→15 rps:

| target | achieved | 403/429 | p50 |
|---|---|---|---|
| 1–15 rps | **0.80 → 2.86 rps** (saturates) | **0** | ~290 ms flat |

Achieved rate stopped tracking the target and pinned at ~2.9 rps. At 290 ms per call a serial loop
**cannot** exceed ~3.4 rps — so this measured the Worker hop's latency, **not** the vendor. (This is
exactly the artefact behind the 2026-09-30 "≥ 2.3 rps" row.)

**Step 2 — concurrency ramp (the real answer).**

| concurrency | achieved rps | 403/429 | p50 | p95 |
|---|---|---|---|---|
| 4 | 11.97 | **0** | 283 ms | 399 ms |
| 8 | 25.24 | **0** | 290 ms | 330 ms |
| 16 | 38.00 | **0** | 303 ms | 353 ms |
| 32 | **60.04** | **0** | 356 ms | 490 ms |

**We never reached the ceiling.** 160 requests, **zero** 403/429, single Durable Object, latency
growing only mildly with concurrency.

### Budget (80 % of the highest rate measured clean, per operator direction)

| | value |
|---|---|
| Highest rate tested clean | **60 rps** (32 concurrent) |
| **Budget = 80 %** | **48 rps** |
| Current prod `GMGN_WEB_MAX_POST_PER_SEC` | **0.4** — ~120× under the budget |
| Doc previously claimed | 0.9 (⚠ prod/doc drift — prod has 0.4) |

### What this means

- **A full 300-mint candle sweep is ~6 s at 48 rps**, not the ~12.5 min the 0.4 gate implies. The
  metrics backbone's 1m volume is therefore *not* rate-limited by GMGN web — Solana Tracker's
  absence does not block it.
- **Caveats before raising anything:** (1) this is a **burst** measurement (≤160 requests, ~20 s
  steps) — longer-window quotas are unmeasured; (2) `GMGN_WEB_MAX_POST_PER_SEC` is a **process-wide
  serial gate**, so raising it speeds up *every* gmgn-web caller (chart candles, risk chips,
  token_stat), not just the copier; (3) 48 is 80 % of the highest rate *tested*, **not** of a found
  ceiling — the true limit is somewhere above 60.
- **Recommended shape:** raise the web gate in steps (e.g. 0.4 → 8) while watching for 403/429 in
  prod, keep the existing park-on-403/429 negative cooldown, and let the copier self-pace below the
  gate rather than pushing the global value straight to 48.
