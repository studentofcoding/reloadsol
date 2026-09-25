# SPEC — Trending: GMGN feed + durable re-entry guard (+ drop rugged) v1

**Status:** shipped (2026-09-25) — commit `5d019b5`, live on `flowey-vps`
**Date:** 2026-09-25
**Surface:** `reloadsol` trending path — `trending-track/cycle.ts`, `trending-bot-rh-sim.ts`, `utils/gmgn-trending-feed.ts`, `utils/dlmm/reopen-guard.ts` consumer, `/api/gmgn/trending/filtered`
**Lane:** autotrade & algo
**Depends on:** `strategy_outcomes` (trending_bot rows), `token_rug_list` (`utils/rug-list`), GMGN API (`GMGN_API_KEY` / `GMGN_PRIVATE_KEY` — set on VPS), `getFilteredGmgnTrending`
**Provenance:** `/ask` + `/debug` investigation 2026-09-25 (live prod aggregates below). The feed-vs-RPC question is settled in §2 — do not reopen it.

---

## Implementer checklist (build first)

1. **Phase 1 — durable re-entry guard.** Add a `strategy_outcomes`-keyed, env-tunable per-mint cooldown to the GMGN-feed trending path. Mirror the DLMM lesson (`outcomeBlockedKeys` / `loadRecentlyClosedDlmmOutcomes`), not a transient position-table check.
2. **Phase 2 — one feed.** `TRENDING_FEED=gmgn` switches Sol trending **discovery** from Jupiter `toptrending/1h` to `getFilteredGmgnTrending('sol')`. Discovery only — pricing and execution do not change.
3. **Phase 3 — drop rugged.** Filter `token_rug_list` (source of truth) out of the trending feed so a rugged mint never reaches the list or the bot.
4. Keep `trending_token_tracker` and the Sol guards intact — do not merge state models in this SPEC.

---

## 1. Goal

Make the trending path behave like every other strategy domain: one discovery feed shared by the UI list and the bot, one durable re-entry guard keyed on `strategy_outcomes`, and the rug verdict honored both ways.

---

## 2. Settled: there is no "GMGN RPC" (evidence, do not reopen)

- GMGN is signed HTTP market data (`openapi.gmgn.ai`), **not an RPC**. Its scarce resource is a **global serial gate, `GMGN_MAX_REQ_PER_SEC` default `0.5`** (`src/utils/gmgn-api.ts:15`) plus a 30 s fail-fast 429 negative cache (`checkRateLimitCooldown`). `GMGN_MAX_REQ_PER_SEC` is **unset on VPS** → 0.5 rps.
- **Discovery is 1 cached call**: `marketTrending` → `GET /v1/market/rank`, wrapped in `fetchWithCache` + inflight-dedup, `GMGN_TRENDING_TTL_SECONDS` default 300, shared by the UI route and the bot ≈ 1 call / chain / 5 min.
- **Pricing never has to come from GMGN.** `getOpenPositionPrices` (`src/utils/open-position-prices.ts:88`) = Redis 5 s → GMGN `tokenInfo` → **Jupiter on sol / DexScreener on robinhood**, and sets `skipGmgn = true` on `RATE_LIMIT`. Sol already has a non-GMGN price path.
- **Execution** stays Jupiter/Raptor + Solana RPC. Unchanged. No GMGN execution.
- So the feed switch adds **zero** RPC dependency and ~1 GMGN call per 5 min. The real risk is inherited behaviour (§3).

---

## 3. As-built / evidence (live prod, read-only, 2026-09-25)

The RH twin (`runTrendingBotRhSimCycle`) is already the "GMGN as single feed" pattern, and it runs in production:

| Metric (`strategy_outcomes`) | `att_rh` (GMGN feed) | `att` (sol, Jupiter) |
|---|---|---|
| closed outcomes | **76,912** | 50 |
| distinct mints | 1,239 | — |
| avg `pnl_pct` | **−0.004%** | −15.19% |
| sum `pnl_pct` | −269 | — |
| win rate | **47.6%** (36,598 / 40,175) | — |
| window | 2026-07-27 → 2026-09-25 | — |
| recent rate | ~1,637 closes/day | — |

