# Solana decision machine — plan (2026-09-07)

**Shipped 2026-09-07.** Living status: [DECISION_MACHINE.md](./DECISION_MACHINE.md). Do not treat the phase checklists below as TODO.

Supersedes the earlier draft in this file (5-domain hard-ML + new log tables).
Robinhood LP/trade hardening already shipped; this plan is the Solana next layer.

Goal: find winning **mcap / gmgn / signals** configs faster, let ML **shrink size and rank search** without skipping, and give **Solana DLMM** the same confidence multiplier RH LP already has. Live capital still needs a human promote.

## Locked

| Decision | Choice |
|---|---|
| ML | Soft only. `pBad` / `pWinner` scale size and spawn rank. Hard skip stays off until `gate_ready` / `pattern_ready` (today: pattern F1 ~0.47, stay shadow). |
| Search | Offline walk-forward on `strategy_outcomes` → spawn only top‑K that beat baseline into live `search_*` (cap 3 / domain). |
| Domains | `mcap_tracker`, `gmgn`, `signals` + Solana DLMM confidence. No trending/social this pass. No DLMM bandit. |
| Winner action | Auto-copy winning config onto the **canonical sim** id (`sim_only`). `live_only` stays the existing promote POST. |
| Flexibility | Expand existing entry/exit/floor **grids**, not a new strategy language. |
| Size | `base × (1 − pBad) × confidence`, floor `RH_LP`-style env (`SOL_ML_SIZE_FLOOR`, default 0.25). Stamp `ml_size_mult` on entry features. |
| Persistence | No new `decision_log` table. Stamp `ml_size_mult`, `search_rank`, `p_bad` on existing outcome features. |

## Already built — reuse, do not rewrite

- Fitness: `src/strategies/strategy-fitness.ts` (`DEFAULT_FITNESS`, used by bandit prune + `promote/route.ts`).
- Offline grids: `walkForwardDomainSearch` / `runDomainStrategySearch` in `domain-strategy-search.ts` + `mcap-exit-replay.ts`. Manual only via `scripts/mcap-strategy-bandit.ts`.
- Live bandit: `spawnSearchStrategy` / `pruneLosingSearchStrategies` / `spawnFromCandidatesFile` (`MAX_CONCURRENT_SEARCH = 3`).
- ML attach: `attachMlEntryShadow` — **enforce=true only on mcap**; signals/trending attach with `enforce=false`; gmgn open path does not attach today.
- Solana sim-track correctness (this week): required `chain` on prices, job locks, batched signals open, shared `shouldClosePriceSimPosition`, bulk closes.
- DLMM: `runDlmmScreen` + `scorePool` in `screener.ts` — no lag/confidence, no last-good cache.

```
outcomes + features
        │
        ▼
 walk-forward grids ──top-K beats baseline──► search_* sim (cap 3)
        │                                            │
        │                                     prune on fitness
        │                                            │
        └── pBad prior (don't spawn junk)            │
                                                     ▼
                              search fitness > canonical?
                              yes → upsert config onto canonical sim id
                              live_only → human promote (unchanged)
```

## Phase 1 — Solana DLMM confidence

Same shape as `rhIndexerConfidence`, no new scorer.

- Add `solDlmmConfidence(lastOkAt, fetchError)` in `src/utils/dlmm/screener.ts` (or a 20-line sibling). Lag vs `SOL_DLMM_MAX_LAG_S` (default 900), `noTrade` below `SOL_DLMM_CONFIDENCE_FLOOR` (0.35).
- `scorePool` result `× confidence`. Persist `confidence` on `dlmm_candidates` (column already exists from RH migration).
- Redis last-good snapshot of `{ pools, screenedAt }` (TTL 30m). On Meteora timeout/5xx, serve last-good with decayed confidence instead of empty.
- Job lock already on `dlmm_screen` / `dlmm_manage` — do not add another wrapper unless missing.

Vitest: lag / error / floor / last-good decay. No UI required (Hunter already sorts by score).

## Phase 2 — Soft ML size + spawn prior

One helper, one call site per domain:

```ts
// src/strategies/ml-soft-size.ts
softMlSize(baseSol: number, opts: { pBad: number | null; confidence?: number }): { sol: number; mult: number }
// sol = max(floor, base * (1 - pBad) * confidence); missing pBad → mult 1
```

Wire:

