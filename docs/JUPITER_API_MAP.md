# Jupiter API map — hosts, keys, gates, and the metadata strategy

_Measured 2026-10-04 from the production VPS (`flowey-vps`), docs: <https://dev.jup.ag/docs/api-rate-limit>._

## Tiers (Jupiter docs)

| Tier | RPS | per min | Key | Bucket scope |
| --- | --- | --- | --- | --- |
| Keyless (`api.jup.ag`, no header) | 0.5 | 30 | no | per client (IP) |
| Free | 1 | 60 | yes | **per organisation** (extra keys do not add capacity) |
| Developer / Launch / Pro | 10 / 50 / 150 | 600 / 3 000 / 9 000 | yes | per organisation |

- Sliding window. `x-ratelimit-{remaining,current,reset}` on 200 and 429 (`reset` = epoch seconds when a slot frees).
- Swap, Price and Tokens share ONE main bucket; `/swap/v2/execute` has its own (keyless 20 / free 50 rps).
- `lite-api.jup.ag` is being phased out ("rate limit reduced progressively until fully retired"); its 429 body is the
  old gateway's plain `Rate limit exceeded, please try again later.` with **no** ratelimit headers.

## What we call

| Host / endpoint | Key | Used by | Gate (per process) | Shares |
| --- | --- | --- | --- | --- |
| `api.jup.ag/swap/v2/order`, `/execute` | `x-api-key` | `jupiter-swap-quote.ts` | `throttleJupiterRps` (`JUPITER_MAX_RPS` 0.5, burst 8, trade reserve 2) | org bucket (`/execute` has its own) |
| `api.jup.ag/price/v3` | `x-api-key` | `usd-prices.ts`, `jupiter-api.ts` | same gate (background lane) + 429 backoff | org bucket |
| `api.jup.ag/tokens/v2/search` **keyless** | none | `jupiter-metadata.ts` (primary) | `JUPITER_META_RPS` 0.3, burst 2 | **keyless bucket — nobody else uses it** |
| `api.jup.ag/tokens/v2/search` keyed | `x-api-key` | `jupiter-metadata.ts` (fallback on keyless 429) | same keyed gate, background lane | org bucket |
| `lite-api.jup.ag/swap/v1` | n/a | `jupiter-lite-swap.ts`, `sol-arb/atomic.ts` | keyed gate | legacy host |
| `datapi.jup.ag/v1/assets/search`, `/pools/toptrending` | none (unofficial, `referer: jup.ag`) | token-locate, trending | none / own caches | unofficial, no SLA |
| `wallet-api.jup.ag`, `ultra-api.jup.ag` | varies | portfolio / reclaim | none | — |

## Live probe (6 requests, ~4 s apart, key read inside the container, never printed)

| # | Request | Result |
| - | --- | --- |
| 1 | `lite-api.jup.ag/tokens/v2/search` single mint, keyless | **429** (no ratelimit headers) |
| 2 | `api.jup.ag/tokens/v2/search` single mint, **keyless** | **200**, 43 ms, `remaining 4 / current 1` (window ≈ 5 per 10 s) |
| 3 | `api.jup.ag/tokens/v2/search` single mint, keyed | 200, 31 ms, `remaining 5 / current 5` (window ≈ 10 per 10 s) |
| 4 | `api.jup.ag/tokens/v2/search` 3 mints comma-separated, keyed | 200, 39 ms, 3 records, `current 6` |
| 5 | `lite-api.jup.ag/tokens/v2/search` 3 mints, keyless | **429** |
| 6 | `datapi.jup.ag/v1/assets/search` single mint | 200, 29 ms |

Reading: the keyless `api.jup.ag` bucket is separate from the keyed org bucket (`current` 1 vs 5) and was empty;
the keyed org bucket already carries ~0.4–0.5 rps of Price/Swap traffic (≈ half of the Free 1 rps), so moving
~38 metadata req/min onto it would have starved trades. A batch of 3 mints costs one request.