Close reasons fire correctly (last 2 d: `max_hold` 1,334, `tp2` 1,260, `stop_loss` 680) → **not a broken loop; a functioning strategy with no edge**. Churn ≈ 1 reopen per mint per day, and `trending-bot-rh-sim.ts` has **no per-mint cooldown**: `openPositionsFor` skips only mints open *right now*, so a mint is eligible the cycle after it closes. Sol's path has `TOKEN_PURCHASE_COOLDOWN_HOURS` / `MAX_PURCHASES_PER_TOKEN` + `bot_trade_locks` (`trending-track/constants.ts`, `wallet.ts`); the RH path has none.

Note (verified, not a bug): `insertStrategyOutcome` canonicalizes every row via `toCanonicalEntryFeatures` (`strategies/db.ts:563`), so non-core keys such as `close_reason` land under `features->'domain_features'->>'close_reason'`, not at top level.

---

## 4. Locked decisions

| Decision | Lock |
|---|---|
| Guard durability | Key the cooldown on **`strategy_outcomes`** (durable across restarts), not the position table — same lesson as `outcomeBlockedKeys` (`utils/dlmm/reopen-guard.ts`). |
| Guard scope | Per **`(strategy_id, token_address)`** + chain, with an env-tunable window and a per-mint purchase cap. A close by `scalper` must not block `att`. |
| Feed switch is discovery-only | Do **not** touch pricing or execution in Phase 2. Sol keeps `/api/tokens/prices` unless a later ticket says otherwise. |
| One filter | The bot's candidate filter must be **strategy-config driven** (band checks off `StrategyParameterSet`/`conditions`), not the hardcoded `GMGN_FILTERED_CRITERIA`. The UI list's own band stays as its display filter. |
| Rug source | Use **`token_rug_list`** (`getRugAddressSet(chain)`) as the rug source of truth — **not** `token_mcap_tracking.label='rugged'` (auto-derived from a −40% mcap drop; too aggressive to hide a market list). |
| State models | Do **not** merge `trending_token_tracker` into `trading_records` in this SPEC. |
| Rollout | Ship Phase 2 behind `TRENDING_FEED` (default `jupiter`), flip to `gmgn` after Phase 1 verification. |

---

## 5. Phases

### Phase 1 — durable re-entry guard (build first)

**New loader** (next to `loadRecentlyClosedDlmmOutcomes`, `strategies/outcomes.ts:303`):

```ts
/** Closed trending_bot rows within the cooldown window, for the re-entry guard. */
export async function loadRecentlyClosedTrendingOutcomes(
  cooldownMs: number,
  chain: StrategyChain,
): Promise<{ strategy_id: string; token_address: string; exit_at: string }[]>
// SELECT strategy_id, token_address, COALESCE(exit_at, created_at) AS exit_at
// FROM strategy_outcomes
// WHERE domain = 'trending_bot' AND chain = $1
//   AND COALESCE(exit_at, created_at) >= now() - $2::interval
// ORDER BY created_at DESC LIMIT 500
```

**New pure guard** — reuse the existing tested shape in `utils/dlmm/reopen-guard.ts` rather than inventing one:

```ts
// key = `${strategy_id}:${token_address}`
export function trendingOutcomeBlockedKeys(
  rows: { strategy_id: string; token_address: string; exit_at: string | null }[],
  cooldownMs: number,
  now = Date.now(),
): Set<string>
```

**Wire it in** `trending-bot-rh-sim.ts` candidate loop (and the same call site when Sol adopts the guard):

- Load once per cycle per chain (not per token).
- Skip a candidate when its `(strategyId, mint)` key is blocked.
- Keep the existing open-position skip (`openMints`) and `maxOpenPositions`.
- Add a per-mint reopen cap so total churn is bounded, mirroring `MAX_PURCHASES_PER_TOKEN`.

