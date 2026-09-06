# Decision machine — current state (2026-09-07)

Honest snapshot of Solana + Robinhood algo after the RH LP indexer work and the Solana search/ML-size pass. Code wins if this disagrees.

**Robinhood is still `sim_only` repo-wide.** Manual Kyber swaps in the UI are not a strategy cron. Promoting an RH strategy to `live_only` does not create a live executor.

## What shipped

### Shared plumbing (both chains)

- `getOpenPositionPrices(mints, chain)` — **required** `chain`. GMGN first; Jupiter on sol, DexScreener (concurrency-4) on robinhood.
- Deactivate close uses `merged.chain` + `simWalletForChain` (`*-rh` wallets).
- Job lock: `withJobLock` on signals / gmgn / social / mcap sim-track, RH LP screen, strategy search. Go `makeRequest` treats HTTP 409 as skip, not failure.
- Shared `shouldClosePriceSimPosition` + `getOpenStrategySimPositions`.
- Signals open: batched prices + social context. GMGN/social closes: `insertTradingRecords`.

### Robinhood LP + Trenches

- Indexer: `https://robinhoodpools.lol` (`/api/lp/pools` + `/api/lp/status`) → `rh-pools-indexer.ts`. Confidence: lag / deferred enrichment / reorg / errors; `noTrade` below 0.35.
- Paper LP: worker `rh_lp_screen` (300s) → `scoreRhPool` (hard floors + feeEff/feeApr/demand/stability × confidence) → `dlmm_candidates` / `dlmm_positions` `chain='robinhood'`. Singleton v4 TVL rescued via DexScreener `fetchPairLiquidityUsd`.
- UI: LP pools table sorts by score; LPs / churn / demand; indexer chip.
- Trenches: `fomo_ws.go` snapshots traders+closed; ingest upserts; synthetic/airdrop flags dropped; `fomoTokenDemand24h` / `fomoWalletEdge` feed LP score + social boost.
- Schema: `db/init/29-rh-lp-candidates.sql`.

### Solana trade + DLMM + search

- DLMM hunter: `solDlmmConfidence` + Redis last-good Meteora snapshot (30m). Scores × confidence.
- Soft ML size on **mcap, signals, gmgn** opens: `softMlSize` = `base × (1 − pBad) × confidence`, floor 0.25 (`SOL_ML_SIZE_FLOOR`). Stamps `ml_size_mult`. Hard skip still only when `ML_*_MODE=enforce` **and** `*_ready` (mcap path). Pattern F1 is still ~0.47 — stay shadow.
- Search cron `strategy_search` (6h, `STRATEGY_SEARCH_INTERVAL=0` disables): walk-forward → prune `search_*` on fitness → spawn top-K that beat baseline (pBad prior) → if a passing search beats canonical expectancy, copy config onto the **canonical sim** id (`sim_only`). Live still `POST /api/strategies/[id]/promote`.
- CLI: `npm run mcap:strategy-bandit -- --cycle --domain=gmgn`.

## Explicitly not done

| Gap | Why it matters |
|---|---|
| RH live strategy executor | Cron cannot size or swap ETH; Kyber is UI-only |
| Trending / social ML size + search | Out of the locked Solana pass |
| DLMM / RH LP bandit | Paper LP ranks; no param search |
| Auto `live_only` | Forbidden; human promote only |
| Hard ML enforce | Models not `*_ready` |
| Unified Hunter UI vs `scoreRhPool` | UI ranking vs GMGN `robinhood-screen` still two surfaces |
| Indexer last-good cache for `robinhoodpools.lol` | Solana Meteora has Redis last-good; RH pools route still times out to subgraph fallback (~20s) |

## Fitness (winner)

Expectancy over 28d, ≥20 closes, no drawdown week (≥3 losses and week PnL ≤ −40%). Shared by prune, promote gate, and auto-sim replace (`src/strategies/strategy-fitness.ts`).