| Domain | Open size today | Change |
|---|---|---|
| mcap | `simBuySol` in `mcap-tracking/sim-track` | attach already `enforce:true` but does not change size — multiply `simBuySol` after shadow; still no extra skip |
| signals | `openSignalsSimPosition` | already attaches shadow `enforce:false` — apply `softMlSize` |
| gmgn | `openGmgnSimPosition` / `simBuySol` | **attach shadow** (today missing) then `softMlSize` |

Stamp `ml_size_mult`, `ml_p_bad`, `ml_p_winner` on entry features (already merged by `mergeShadowScoresIntoEntryFeatures` — add the mult only).

Spawn prior (Phase 3): when ranking candidates, subtract `0.5 * mean(pBad)` of that config’s historical outcomes so high-pBad grids don’t eat the cap of 3.

Do **not** flip `ML_GATE_MODE` / `ML_PATTERN_MODE` to enforce.

Vitest: floor, missing pBad, pBad=1 → floor, confidence=0 → floor.

## Phase 3 — Offline search cron → live top‑K → canonical sim replace

New Next route + Go worker. Logic lives in one server file; the CLI script becomes a thin caller.

- `src/strategies/strategy-search-cycle.ts` `runStrategySearchCycle(domain)`:
  1. `listStrategyOutcomes({ domain, limit: 5000 })`
  2. `runDomainStrategySearch({ domain, rows })` (already returns `beatBaseline`)
  3. `pruneLosingSearchStrategies({ domain })`
  4. Map beatBaseline rows → `CandidateConfig`, drop those with prior `mean pBad > SOL_SEARCH_PBAD_MAX` (default 0.65) when ≥ 10 scored rows
  5. `spawnFromCandidatesFile({ domain, candidates, onlyBeatsBaseline: true })` (stops at cap 3)
  6. If the best active `search_*` fitness **passes** and **expectancy > canonical** (and `closes ≥ minCloses`): `upsertStrategyDefinition` onto the canonical **sim** id, `execution_mode: 'sim_only'`, append description `[auto-sim from ${searchId} @ …]`. Invalidate that domain’s cache.
- Canonical targets (hard-coded, one per domain — mcap uses the template on the winning candidate):
  - `signals` → `signals_default`
  - `gmgn` → `gmgn_smartmoney_default`
  - `mcap_tracker` → `mcap_enter_first_seen` or `mcap_enter_at_80` from `entryTemplate`
- `POST /api/strategies/search-cycle?domain=` job-locked (`strategy_search`, TTL 600). 401 via existing worker secret.
- Go: `strategy_search` in `worker_tracker.go` + `WORKER_TRIGGER_PATHS`, interval `STRATEGY_SEARCH_INTERVAL` default **6h**, call three domains sequentially (or one tick with `domain=all`).
- `scripts/mcap-strategy-bandit.ts`: `--cycle` calls the same function (keep `--prune` / `--candidates` / `--promote`).

Admin: reuse fitness card if it exists; otherwise a one-line “canonical updated from `search_*`” in the existing strategy list is enough. **No new shortlist table.** Telegram optional via existing `strategy-telegram-notify` if a helper is one call — skip if it needs a new template.

Vitest: mapping beatBaseline → CandidateConfig; skip spawn when pBad prior trips; auto-sim upsert only when fitness passes and beats canonical (pure function over fixtures).

## Phase 4 — Verify

```
npx vitest run src/strategies src/utils/dlmm/screener.ts src/utils/dlmm/rh-lp-score.test.ts
rm -rf .next/ && npm run lint && npm run verify:no-raw-useeffect && npm run build && npm run start
go vet ./...
```

`npm run start` then stop. Do not flip ML enforce in Docker env.

## Out of scope

- Trending / social search or ML size
- DLMM param bandit / paper LP search
- RH live executor / auto `live_only`
- New ML models, `ml_prediction_log`, `strategy_shortlist`, LLM gate
- Changing default SL/TP/floors (grids already vary them)
- Raising `MAX_CONCURRENT_SEARCH`

## Why this is the lazy path

The expensive mistake was “new decision core + hard ML + 5 domains.” Walk-forward, fitness, bandit spawn/kill, and ML shadow **already exist**. This plan is: cache Meteora, multiply two numbers at open, put the existing CLI on a 6h cron, copy config onto the sim slot when fitness says so.
