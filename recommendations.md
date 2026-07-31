# ReloadSOL — Infrastructure Audit & Recommendations

Date: 2026-07-28 · Codebase at commit `38610c8` (graph built from `64067b16`, current HEAD 1 commit ahead — graph is fresh).
Sources: `graphify-out/graph.json` (6556 nodes / 17102 edges), `GRAPH_REPORT.md`, handoff.md, docs/algo_overview.md, docs/ARCHITECTURE_SUMMARY.md, docs/SWAP_AND_CLOSE_FLOW.md, plus direct code reads of every path cited below.

---

## 1. Executive summary — top 10 recommendations (ranked)

1. **Deploy a batch-executor (multicall) contract on Robinhood Chain (4663) and route all RH bulk buy/sell + CLMM mint/close through it.** Today RH bulk trades are `approve + swap` per leg flattened into `executeRhWalletCalls`, which only batches if the browser wallet supports EIP-5792 atomic — otherwise it falls back to **sequential `sendTransaction` + `waitForTransactionReceipt` per call** (`src/utils/dlmm/rh-send-calls.ts:65-86`). A bulk buy of 10 tokens can be up to ~21 sequential signed txs. One contract, one signature. **Impact High · Effort M-L.**
2. **Replace per-trade `approve` txs on RH with Permit2 + one-time max allowances.** Permit2 is already deployed and partially used in the v4 mint path (`src/utils/dlmm/rh-clmm/v4.ts:557-613`), but the Kyber swap path still does ERC20 `approve(router, maxUint256)` per token per router (`src/utils/dlmm/rh-kyber-swap.ts:133-152`). **Impact High · Effort S-M.**
3. **Create a real RH live-execution path (server hot EOA or ERC-4337 session key) so RH strategies can graduate from `sim_only`.** `att_rh` is hard-coded `execution_mode: 'sim_only'` (`src/strategies/registry.ts:157-196`) and the RH sim bot itself notes "live balance checks… have no RH equivalent" (`src/strategies/trending-bot-rh-sim.ts:1-6, 22-25`). All RH on-chain writes today require a browser Rabby signature; there is no server signer for RH (only GMGN's bound-wallet API signing, `src/strategies/gmgn-execution.ts:20-26`). **Impact High · Effort M-L.**
4. **Stand up an RH CLMM automation worker (fee-claim / exit / rebalance) mirroring the Solana `dlmm_manage` cycle.** The Go cron binds 26 workers, all Solana-facing (`main.go:426-622`); there is zero scheduled automation for RH CLMM positions. Fees are only claimable by manual browser action (`claimV4Fees`, `v4.ts:1883-1957`). **Impact High · Effort M.**
5. **Fix the RH CLMM read-path N+1: `listV4Positions` calls `getV4Position` sequentially, ~8+ RPC reads per position** (`v4.ts:1595-1603, 1418-1593`), and position discovery reverse-scans up to 300 tokenIds (`v4.ts:1333-1416`). Use Multicall3-style aggregation (or one batched JSON-RPC call) + Redis-backed pool state cache. **Impact Med · Effort S.**
6. **Fix the Solana DLMM manage cycle: `REDEPLOY` is a no-op** — `manager.ts:172-178` records `last_decision='REDEPLOY'` and `executed=true` but never removes/re-adds liquidity. Also no auto-fee-claim exists for Meteora positions (fees only come out on `remove`). **Impact Med · Effort S-M.**
7. **Pattern ML: treat this as a data problem, not a tuning problem.** Class-1 recall is 0 on holdout with `{0:280, 1:50}` training rows (handoff.md:13-24); social/wallet features have 0 importance. Expand the winner cohort (relaxed band with ordinal labels or longer window), fix feature coverage upstream (social rollups at entry time), add calibration + walk-forward eval before any `enforce`. Keep `ML_PATTERN_MODE=shadow`. **Impact High · Effort M.**
8. **Move strategy hot loops out of the 5,847-line Next.js monolith route** (`src/app/api/trending/track/route.ts`, dozens of sequential `await query`/`insertTradingRecord` calls per cycle, e.g. lines 1690-1742, 3978-4698) into a lean service or Go worker direct-to-DB; batch writes; keep Next.js for UI/API only. Every cron tick currently pays Go→HTTP→Next.js→PgBouncer→Postgres with per-token sequential awaits. **Impact Med · Effort L.**
9. **Replace the default public RH RPC (`https://rpc.arrowrpc.com`, no key — `src/utils/dlmm/rh-univ2.ts:11-19`) with a dedicated/paid endpoint plus failover**, and add the same endpoint-health machinery the Solana side already has (`rpc-config.ts`, `checkProviderHealth`). **Impact Med · Effort S.**
10. **Unify the chain abstraction instead of leaking Solana semantics into RH paths.** RH code reuses `buy_amount_sol`, `solAmount`, `totalSolBought` fields to carry ETH amounts (`trending-bot-rh-sim.ts:162-202, 240-291`; `registry.ts:171-173` notes "buy_amount_sol is unused on robinhood"), and the RH sim bot is a fork of the Solana cycle with duplicated exit-ladder logic (`decideRhTrendingExit` vs the Solana bot's ladder). Introduce a chain-scoped native-amount/ledger layer. **Impact Med · Effort M.**

Bonus security note: Go cron `/trigger/*` endpoints have **no auth** (docs/algo_overview.md:263; `main.go` registers them without middleware). They sit behind the Next.js proxy today, but the cron container port should never be exposed publicly.

---

## 2. Current-state architecture map (as it actually is)

```
Browser (Rabby / EIP-6963)                VPS Docker
┌─────────────────────────────┐           ┌───────────────────────────────────────────┐
│ Network toggle: localStorage│           │ nginx :80 → reloadsol-web (Next.js :3000) │
│ 'sol' | 'robinhood'         │           │ reloadsol-cron (Go :8080) → POST web API  │
│ RH wallet modes:            │           │ reloadsol-db (Postgres 16) + PgBouncer    │
│  parent = Rabby signs       │── tx ───► │ redis, social-ingest (Telethon)           │
│  bound  = GMGN API key sign │           │ ml/artifacts bind-mount (ONNX, read-only) │
└─────────────────────────────┘           └───────────────────────────────────────────┘
         │                                            │
         ▼                                            ▼
Robinhood Chain id 4663 (EVM)              Solana mainnet
- native ETH, WETH 0x0Bd7…AD73,            - Jupiter / Solana Tracker Raptor swaps
  USDG 0x5fc5…d168                          - server keypair (loadTradingKeypair) for
- UniV3 fork: factory 0x1f7d…2efa,            bots + Meteora DLMM agent
  NPM 0x7399…de0d3                          - Meteora DLMM via @meteora-ag/dlmm
- UniV4 fork: PoolManager 0x8366…40951,
  PositionManager 0x58da…04fa7,
  StateView 0xf333…673b
- Permit2 0x0000…8BA3 (canonical)
- Swap exec: Kyber aggregator API (chain
  slug "robinhood") + SwapRouter02
- RPC: rpc.arrowrpc.com (default, keyless)
(src/utils/dlmm/rh-clmm/config.ts:3-28,
 src/utils/dlmm/rh-univ2.ts:11-19)
```

**"Robinhood Ethereum" decoded:** it is **Robinhood Chain**, an EVM L2-style chain (chain id **4663**) whose native currency is ETH, with Uniswap **v3 and v4 fork** deployments and a canonical Permit2. It is *not* a Robinhood brokerage API and *not* Ethereum mainnet. The codebase calls the CLMM implementation "rh-clmm" with `ProtocolVersion = 'v3' | 'v4'` (`config.ts:5`). Blockscout explorer: `robinhoodchain.blockscout.com`; DexScreener slug `robinhood`; Kyber aggregator supports it.

**Separation model today:**
- Client: `AppNetwork = 'sol' | 'robinhood'` in localStorage (`src/utils/app-network.ts`), gated by `routeSupportsNetwork` (`src/config/route-network.ts:14-30`). RH gets buy/sell/swap/history/pnl + 4 dev hubs; RPC-tester/token-search/ohlc/arbitrage/social are sol-only.
- API: `rejectWrongNetwork(req, 'robinhood')` on RH routes (`src/app/api/dlmm/rh-clmm-positions/route.ts:20-21`), `parseDbChain` on shared routes (prices, signals, potential).
- DB: `chain` column on `trading_records`/`strategy_outcomes`; RH CLMM has its own ledger tables (`rh-clmm-db.ts`, `rh-univ2-db.ts`) separate from the Meteora agent tables (`dlmm/db.ts`).
- Strategies: registry carries `chain` + `execution_mode`; sim wallets are chain-scoped via `simWalletForChain` (`src/strategies/sim-wallets.ts`).

---

## 3. Audit area 1 — Solana vs Robinhood separation

### Current state (evidence)

- Network enum + storage: `src/utils/app-network.ts:1-64`. Route gating: `src/config/route-network.ts`; dev-route matrix in `src/config/route-access.ts`. God-node `useAppNetwork()` has 49 inbound edges; `parseDbChain()` 50 (GRAPH_REPORT.md:345-346) — the toggle is wired into a very large surface.
- RH chain constants are fully isolated in one module: `src/utils/dlmm/rh-clmm/config.ts:3-28` (chain id, all contract addresses, explorer, deposit assets).
- RH execution stack is separate files: `rh-send-calls.ts`, `rh-kyber-swap.ts`, `rh-univ2-swap.ts`, `rh-clmm/*`. Solana execution is `solanatracker-raptor.ts`, `swap-executor.ts`, `jupiter.ts`.
- Strategies: RH strategy `att_rh` declares `chain: 'robinhood'`, `execution_mode: 'sim_only'` (`registry.ts:157-196`); RH cycle `runTrendingBotRhSimCycle` is a separate module (`trending-bot-rh-sim.ts`).

### Issues / risks

1. **Leaky naming / shared sim ledger.** RH sim trades are written into the same `trading_records` table with Solana-shaped fields: `solAmount`, `solPriceUsd`, `totalSolBought` carry ETH values (`trending-bot-rh-sim.ts:162-202, 271-291`). `cycle.totalSolBought` is read back as "native received" (`:164`). Anyone querying the ledger per chain must know the column is really "native amount".
2. **Duplicated strategy logic.** `decideRhTrendingExit` (`trending-bot-rh-sim.ts:102-129`) is a copy of the Solana TP1/TP2/TP3/SL/max-hold ladder; `openPositionsFor` re-implements position reconstruction over `trading_records` (`:49-94`). Two ladders will drift.
3. **Flat caps instead of per-strategy config.** RH hard-codes `MAX_OPEN_POSITIONS = 10` (`:25`) and registry-level `RH_MCAP_MIN/MAX` bands (`registry.ts:7-12`) — config drift vs the DB-overridable Solana params.
4. **No RH equivalent of server-side infra**: no RH RPC health panel (`/dev/rpc-tester` is sol-only, `route-network.ts:25`), no RH worker in Go cron, no RH server keypair. `getHotWalletAddress()` in the CLMM ctx is populated from an injected **browser** wallet client (`rh-clmm/clients.ts`); the module comment itself warns the module-level ctx is unsafe for server concurrency (`clients.ts:11-15`).
5. **DEX data is shared but asymmetric**: `dexscreener.ts`/`uniswapExplore.ts` (Uniswap explore GraphQL) serve RH; Jupiter serves Solana. Price fallbacks differ per chain, which is fine, but `getTokenPriceUsd` on RH is DexScreener-only — thin coverage on a young chain.

### Recommendations

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1.1 | Introduce a `ChainLedger` type: rename semantic fields to `nativeAmount`/`nativePriceUsd` at the application layer (DB columns can stay; add typed mappers per chain in `trading-records-db.ts`). | M | Med |
| 1.2 | Extract the shared exit ladder (`decideTrendingExit(strategy, gainPct, heldHours, tp1Done)`) into `src/strategies/exit-ladder.ts`; make both Solana and RH cycles call it. Delete the fork. | S | Med |
| 1.3 | Move `MAX_OPEN_POSITIONS` and RH mcap bands into `strategy_definitions.config` so `/dev/strategies` can tune RH without a redeploy. | S | Med |
| 1.4 | Extend `/dev/rpc-tester` (or add a small RH panel) to probe `RPC_4663` endpoints; reuse `checkProviderHealth`. | S | Med |
| 1.5 | Document the RH wallet model (parent Rabby vs bound GMGN) in docs/ARCHITECTURE_SUMMARY.md — it currently lives only in a code comment (`rh-wallet-mode.ts:6-10`). | S | Low |

---

## 4. Audit area 2 — Fast batch trading on Robinhood (EVM)

### Current state — how RH trades execute today

Two wallet modes (`src/utils/rh-wallet-mode.ts`):

- **Parent (Rabby, browser-signed):** quotes come from the **Kyber aggregator** (`src/utils/kyber-aggregator.ts:8-9` — `aggregator-api.kyberswap.com`, chain slug `robinhood`, via `/api/kyber/*` proxies with server-side `X-Client-Id`). Per leg: `clientKyberRoute` → `clientKyberBuild` → calldata for the Kyber MetaAggregationRouter (`rh-kyber-swap.ts:77-111`). ERC20 legs prepend `approve(router, maxUint256)` if allowance is short (`:133-152`). WETH shortfall prepends one `deposit()` wrap call, computed once for the whole batch (`:43-75, 236-262` — this part is already good).
- **Batching:** all legs' calls are flattened and passed to `executeRhWalletCalls` (`rh-send-calls.ts:93-153`), which tries **EIP-5792 `wallet_sendCalls`** only if the wallet advertises atomic capability (`:42-63`); otherwise it sends each call as its own transaction, awaiting each receipt sequentially (`:65-86`).
- **Bound (GMGN):** server-signed swaps through GMGN's API, requiring `GMGN_PRIVATE_KEY` (`gmgn-execution.ts:20-26`); spike result notes GMGN swap cannot spend a Rabby parent wallet (`rh-wallet-mode.ts:6-10`).

So today: bulk buy of N tokens = N×(route+build HTTP) + 1 batch signature **only on 5792-capable wallets**; otherwise up to 1 wrap + N approves + N swaps as separate signed, sequentially-confirmed transactions.

### Issues / risks

1. Sequential fallback is the dominant real-world path (Rabby on a young chain rarely advertises atomic batch). ~21 round trips for a 10-token buy, each awaiting inclusion — minutes, not seconds, and MEV/price drift between legs.
2. Per-token `approve` to the Kyber router wastes gas and signatures; allowances persist per router, so a router upgrade forces re-approvals.
3. Route+build is 2 sequential Kyber API calls **per leg** (`rh-kyber-swap.ts:89-99`) — 20 API calls for 10 tokens, latency-bound on Kyber.
4. No nonce management, no gas strategy, no private submission — irrelevant today (public mempool on 4663) but will matter if the chain gets MEV infrastructure.
5. `executeRhParentKyberBuy` marks every leg `success: true` with the same batch hash (`:272-279`) even when executed sequentially — a mid-sequence failure is reported as all-fail only because the exception path catches it, but partial execution state is not tracked per leg.

### Recommendations

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 2.1 | **Batch-executor contract on 4663.** Deploy a minimal audited multicall-style executor (owner-scoped, pull-based: `transferFrom` user → swap per leg → sweep). One signature executes wrap + approve + N swaps atomically. Removes EIP-5792 dependence entirely. Keep `rh-send-calls.ts` as the transport but target the executor. | M-L | High |
| 2.2 | **Permit2 everywhere.** Approve each token once to canonical Permit2 (`0x0000…8BA3`, already in `config.ts:7`), then swaps/mints consume `permit2.permit` signatures off-chain or a one-time `permit2.approve(executor)`. The v4 mint path already plans Permit2 calls (`v4.ts:557-613`); extend the pattern to the Kyber/batch path. | S-M | High |
| 2.3 | **Parallel route+build.** Fire all Kyber `/routes` calls concurrently (`Promise.all`), then builds concurrently; today the per-leg loop is sequential (`rh-kyber-swap.ts:209-231`). Cache route summaries for ~10s for repeat buys. | S | High |
| 2.4 | **Account abstraction / session keys (Phase 2-3).** Once a server execution need exists (area 3 of the owner asks), evaluate ERC-4337 smart account with session keys scoped to (router, token allowlist, daily spend cap) — this is the clean path to unattended RH bots without a raw hot private key. | L | High |
| 2.5 | Per-leg result tracking: when falling back to sequential, record which leg index succeeded so partial buys are recoverable/reconcilable. | S | Med |
| 2.6 | Nonce manager + `maxFeePerGas` strategy helper in the RH client layer (needed anyway for any future relayer/server signer). | S | Med |

---

## 5. Audit area 3 — DLMM/CLMM lifecycle (Solana Meteora vs RH v3/v4)

### Current state

**Solana (Meteora DLMM) — full automated lifecycle exists:**
- Open: `deployPosition` (`src/utils/dlmm/actions.ts:30-116`) — capital limits, `createDlmmExecutor` (real server keypair or dry-run sim, `executors.ts:137-149`), ledger insert, Telegram notify.
- Manage: cron `dlmm_manage` (60s) → `runDlmmManageCycle` (`manager.ts:11-94`) — per position: `checkRange` on-chain, `fetchMeteoraPool` HTTP, PnL update, `decidePositionAction` → CLOSE / REDEPLOY / STAY.
- Exit: `removePosition` → `buildRemoveLiquidityTx` + outcome write with entry-feature snapshot for ML (`actions.ts:169-280`).
- Fee claim: **only inside remove**; no standalone/auto claim.

**RH (Uni v3/v4 fork) — manual, browser-driven lifecycle:**
- Open: `mintV4SingleSided` (`v4.ts:836-1186`) — single-sided, out-of-range-by-design range with edge buffer; plans wrap + Permit2 + mint as one `executeRhWalletCalls` batch. Server ledger insert via `POST /api/dlmm/rh-clmm-positions` (`route.ts:39+`).
- View/list: `listV4Positions` (`v4.ts:1595-1603`) + `/api/dlmm/rh-clmm-live` with Redis → DB → background-revalidate tiers (`route.ts:36-77`).
- Collect fees: `claimV4Fees` (`v4.ts:1883-1957`) — manual, from the UI sheet.
- Exit: `closeV4Position` (`v4.ts:1624-1877`) — three encoded strategies (BURN+TAKE / DECREASE+TAKE / COLLECT_FEES), each simulated then written then awaited, wrapped in 3 retry rounds with 1.2s backoff (`:1704-1807`).
- Rebalance: **does not exist** on RH. V3 twins live in `positions.ts`/`close.ts`/`fees.ts`.

### Issues / risks

1. **No RH automation at all**: no cron worker, no OOR detection, no auto-fee-claim, no auto-rebalance, no TP/SL on LP positions. Solana has all of the above (minus fee-claim).
2. **Read-path N+1 + scan**: `listV4Positions` → sequential `getV4Position` per NFT, each doing ~8 `readContract` calls + 2 price lookups (`v4.ts:1418-1593`). Discovery reverse-scans up to 300 ids when the DB ledger is incomplete (`:1390-1409`). A 20-position wallet is ~160+ RPC calls per refresh.
3. **Mint loads the pool 3×** (`v4.ts:849, 936, 1012`) to chase tick freshness — each load is 4+ RPC calls.
4. **Close latency**: simulate→write→wait per attempt × 3 attempts × 3 rounds; worst case ~27 on-chain interactions for one exit. The "best-effort burn shell" adds another write (`:1809-1849`).
5. **Solana manage cycle is per-position HTTP+RPC serial**: `fetchMeteoraPool` per position per 60s cycle (`manager.ts:135-154`); fine at 5 positions, melts at 50.
6. **REDEPLOY is cosmetic** on Solana: decision logged, nothing executed on-chain (`manager.ts:172-178`); only the manual `editPosition` path actually re-deploys (`actions.ts:137-157`).
7. Inconsistency: RH ledger tracks tokenId/poolId (`rh-clmm-db.ts`) while Solana tracks position pubkey + bin ids (`dlmm/db.ts`) — no shared position model, so reporting/`algo-positions.ts` needs per-chain mappers (which exist: `mapDlmmPositionToAlgoPosition`, but RH CLMM positions are not mapped into algo positions at all).

### Recommendations

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 3.1 | **RH CLMM cron worker** (`rh_clmm_manage` in Go → `POST /api/dlmm/rh-clmm/manage`): per open position, read StateView slot0 (batched), compute in-range + unclaimed fees, then: auto-claim fees above threshold, flag/auto-close on OOR timeout + TP/SL analogues, write decisions to `rh_clmm_positions`. Needs a server signer (see 2.4) or, initially, operator-alert-only mode (Telegram "claim now" with deep link). | M | High |
| 3.2 | Multicall-aggregate all `getV4Position` reads (poolAndInfo, liquidity, slot0, fee growth for all tokenIds in 1-2 batched calls); add 15s Redis cache of pool slot0 per poolId. | S | Med |
| 3.3 | Record `poolKey` in the RH ledger at mint time (it is known) so `resolveV4PoolKey` brute-force fee/spacing loops (`v4.ts:185-234`) disappear from the hot path. | S | Med |
| 3.4 | Collapse the 3× pool load in mint to one load + one tick re-check; pass deadline from caller. | S | Low |
| 3.5 | Solana: make REDEPLOY real (remove + deploy with new bin range, reusing `editPosition` logic) or demote it to an alert. Add Meteora auto-fee-claim when `claimableFees > threshold`. | S-M | Med |
| 3.6 | Solana: batch `fetchMeteoraPool` calls in the manage cycle (pools are few; fetch unique pools once, share across positions). | S | Med |
| 3.7 | Unify LP position model: extend `algo-positions.ts` with `mapRhClmmPositionToAlgoPosition` so `/dev/strategies` shows RH LP alongside Meteora. | S | Med |

---

## 6. Audit area 4 — Strategy inventory

### Inventory (registry + docs/algo_overview.md:29-43)

| ID | Domain | Chain | Mode | Default active | Worker | Outcome writer |
|----|--------|-------|------|----------------|--------|----------------|
| `att` | trending_bot | sol | live-capable | yes | `trending_track` 5m | `recordTrendingBotOutcome` |
| `lowcap_moonbag` | trending_bot | sol | live-capable | yes | same | same |
| `scalper` | trending_bot | sol | — | **no** | same | same |
| `hodl` | trending_bot | sol | — | **no** | same | same |
| `att_rh` | trending_bot | robinhood | `sim_only` | yes | RH sim cycle | `recordTrendingBotOutcome(chain=rh)` |
| `signals_default` | signals | sol | sim_only | yes | `signals_sim_track` 120s | `recordSignalsOutcome` |
| `signals_sell_over_100` | signals | sol | sim_only | yes | same | same |
| `mcap_enter_first_seen` | mcap_tracker | sol | sim_only | yes | `mcap_tracker_sim_*` | `recordMcapTrackerOutcome` |
| `mcap_enter_at_80` | mcap_tracker | sol | sim_only | yes | same | same |
| `dlmm_default` | dlmm | sol | sim/live via dry_run flag | yes | `dlmm_screen/manage` | `recordDlmmOutcome` |

Plus GMGN family (radar/comeback/live-boost/wallet-digger/roster-watch) wired as workers + sim modules rather than registry entries — a second, parallel strategy surface (`gmgn-*` files, ~30 modules).

### Issues / risks

1. **Monolith hot route**: `src/app/api/trending/track/route.ts` is **5,847 lines** with dozens of inline sequential `await query(...)` / `insertTradingRecord` calls (e.g. 1690-1742, 3978-3980, 4241, 4553-4698). Every 5-min cron tick runs this inside a Next.js request.
2. **Duplication**: exit ladders duplicated (RH fork, §3); price enrichment duplicated across `outcome-features.ts`, `resolve-entry-snapshot.ts`, `swap-executor.provider.test.ts` helpers; GMGN sim open/close logic overlaps `open-strategy-sim-positions.ts`/`close-strategy-sim-position.ts`.
3. **Dead/inactive**: `scalper`, `hodl` are shipped but inactive defaults — fine, but their configs still ship in every registry merge; the graph shows a large `Strategy Defaults Registry` community around loaders that merge DB overrides per domain (`load-*.ts` × 6 + `merge-*.ts` × 6 = 12 near-identical modules).
4. **Config drift**: `docs/algo_overview.md` documents 9 strategies; registry has 10 with `att_rh`; defaults live in `registry.ts`, overrides in `strategy_definitions`, caps hard-coded in `trending-bot-rh-sim.ts` — three sources of truth.
5. **Polling pressure**: `mcap_tracker_sim_open` every **15s** (`algo_overview.md:238`), `signals_sim_track` 120s, `dlmm_manage` 60s — each a full HTTP→Next.js→DB cycle. `signals_sell_over_100` dominates recent outcomes when running every 2-4 min (algo_overview.md:316).
6. **N+1 in RH sim**: `openPositionsFor` calls `computeOpenSimCycle(records, mint)` inside a loop over records — O(n²) over the wallet's record history (`trending-bot-rh-sim.ts:53-57`).

### Recommendations

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 4.1 | Split `trending/track/route.ts` into `src/strategies/trending-bot/{capture,calculate,result}.ts` pure modules + a thin route handler. Precondition for any perf work. | L | High |
| 4.2 | Batch DB writes per cycle (one `INSERT ... SELECT`/`unnest` for records and tracker rows instead of per-token awaits). | M | High |
| 4.3 | Consolidate the 12 load/merge modules into one generic `loadDomainConfig(domain)` driven by a schema map. | M | Med |
| 4.4 | Fix O(n²) cycle reconstruction: build cycles once per wallet fetch, index by mint. | S | Med |
| 4.5 | Revisit 15s open cadence: make it event-ish (only when new tracking rows appear) or back off to 30-60s; the 15s loop mostly re-scans unchanged rows. | S | Med |
| 4.6 | Decide the fate of `scalper`/`hodl`: archive to docs or delete from registry to shrink merge surface. | S | Low |

---

## 7. Audit area 5 — Machine learning

### Current state

- **Track B (Pattern gate, primary):** features = 10 columns (`ml/pattern_features.py:9-20`: log_first_mcap, mentions/channels 30m, minutes-to-first-mention, smart-wallet buys, GMGN FOMO flag, activity score, sm wallets, hot-before-entry). Labels from 24h cohort (winner ≥120% / loser <80%). Train = LightGBM, `scale_pos_weight = n_neg/n_pos` (`ml/train_pattern.py:65-68, 126-134`), decision threshold tuned on **test** proba for macro-F1 (`:71-80` — mild leakage), time-based split (`:27-62`), ONNX export opset 12 (`:83-99`). Serving = cached `onnxruntime-node` session in Next.js (`entry-pattern-scorer.server.ts:30-69`), shadow fields written on mcap sim entry; enforce only when `pattern_ready` (macro-F1 ≥ 0.60, `MIN_PATTERN_MACRO_F1`, pattern_features.py:22). Baseline: macro-F1 0.468, class-1 recall 0, train {0:280,1:50} (handoff.md:13-24).
- **Track A (sim-outcome gate):** v2-gate/v2-potential artifacts, scorer `entry-ml-scorer.server.ts` with the same shadow/enforce pattern; F1 0.33, 95 export rows (ARCHITECTURE_SUMMARY.md:207-210).
- Feature pipelines are mirrored TS↔Py (`pattern-features.ts` ↔ `pattern_features.py`) — two implementations to keep in sync, already noted by the "Canonical Entry Features" community.

### Issues / risks

1. **Class imbalance is the headline blocker** (15% winners; class-1 recall 0). `scale_pos_weight` alone isn't saving recall at n_pos=50.
2. **Threshold tuned on the test split** (`train_pattern.py:71-80` is applied to test proba) — inflates reported macro-F1; use a validation slice.
3. **Social/wallet features have 0 importance** (handoff.md:24): likely because most rows have zero mentions in 30m (cold-start tokens), so features are constant-zero and uninformative — a coverage problem, not a model problem.
4. **Label definition is coarse**: winner ≥120% / loser <80% with the neutral band dropped; borderline noise near 120% dominates the minority class.
5. **No calibration**: p_winner is raw LightGBM margin-prob; enforce thresholds will misbehave after retrains.
6. **Serving latency is fine** (cached session, single tensor run, ~ms) but scoring happens synchronously inside the sim-open request path; a model reload failure path returns null silently (`entry-pattern-scorer.server.ts:106-108`) — no metrics.
7. Retrain loop is manual + a daily cron script (`install-ml-pattern-cron.sh`, 03:00 UTC); no automated quality gate blocking a bad artifact from being mounted.

### Recommendations

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 5.1 | **Data first**: extend cohort window beyond 24h (48-72h relabel with `growth_at_24h` as a feature, not the label), relax winner to ≥100% or move to 3-class ordinal (loser/neutral/winner) to triple minority rows. Target ≥150 winners before enforce discussion. | M | High |
| 5.2 | **Fix social feature coverage**: snapshot social rollups *at entry time* into `mcap_social_pattern_24h` (currently joins may miss tokens with no events); add lagged windows (mentions_5m, channels_1h, first-mention-source). Verify non-zero rate per feature in the export and log it in `model.meta.json`. | M | High |
| 5.3 | Proper validation: split train/valid/test by time; tune threshold on valid; report test once. Add PR-AUC and recall@precision≥0.5 to meta — macro-F1 alone hides the recall-0 failure. | S | High |
| 5.4 | Calibration (isotonic or Platt on valid) so `p_winner` thresholds are stable across retrains; store calibrator in meta and apply in the scorer. | S-M | Med |
| 5.5 | Shadow→enforce criteria, written down and enforced in code: require `pattern_ready` **and** ≥150 class-1 train rows **and** class-1 test recall ≥0.5 **and** 2 weeks of shadow-vs-cohort agreement ≥ threshold. Add a scorer metric log (score latency, null-score rate) to `cron_worker_runtime` or a small ML stats table. | S | High |
| 5.6 | Retrain automation: extend the daily cron to run export→train→validate→only-replace-artifact-if-better (compare macro-F1 + class-1 recall vs current meta), then emit a Telegram summary. Web picks up via volume mount (already true). | M | Med |
| 5.7 | Deduplicate feature code: generate the Python feature list from the TS canonical definition (or vice versa) — single source for column order; a drift test exists in spirit (`ml-training-features.test.ts`) but column parity between `pattern_features.py` and `pattern-features.ts` is manual today. | S | Med |
| 5.8 | Scoring latency: fine as-is (in-process ONNX, ms-level). If enforce ever moves to the **live** buy path, precompute scores in the open-phase worker (15s loop) rather than at click time. | S | Low |

---

## 8. Audit area 6 — Overall speed (trade execution path)

### Bottleneck inventory (ranked by user-visible impact)

1. **RH sequential signing fallback** — minutes per bulk trade (§4). Root fix: batch executor contract + Permit2.
2. **Go cron → HTTP POST → Next.js route → DB** hop chain for every worker tick (`main.go:426-622`; `algo_overview.md:222-226`). The Go service is a scheduler only; all logic runs in Next.js request handlers, paying framework + auth + cold-module costs each tick. The 5,847-line trending route is the worst case.
3. **DB writes on hot path**: per-token sequential `INSERT`/`UPDATE` in the trending route and sim cycles; PgBouncer round trip each. No batching, no `unnest`.
4. **RPC fan-out**: RH position list ~8 reads/position sequential (§5.2); Solana manage cycle per-position `fetchMeteoraPool` (§5.5); v4 mint 3× pool load (§5.4).
5. **Raptor swap confirmation**: prepare→sign→send→poll status per swap (`SWAP_AND_CLOSE_FLOW.md:17-24`); `ws-confirm` exists (`confirmSignaturesViaWs`) and is the right pattern — ensure it's the default over polling.
6. **Kyber route+build sequential per leg** (§4.3).
7. **Module-level dynamic imports inside hot handlers** (`entry-pattern-scorer.server.ts:27`, `actions.ts:101, 214-233` lazy `await import` of outcomes/snapshot modules per call) — small but per-request overhead in Next.js.

### Recommendations

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 6.1 | Batch executor + Permit2 on RH (from §4.1/4.2) — the single biggest latency win. | M-L | High |
| 6.2 | Move worker business logic from Next.js routes into shared modules called by both the route and (optionally) a direct Go→Postgres fast path; at minimum make Go call an internal non-nginx route with keep-alive. | L | High |
| 6.3 | Batch all per-cycle DB writes; add statement timing logs per worker cycle to find the worst offenders empirically. | M | High |
| 6.4 | Multicall/batch RPC reads everywhere positions are listed (§3.2) + Redis pool-state cache. | S | Med |
| 6.5 | Default to WS confirm for Solana swaps; reserve Raptor status polling as fallback. | S | Med |
| 6.6 | Hoist dynamic imports to module scope in trade-path handlers. | S | Low |

---

## 9. Proposed implementation phases

### Phase 1 — Quick wins (1-2 weeks, low risk, no contract work)
1. Parallel Kyber route+build; per-leg result tracking (2.3, 2.5).
2. Record poolKey in RH ledger at mint; kill fee/spacing brute-force (3.3).
3. Multicall-aggregate v4 position reads + Redis slot0 cache (3.2, 6.4).
4. Fix REDEPLOY no-op + Meteora auto-fee-claim (3.5); batch manage-cycle pool fetches (3.6).
5. RH cron worker in **alert-only mode**: OOR/fee-threshold Telegram alerts, no signing needed (3.1 phase A).
6. ML: train/valid/test split fix, PR-AUC + class-1 recall in meta, social-feature coverage logging (5.2 logging, 5.3).
7. Extract shared exit ladder; fix RH sim O(n²); move RH caps into DB config (1.2, 1.3, 4.4).
8. Auth on Go `/trigger/*` (shared secret header checked in Go).

### Phase 2 — Structural (3-6 weeks)
1. **Batch-executor contract on 4663** (write, test on fork, audit-lite, deploy, integrate into `rh-send-calls.ts`) + Permit2 migration for swap path (2.1, 2.2).
2. Split the trending monolith route; batch DB writes (4.1, 4.2, 6.3).
3. RH live execution decision: hot EOA with tight spend limits vs ERC-4337 session keys; implement chosen path; graduate `att_rh` from sim_only behind a flag (2.4, §3-area 2).
4. RH CLMM manage worker **active mode** (auto-claim, auto-close) once a signer exists (3.1 phase B).
5. Dedicated RH RPC provider + health panel (1.4, 6.6-related).
6. Chain-ledger field rename at app layer; algo-positions RH CLMM mapping (1.1, 3.7).

### Phase 3 — ML enforcement readiness (parallel, data-gated)
1. Cohort expansion (48-72h window, ordinal labels) + social-at-entry snapshot (5.1, 5.2).
2. Calibration + enforce criteria gate in scorer config (5.4, 5.5).
3. Automated daily retrain with artifact quality gate + Telegram report (5.6).
4. Shadow-vs-cohort weekly review ritual; only flip `ML_PATTERN_MODE=enforce` when the written criteria (5.5) all pass — and even then, enforce on **sim** first (`ab_parallel`), never directly on live capital.

---

*End of audit. All file:line citations verified against working tree at commit `38610c8`.*
