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

---

## Correction, 2026-10-01 (later the same day) — the budget above came from the WRONG endpoint

**What went wrong.** The "≥ 60 rps clean" ceiling above was measured on `token_stat` (~600 B payload) and
then applied to **candles** — the endpoint the metrics copier actually uses, at ~18 KB (~90× the payload).
The first production sweep (a ~240-call burst at `METRICS_COPY_RPS=8` over ~30 s) tripped a **429 on the
whole Worker path**: `token_stat` *and* candles both 403/429'd afterwards, so the limit is **tunnel-wide**,
not per-endpoint, and it is shared with the live chart and risk-chip lanes.

**Owned, then reverted.** The copier was disabled immediately via the non-code switch
(`METRICS_COPY_INTERVAL=0` + `METRICS_COPY_KILL_SWITCH=1`). Removing the load cleared the 429s within
**~2 minutes** — a transient rate window, not a lasting block. The sweeps that did run were guarded: on the
block the client reported `parked: true, blocks: 8` and stopped instead of hammering.

**Re-measured on the right endpoint** (`/api/v1/token_mcap_candles/...?resolution=1m&limit=501`, 60 distinct
mints, stopping at the first non-200):

| step | requests | 429/403 | achieved rps | p50 | payload |
|---|---|---|---|---|---|
| sequential | 6 | **0** | 1.96 | 472 ms | 264 KB |
| 1 rps target | 30 | **0** | 0.65 | 447 ms | 2,403 KB |
| 2 rps target | 30 | **0** | 1.03 | 405 ms | 2,243 KB |
| 3 rps target | 30 | **0** | 1.14 | 508 ms | 2,403 KB |

**96 requests / 2.6 MB clean, ~1.1 rps sustained, zero blocks.** A serial probe is latency-bound
(~450 ms/call → ~2.2 rps max), so the true ceiling is still above 1.1 rps and below the 8 rps that blocked —
but the clean, measured zone is what matters for operations.

**Budget now:** `METRICS_COPY_RPS` default **2** (was 48), on its own lane, with a smaller sweep
(`METRICS_COPY_MAX_MINTS=150`). Ramp only on evidence, watching for 403/429. The `40 %`/`80 %`-of-ceiling
framing in the section above is superseded where the endpoint differs in payload size — a rate measured on
one endpoint does not transfer to another through the same tunnel.

**Also fixed here:** the cron's 30 s client timeout sat below a cold sweep, so it recorded a *successful*
sweep as a failure — now `METRICS_COPY_TIMEOUT_SEC` (default 240).

## Correction, 2026-10-02 — those 403/429s are a Cloudflare **challenge**, not a rate limit

**What we got wrong.** The section above reads the tunnel-wide 403/429 as a *shared rate budget* and
concludes "the limit is tunnel-wide, not per-endpoint". The symptom was real; the inference was not.
The response body is `<title>Just a moment...</title>` — an HTML interstitial from **Cloudflare's managed
challenge** in front of `gmgn.ai`, relayed verbatim by the Worker (`new Response(body, { status:
upstream.status })`). That is why it looked tunnel-wide: a challenge is scored against the **client**, so
it hits every endpoint at once regardless of which one you call. There is no shared rate budget being
exhausted here, and our volume is not the trigger — only ~10 attempts were made in the window and all were
challenged, including with browser-like `Origin`/`Referer`/`UA` headers, which the app already sends.

**The natural experiment that settles it.** In one window, a `token_mcap_candles` sweep fetched
**240/240 cleanly** (`fetch_failed 4`) while `mutil_window_token_info` was being challenged — two endpoints,
opposite outcomes, simultaneously. So at this volume the refusals are per-endpoint, not per-tunnel.

**The damage was in our own response to it.** `gmgn-web-extra.ts` parked on any 403/429 with a single
**global** 60 s flag, so an intermittent challenge on the *snapshot* endpoint discarded a whole 15-minute
copier sweep (`fetched 0, scored 0, shadow_rows 0` — the series got a hole for a refusal that didn't apply
to the endpoint being swept). `gmgn-web-multi.ts` already keyed its cooldown by pathname for this exact
reason; `gmgn-web-extra.ts` now does the same, and distinguishes the two failure modes.

**Shipped:** a park keyed **per endpoint** (`gmgnWebEndpointKey`, and `gmgnWebCopyLaneBlocked()` for the
copy lane's own `token_mcap_candles` / `meme_quote_info`), plus **challenge detection** — a challenge is
retried (2 retries, 400 ms backoff) and never parks, because retrying helps and waiting does not. A genuine
JSON-bodied 429 still parks its endpoint for 60 s.

**Not permanent, and not degrading.** `token_info_detect` output by day: 343 → 455 → 671 → 799 → (today,
partial) 104, one row per mint, newest 2 minutes old and fully populated (`top10_hold_pct`, `sniper_wallet_count`,
`bundlers_hold_pct`). The snapshot path and the risk chips have been producing continuously; the challenge
rate is unquantified but plainly low enough to be a nuisance, not an outage.

**Two measurement traps, recorded so they don't mislead again:**

- **`docker logs` on this stack resets on every container recreate.** Retention showed **13 seconds** after a
  deploy, so any "last N minutes" read from container logs is really "since the last recreate" — and a deploy
  silently destroys the history mid-investigation. Measure over days from **Postgres**, not `docker logs`.
- **`DEFAULT_POSITIVE_TTL_S = 90`.** Three probes 25 s apart are one live call plus two cache hits, so a
  3/3-success read overstates it. Only the first probe proves the upstream was reachable.

**Still open:** whether the challenge rate correlates with our own volume (unresolved — the attempt count was
too low to tell), and whether `sol` should get an automatic fallback to the OpenAPI path (`GMGN_API_KEY` is
present; `GMGN_TOKEN_INFO_SOURCE=web` currently makes that path unreachable for `sol`). Neither is load-bearing
today.

## Per-endpoint cooldown + backoff (2026-10-03)

Prod showed `gmgn_activity_poll` / `gmgn_sim_track` failing 44–60 % of runs with `GMGN rate limit
exceeded`. Findings from code + a 1 h log window:

- The web-multi path (`gmgn-web-multi.ts`, Worker → gmgn.ai) and the OpenAPI path (`gmgn-api.ts`) do
  **not** share a cooldown or a gate. The ~28 % `mutil_window_token_info` 429s are real but only
  cost wasted upstream calls; they never fail sim/activity.
- Sim/activity failures come from the OpenAPI client: one process-wide 30 s fail-fast cooldown was
  armed by a 429 on **any** endpoint (smartmoney, kol, token info, roster, digger…), so every other
  GET failed instantly for 30 s even when its own endpoint was fine.

Change: the OpenAPI cooldown is keyed **per path**; length honors `Retry-After` /
`X-RateLimit-Reset` (clamped 1–30 s) or climbs 5 s → 10 s → 20 s → 30 s per consecutive 429 on that
path (reset by a success), with 0–25 % jitter; a 429 also widens the shared gate ×2 for 20 s so
other consumers slow down instead of failing. The web window endpoint now holds a short (~15 s)
per-path cooldown after its retry is exhausted (primary `multi_token_full_info` unaffected).