**Flags** (env-tunable, mirrors Sol's):

| Variable | Default | Meaning |
|---|---|---|
| `TRENDING_REENTRY_COOLDOWN_MIN` | `1440` | Minutes a `(strategy, mint)` is blocked after a close (24 h, matches `TOKEN_PURCHASE_COOLDOWN_HOURS`). |
| `TRENDING_MAX_PURCHASES_PER_TOKEN` | `2` | Max lifetime opens per `(strategy, mint)` (matches `MAX_PURCHASES_PER_TOKEN`). |

### Phase 2 — one feed (Sol discovery → GMGN)

In `trending-track/cycle.ts`:

- Behind `TRENDING_FEED=gmgn`, replace the Jupiter `TRENDING_URLS` fetch with `getFilteredGmgnTrending('sol')` (the same cached, inflight-deduped snapshot the UI reads).
- Map `GmgnFilteredTrendingToken` → the loop's token shape (`token_address`, `token_symbol`, `current_price`, `market_cap`, `organic_score`, `change_5m`, `change_1h`, volumes).
- Filter candidates with the **strategy config** (`conditions` / `StrategyParameterSet`) — reuse the RH path's `passesConditions` shape rather than `passesGmgnFilteredCriteria`, so one config drives both.
- Pass the new mints through the **Phase 1 guard** before opening.

Explicitly unchanged: pricing (`/api/tokens/prices`), execution (Jupiter/Raptor), `trending_token_tracker` schema/state, `bot-position-close.ts` outcome path.

### Phase 3 — drop rugged from the trending feed

- In `utils/gmgn-trending-feed.ts` (or the route), after the cached payload is built, drop mints present in `getRugAddressSet(chain)`.
- **Filter post-cache** so a freshly-marked rug disappears immediately instead of waiting out the 5-min `fetchWithCache` window (get the rug set per request; cheap local Postgres read with a short memo).
- Chain-scoped (`token_rug_list.chain`), default on (`TRENDING_DROP_RUGGED=true`).
- Applies to the UI list and the bot's candidates in one place, because they share this feed.

---

## 6. Non-goals

- **Strategy edge.** 47.6% win / ~0% net is a *signal-quality* problem; this SPEC does not tune entries/exits. Unifying the feed makes that measurable, nothing more. Give it its own data track.
- Merging `trending_token_tracker` into `trading_records`/`strategy_outcomes`-only.
- Live (real) trading changes, GMGN execution, or RH live paths (RH stays `sim_only`).
- Rewriting the Sol cycle's tracker writes, REL-20 batching, or Discord paths.
- Changing `getOpenPositionPrices` ordering (optional later: Jupiter-first on Sol to protect the GMGN budget).

---

## 7. Verification

**Unit (vitest, colocated):**

| Fixture | Expect |
|---|---|
| Row closed 1 min ago, cooldown 24 h | blocked |
| Row closed 25 h ago, cooldown 24 h | not blocked |
| `scalper` closed mint, strategy `att` candidate | not blocked (per-strategy isolation) |
| Missing `exit_at` falls back to `created_at` | honoured |
| Feed: rugged mint in `token_rug_list` | dropped from payload |
| Feed: rug marked after cache fill | dropped on the next request (post-cache filter) |
| Feed: same mint on the other chain not in that chain's rug list | kept |
| Mapper: `GmgnFilteredTrendingToken` → cycle token shape | fields map, no `undefined` price |

**Live smoke (VPS, read-only where possible):**

```bash
# baseline churn per mint (record before Phase 1)
ssh flowey-vps 'docker exec reloadsol-db psql -U reloadsol -d reloadsol_db -tAc \
 "SELECT count(*) AS closes, count(DISTINCT token_address) AS mints FROM strategy_outcomes \
  WHERE strategy_id=$$att_rh$$ AND exit_at > now() - interval $$1 day$$"'

# force one cycle (needs TRIGGER_SECRET / TRENDING_TRACKER_SECRET)
ssh flowey-vps 'curl -s -X POST -H "X-Trigger-Secret: $SECRET" http://127.0.0.1:8080/trigger/trending_tracker'

# after: the same query should show a falling closes-per-mint ratio
# Phase 2 flip:
#   TRENDING_FEED=gmgn  → confirm candidate count and that the UI list and bot agree
# Phase 3:
#   mark a live mint rugged → it disappears from /api/gmgn/trending/filtered
```

**Gates:** `rm -rf .next/ && npm run lint && npm run verify:no-raw-useeffect && npm run build && npm run start`.

---

## 8. Acceptance criteria

- [ ] A `(strategy, mint)` closed within `TRENDING_REENTRY_COOLDOWN_MIN` is not reopened by the GMGN-feed trending path.
- [ ] Closes-per-mint for `att_rh` falls measurably vs the 76,912 / 1,239 baseline.
- [ ] `TRENDING_FEED=gmgn` makes the Sol bot consume the same discovery snapshot as the UI list; `jupiter` restores the old behaviour with no other diff.
- [ ] Rugged mints (in `token_rug_list`) never appear on the trending list nor as bot candidates, on both chains.
- [ ] Pricing and execution paths unchanged; `trending_token_tracker` schema unchanged.
- [ ] `close_reason` still readable at `features->'domain_features'->>'close_reason'`.

---

## 9. Open items (non-blocking)

1. Whether to also route Sol tracking marks through `getOpenPositionPrices` (one chain-aware price helper) — optional, later.
2. Whether the UI list should adopt the strategy-config band instead of its own (the "one filter" end-state) — Phase 2 covers the bot; the list can follow.
3. Whether `MAX_PURCHASES_PER_TOKEN` should be surfaced in the strategy config JSONB rather than env.

---

## 10. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-25 | GMGN "RPC" premise | Rejected — GMGN is HTTP market data; discovery is 1 cached call/5 min; pricing already falls back to Jupiter/DexScreener |
| 2026-09-25 | Guard durability | `strategy_outcomes`-keyed cooldown, mirrors `outcomeBlockedKeys` |
| 2026-09-25 | Guard scope | Per `(strategy_id, token_address)` + chain |
| 2026-09-25 | Feed switch scope | Discovery only; pricing/execution untouched |
| 2026-09-25 | Rug source | `token_rug_list` (source of truth), not `token_mcap_tracking.label` |
| 2026-09-25 | Build order | Guard first, feed switch second, drop-rugged third |
| 2026-09-25 | Edge | Out of scope — separate data track |
| 2026-09-25 | Shipped | `5d019b5` deployed; guard live (`att_rh` opens 9–11/10min → 1); `TRENDING_FEED=gmgn` set on VPS |

---

## 11. Shipped — verification (2026-09-25)

Commit `5d019b5`; deployed via `scripts/ship-standalone-to-vps.sh` (host build refused: 3719MB < 4096MB).

- **Phase 1 live.** `att_rh` buys per 5-min bucket: `13:30=6, 13:35=5, 13:40=5, 13:45=4, **13:50=1**` (web restarted 13:49:26 GMT+7). Baseline before: 76,912 closes / 1,239 mints ≈ 26.6 closes/mint/day.
- **Phase 3 live.** `/api/gmgn/trending/filtered?chain=sol` → 200 with tokens, rug filter in the path.
- **Phase 2 live.** `TRENDING_FEED=gmgn` set in the server `.env`; web restarted healthy. Discovery-only. The Sol cycle is gated by trading hours (`403 outside 16:00-04:00 GMT+7`), so Sol candidates are confirmed in the next window; the RH twin (same feed + adapter) already runs it in prod.
- **Gate.** 35 unit tests pass; `lint` 0 errors; `verify:no-raw-useeffect` clean; `next build` exit 0; `npm run start` boots (home 200 / `/api/health` 200).
- **Hygiene.** Server's foreign WIP (docker-compose ×2, nginx.conf, 5 ml artifacts) byte-identical after the pull — `shasum -a 256 -c` all OK, nothing stashed.

**Open observation:** `att_rh` has **no `strategy_definitions` row** (every row is `chain='sol'`), so the RH twin runs on the registry default and cannot be toggled from Admin. Separate ticket.

---

## 12. Related docs

- Strategy spine: [../03-strategies-and-automation.md](../03-strategies-and-automation.md), [../STRATEGY_ARCHITECTURE.md](../STRATEGY_ARCHITECTURE.md)
- Rug registry: [SPEC-potential-rug-labels-tracker-honesty-v1.md](./SPEC-potential-rug-labels-tracker-honesty-v1.md)
- Desk/IA: [SPEC-strategies-algo-tester-unify-v1.md](./SPEC-strategies-algo-tester-unify-v1.md)
- ML review: [../04-machine-learning.md](../04-machine-learning.md)