## Decision: cache first, one paced batched keyless queue, keyed only as a 429 fallback

1. **L1** memory + **L2** Postgres (`jupiter_token_meta`) — metadata 10 min, identity fields up to 7 days,
   market hints 10 s, not-found 90 s, stale (≤ 6 h) served when Jupiter is unavailable.
2. **One queue per process**: concurrent callers are coalesced into a single comma-separated request
   (≤ 100 mints), in-flight de-duplicated, spaced by a global bucket of `JUPITER_META_RPS` (default **0.3**,
   burst 2) — 18 req/min against a 30/min ceiling, each request carrying up to 100 mints.
3. **Keyless `api.jup.ag`** first; on 429 → **keyed `api.jup.ag`** through the shared keyed gate (background lane,
   never the trade reserve). A 429 opens a per-lane cooldown from `x-ratelimit-reset`.
4. `lite-api` is no longer used for metadata.

Callers distinguish `JupiterTokenNotFoundError` / `[]` / `null` ("Jupiter has no such token") from
`JupiterUnavailableError` ("could not ask"): `assessTokenRisk` no longer reads a 429 as "not graduated" and
`/api/jupiter/metadata` returns 503 / `unavailable: true` instead of decimals-6 `TOKEN`.

Env: `JUPITER_META_RPS` (0.3), `JUPITER_META_BURST` (2), `JUPITER_META_NEGATIVE_TTL_MS` (90000),
`JUPITER_META_KEYLESS=0` (keyed only), `JUPITER_META_DB_CACHE=0` (disable L2).
Observability: one `[jupiter-metadata] stats 10m: …` log line per 10 minutes (lookups, l1/l2/neg hits, upstream
mints, keyless/keyed requests, 429s per lane, failed batches).

## Oct 4 follow-up: lite-api probe + keyed Price V3 429s

**`lite-api.jup.ag` swap v1 still works.** Probed from the VPS (3 requests, keyless, 4 s apart):
`GET /swap/v1/quote` SOL→USDC → **200** in 78 ms; `POST /swap/v1/swap-instructions` with `{}` → **422**
(validation reached, i.e. not rate limited). So `jupiter-lite-swap.ts` and `sol-arb/atomic.ts` are LIVE and
healthy and were deliberately left alone. Only `lite-api…/tokens/v2/search` was 429ing (already migrated, #136).
`datapi.jup.ag` (`pools/toptrending/1h`, `assets/search`) also answers 200. Migration, when it's needed, is a
base-URL swap to `https://api.jup.ag/swap/v1` (+ `x-api-key`), same paths.

**Why the keyed bucket still saw 429s (Price V3).** Three leaks, fixed in `fix(jupiter-price)`:
1. `jupiter-api.ts` (`getTokenPrice`/`fetchTokenPrices`, SOL price, locate) never took a token from the shared
   gate (`throttleJupiterRps`), so it competed with the gated Swap/usd-prices traffic on the same org bucket.
2. `jupiter-api.ts` and `usd-prices.ts` kept *separate* 429 state: one learned of a 429 and the other kept firing.
   They now share one cooldown (`noteJupiterPriceRateLimited`), sized from `x-ratelimit-reset` (end of the 10 s
   window, min 2 s) → `Retry-After` → 30 s default.
3. Identical concurrent lookups each spent a request. `fetchTokenPrices` is now single-flight per id-set with a 3 s
   result cache; `fetchJupiterPriceRaw` (token locate) is gated and respects the cooldown.

`JUPITER_BURST` default is now **5** (was 8): 8 was larger than the Free plan's ~10 requests / 10 s window can absorb
together with the sustained refill. Trade-off: a bulk action with more than ~5 prepares queues the rest behind the
0.5 rps refill (2 s each) instead of going out in one burst. Set `JUPITER_BURST=8` to restore the old behaviour.
