# Changelog

All notable changes to ReloadSOL are documented in this file.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added — Dual-chain AppNetwork (batches 1–5)

- **AppNetwork** (`sol` | `robinhood`) in header; sessionStorage; RH gated to dev wallets.
- **Route registry** + `NetworkRouteGate` + network-aware `WalletConnectGate`.
- **DB `chain` column** on `trading_records`, `wallet_watchlist`, `trading_signals`, `token_rug_list`, `dlmm_potential_list` (`db/init/23-app-network-chain.sql`).
- **Trade**: RH buy/sell/swap via GMGN bound; RH ETH nav balance; stamp `chain` on track writes.
- **Portfolio**: History/PnL/watchlist query `wallet + chain`; ETH vs SOL labels.
- **Discovery**: chart default chain from AppNetwork; watchlist CRUD chain-scoped.
- **Dev APIs**: `/api/signals`, `/api/rug`, `/api/potential` filter by `chain=`.

### Added — RH Parent vs Bound wallet mode

- Header toggle **Parent | Bound** on Robinhood (default Parent, `sessionStorage`).
- **Parent**: Rabby address; buy/sell/swap via **UniV2 + Rabby sign** (GMGN swap is bound-only / `GMGN_PRIVATE_KEY` — spike: `GMGN_PARENT_FROM_SUPPORTED = false`).
- **Bound**: existing GMGN server-sign path.
- Active address drives holdings, ETH balance, History/PnL/watchlist.
- RH nav temporarily trade+portfolio only (Signals / Strategies / DLMM sol-only until wired).

### Added — RH wallet ERC-20 holdings (USD)

- `/api/rh/wallet-tokens`: GMGN `wallet_holdings` first for active Parent/Bound address; fallback RH Blockscout ERC-20 + GMGN price fill.
- Tokens only (no NFT / ERC-721·1155); show USD (`$—` if unpriced); Sell list + Swap holdings picker via `useRhWalletTokens`.
- `/buy` bag uses same RH holdings (click fills mint list like Sol `useWalletTokens`).

### Fixed — RH Parent SSE subscribe

- `/api/trading/subscribe` accepts Sol **or** `0x` EVM wallets (was Solana-only → 400 for Parent).
- EVM connections stored/matched lowercased so POST notify hits the stream.
- Holdings stay Blockscout REST (Arrow RPC ok for UniV2/balance; does not list ERC-20s).
- Shared `normalizeSubscribeWallet` / `walletsMatch`; live Blockscout ERC-20 test for Parent sample `0x795b…603D` (WETH present).

### Fixed — Buy/sell hard-split by AppNetwork

- `/buy` + `/sell`: Robinhood never calls Solana Raptor quotes or `executeBulkBuy` / `executeBulkSellAlt`.
- RH = Parent UniV2 / Bound GMGN only; Sol = Raptor + Jupiter (optional Sol GMGN toggle).
- Hide Raptor Quotes, ConfirmTransport, Sol priority-fee chrome on Robinhood.

### Changed — Potential API + OHLC training / Radar Telegram

- **`/api/potential`** — canonical potential watchlist (`markTokenPotential`: list + `trading_signals` label + OHLC capture). Clients use `usePotentialList`; `/api/dlmm/potential` is a thin alias only.
- **OHLC labels** — Freeview saves `token_detect_snapshots`; Potential/Rug capture into `signal_ohlc_labels` (first ~10m / snapshot); gallery `/dev/ohlc-labels` (Redis + SVG). Solana Tracker via `/api/gmgn/token-ohlc`.
- **Radar Telegram** — **ENTER only** (WATCH/SKIP not posted); lifecycle open prefers **sendPhoto** + SVG/PNG 10m OHLC (`ohlc-telegram-svg.ts`).

### Added — Trading UX (PnL / buy / toasts)

- **PnL Fast Sell**: real positions resolve sellable balance via Jupiter Portfolio (`resolveWalletTokenToSell`); slippage **200** bps / `priorityFee` **30000** (aligned with `/sell`); SIM opens mark-close via `closeSimulationPosition` (no on-chain swap); Fast Sell disabled when mint not in wallet.
- **All / Real / Sim** filter pills on PnL (open + completed) and Trading History.
- **Buy chips**: selected mints under Valid/Total parsed (symbol + icon + remove); driven by `validMints` + `mergedTokenList`.
- **Dev-only** “Search this token” on selected buy header → `/dev/token-search?address=…`.
- **Toast → buy**: mcap/sim toast token click appends mint to `/buy` list and opens chart (`add-token-to-buy` event + sessionStorage bridge when off `/buy`); no longer links to `/chart/…`.
- **Open-position prices**: GMGN `tokenInfo` + Redis TTL/pub-sub + SSE (`/api/prices/open/*`) for PnL open cards; Jupiter fallback.
- **Refresh list** on PnL Open: re-fetch holdings and prune ghost real opens via `pruneOpenPositionsByHoldings` (holdings are source of truth; sims kept).

### Fixed — open-position-prices build

- `Array.from(new Set(...))` instead of Set spread (Next build without `downlevelIteration`).

### Added — Radar price growth rules

- Track `radar_price_usd` across reappearances; growth vs previous sighting.
- **&gt;50% pump** → sticky **WATCH** until price back ≤ baseline; **≤-80% dump** → `token_rug_list` (`gmgn-radar`) + close open sims.
- Wired in activity-poll + gmgn-pipeline. See [GMGN_STRATEGY.md](./docs/GMGN_STRATEGY.md#price-growth-rules-reappearances).

### Added — Radar Early bridge (accumulative GMGN Radar)

- **2h mint accumulator** (`gmgn-radar-accumulate.ts`): peak SM/KOL/activity from poll + prior `gmgn_*` events; Early Enter from `source=signals_early`.
- **Recalibrated Radar 0–100** (`gmgn-radar-review.ts`): activity + early in score; tax/liquidity removed; thresholds SKIP&lt;45 / WATCH / ENTER≥78; full stack can hit 100.
- **top10:** GMGN first, else Jupiter `audit.topHoldersPercentage` (alert path only); `top10_source` on metadata.
- **Early stamp:** `GET /api/trading/signals` writes `signals_early` into `social_token_events` so Radar cron can see Stage-1 enters.
- Wired in **activity-poll** + **gmgn-pipeline**. Ops: [docs/GMGN_STRATEGY.md](./docs/GMGN_STRATEGY.md#radar-review-telegram--entry-features).

### Added — Token map Freeview

- `/dev/token-search`: **Freeview | List** toggle — Freeview is strategy-lane kanban + activity; List keeps the classic locate dump.
- `GET /api/strategies/token-activity` (read-only social / sim / outcomes feed; does not drain toasts).
- Pin mints in localStorage; URL `?view=freeview|list&address=…`.

### Added — GMGN HTTP activity score + social bridge

- **HTTP default** for GMGN read paths: `src/utils/gmgn-api.ts` (`openapi.gmgn.ai`, `X-APIKEY` + timestamp/client_id); `gmgn-cli.ts` is barrel + `GMGN_TRANSPORT=cli` fallback.
- **60m activity score** (`gmgn-activity-score.ts`): SM+KOL cluster/overlap/recency scoring; discovery sorted by score.
- **`POST /api/gmgn/activity-poll`**: ingests hot tokens (score ≥ threshold) into `social_token_events` as `gmgn_hot` wallet_buy events.
- Social rollup includes `gmgn_*` sources in `smart_wallet_buy_count_1h`; ingest preserves GMGN score metadata.
- Strategy **`gmgn_sm_kol_combined`** (both feeds, 60m window); migration `db/init/11-gmgn-sm-kol-combined.sql`.
- Cron worker **`gmgn_activity_poll`** (~180s) + `/trigger/gmgn-activity-poll`.
- **ML logging**: `gmgn_activity_score` + 60m metrics stamped on GMGN sim + mcap/signals entry features.
- **Pattern-gate**: +3 features (`gmgn_activity_score_60m`, `log_gmgn_sm_wallets_60m`, `has_gmgn_hot_before_entry`) in TS + Python (retrain required before enforce).

### Added — GMGN live boost after entry

- **`gmgn-live-boost.ts`**: when `gmgn_hot` arrives after sim open or mcap tracking start, patch open buy `entry_features`, bump `social_boost_score`, optional TP widen + toast.
- Wired from **activity-poll** (primary) and **mcap/signals/gmgn sim-track** open-position loops (backup).
- Toasts drained via `GET /api/mcap-tracking/sim-open-alerts`.

### Added — GMGN smart money strategy domain

- New **`gmgn`** strategy domain: discover via `gmgn-cli track smartmoney/kol`, gate with GMGN token info/security scoring, paper sim via `POST /api/gmgn/sim-track`.
- Strategies: `gmgn_smartmoney_default`, `gmgn_kol_momentum` (inactive by default, sim_only).
- CLI wrapper `src/utils/gmgn-cli.ts`; live swap stub `src/strategies/gmgn-execution.ts` (requires `GMGN_PRIVATE_KEY`, not enabled v1).
- Cron worker `gmgn_sim_track` (~120s) + manual trigger `/trigger/gmgn-sim-track`.
- Admin UI: GMGN section on `/dev/strategies`; DB migration `db/init/10-gmgn-strategy-domain.sql`.
- Ops guide: [docs/GMGN_STRATEGY.md](./docs/GMGN_STRATEGY.md).

### Changed — slim ML to goal stack only

- Removed legacy v1 multiclass model (`ml/artifacts/v1/`) and `--stage multiclass` train/check CLI.
- Primary export script: `ml:export-entry-features` (`ml:export-v1-features` alias); **entry features** ≠ old model.
- Goal stack: **pattern-gate** + **v2-gate** + **v2-potential** only.
- v2-potential `model.meta.json` uses **`potential_ready`** / `min_macro_f1_potential` (legacy meta may still have `gate_ready`).
- OPERATOR_STATE: single source of truth for tracking toward 200 rows (`extractable_labeled`).

### Fixed — volume_at_entry optional + Jupiter/DexScreener fallbacks

- V1 extract: volume no longer required; missing → `log_volume_at_entry=0`; telemetry `volume_imputed` (TS + Python + dataset-stats/export).
- Jupiter volume: string coerce + `stats5m→1h→6h→24h` waterfall; stamp `volume_at_entry_window`.
- DexScreener third source when Jupiter still null (`volume_at_entry_source: dexscreener`).
- Backfill: monitor_snapshots fill, post-merge missing sample, `volume_filled_from` counts, default `limit=15`.
- Prefer re-export + retrain after deploy (imputed zeros shift distribution slightly).
- Ops verified: backfill chunk `updated=15` / `still_incomplete=0`; export 79 rows, 0 incomplete, `volume_imputed=39`.

### Fixed — ML incomplete-feature skips (going-forward + backfill)

- Per-field `incomplete_by_field` on `ml:export` and `/api/strategies/ml/dataset-stats`.
- Shared `ensureCompleteBuyFeaturesForOutcome` on mcap / signals / trending closes.
- Jupiter v2 `mcap` fills `entry_mcap` when tracker/mcap miss; persist organic/holders/`volume_5m` on `token_mcap_tracking`.
- Admin `POST /api/strategies/ml/backfill-features` fills null core fields on historical outcomes.
- DLMM close builds mint entry snapshot when mint is known.

### Fixed — Cron rebuild persistence + social_rollup 503 + schedules

- Persist worker last-success/error to Postgres `cron_worker_runtime` via `GET/POST /api/workers/runtime`; cron hydrates on startup so Workers UI survives rebuilds.
- Redis named volume `redis_data` keeps cache warm across container recreate.
- Chunk social rollup/event upserts (200 rows) to fix PgBouncer bind-param 503.
- Align `social_rollup` registry to 300s; register `social_cleanup`; domain heartbeat falls back to primary worker last-success.

### Fixed — Monitor snapshots null price/volume (Jupiter enrich)

- `resolveTokenMonitorSnapshot` waterfall: trending tracker → mcap `volume_5m` → Jupiter lite-api v2 (`usdPrice` + `stats5m` buy+sell).
- Entry snapshot fills `volume_at_entry` from Jupiter when local sources miss (so ML gate rows are not skipped).
- Going-forward only; no rewrite of historical null `monitor_snapshots`.

### Added — Phase 3: ML2 exit ops (editable overlay + apply override + train floor)

- Strategy Admin **Config → ML2 Exit Overlay**: edit tier TP/SL/hold rules, moon/pWinner nudges, reset to defaults.
- Persist in `strategy_definitions` id `ml2_exit_overlay`; runtime cache; `exitModeOverride` (shadow/apply/off) with confirm for apply (sim only).
- Env **`ML_POTENTIAL_MIN_ROWS`** (default 30) for potential train/check; warns if &lt; 30.

### Added — Strategy Admin Gate / Potential / Exit TP/SL badges + export recovery

- Reports table + outcome modal show **Gate**, **Potential**, and **Exit TP/SL** badges from `ml_gate_*` / `ml_potential_*` / `ml_exit_*` (read-only).
- CSV export + Python `canonicalize_row` accept `first_mcap` / `volume_5m` aliases and derive `token_age_hours` from `first_seen_at` + `entry_at` to recover incomplete training rows.
- Mcap close rebuilds incomplete buy `entry_features` via `buildFullEntryFeatureSnapshot` before outcome insert.

### Added — Phase B: ML2 Potential → TP/SL overlay (sim)

- **`applyPotentialToExitParams`** ([`potential-exit-overlay.ts`](src/strategies/potential-exit-overlay.ts)) maps `ml_potential_tier` / moonScore / Pattern `pWinner` → exit TP/SL/hold.
- Env **`ML_POTENTIAL_EXIT_MODE`**: `shadow` (default) | `apply` | `off`. Shadow stamps `ml_exit_*` audit + counterfactual logs; **apply** persists `trading_simulation.effective_exit` for mcap/trending **sim** closes only.
- **mcap** sim close prefers frozen `effective_exit`; live always uses registry. **Trending** sim freezes adjusted TP/SL on the simulation object; live `addSLTPPosition` unchanged. **Signals**: audit stamp only (scoring exits unchanged).

### Added — Engine spine: canonical params/features + ML shadow on all memecoin opens

- **`StrategyParameterSet`** adapters for trending / signals / mcap / DLMM; `canonical` on `GET /api/strategies`.
- **`CanonicalEntryFeatures`** (`feature_schema_version: 1`) + `toCanonicalEntryFeatures` on outcome insert; ML extractors read aliases (`first_mcap`, telegram social names).
- **`attachMlEntryShadow`** — shared ML1 gate + ML2 potential + Pattern shadow; wired on mcap (enforce unchanged), signals sim-track, trending buy features.
- **DLMM** outcomes prefer mint as `token_address` with `pool_address` + `instrument: dlmm_lp`; skip token ML until mint+core features present.

### Added — Stage-1 Pattern ML shadow score

- **Display-only Pattern ML** on Early Enter: `p_winner` / `predicted` via [`scorePredictivePattern`](src/strategies/social/predictive-pattern-alert.ts) + 5m cache ([`signals-early-pattern-cache.ts`](src/strategies/signals-early-pattern-cache.ts)).
- **Never gates** Stage-1 — alerts still fire on rules (`enter` + growth &lt;100%) even when ML says `loser`.
- Surfaces: Telegram `Pattern ML (shadow): pW …`, Early Enter toast ML snippet + **shadow** badge, Signals table **ML** column.

### Added — Two-stage copy-trade alerts + rug/peak milestones

- **Stage 1 (Early Enter)** — when Signals scores `decision=enter` and growth still **&lt;100%**, [`emitSignalsEarlyAlertsFromScored`](src/strategies/signals-early-alerts.ts) queues a toast and [`sendSignalsEarlyEnterAlert`](src/utils/telegram.ts) fires Telegram (24h dedup per mint). Emitted from [`GET /api/trading/signals`](src/app/api/trading/signals/route.ts) so UI poll + `signals_refresh` worker both work.
- **Stage 2 (Mcap Sim Open)** — unchanged confirm path for `mcap_enter_first_seen` / `mcap_enter_at_80` sim opens ([`mcap-sim-open-alerts.ts`](src/strategies/mcap-sim-open-alerts.ts)).
- **Drain API** — [`GET /api/mcap-tracking/sim-open-alerts`](src/app/api/mcap-tracking/sim-open-alerts/route.ts) returns Stage-1 then Stage-2 toasts; UI distinguishes **Early Enter** vs **Mcap Sim Open**.
- **Drop milestones** — `when_drop_40pct` / `when_drop_80pct` on `token_mcap_tracking` ([`07-mcap-drop-peak.sql`](db/init/07-mcap-drop-peak.sql)); auto-label **`rugged`**.
- **Peak profit** — `peak_mcap`, `peak_growth_percent`, `peak_seen_at`; auto-label **`potential`** when peak growth &gt; 0 (does not overwrite `traded_live` / `rugged`).
- **Signals table** — columns **-40%**, **-80%**, **Peak**; rug/potential badges on token name.

### Added — Sim open copy-trade alerts (mcap_tracker)

- **`mcap_enter_first_seen` / `mcap_enter_at_80` sim opens** — when either strategy opens a paper position, [`recordSimOpenAlert`](src/strategies/mcap-sim-open-alerts.ts) queues a UI alert and [`sendMcapSimManualTradeAlert`](src/utils/telegram.ts) sends Telegram with reloadSOL Chart / Buy / Jupiter links.
- **[`GET /api/mcap-tracking/sim-open-alerts`](src/app/api/mcap-tracking/sim-open-alerts/route.ts)** — drains pending alerts for client poll (deduped 24h per strategy+mint, in-memory).
- **App-wide toasts** — [`McapSimOpenToastHost`](src/components/signals/McapSimOpenToastHost.tsx) mounted in root [`layout.tsx`](src/app/layout.tsx); polls every 15s on **any page**. Toast **top-right**, `z-index: 9999`, with **Buy** ([`useFastBuy`](src/hooks/useFastBuy.ts)).
- **Predictive Pattern ML list toasts** — disabled by default (`scanPredictive=true` opt-in only on mcap list API).

### Fixed — mcap_enter_at_80 late / fake entry mcap

- **Stale opens skipped** — `milestone_too_old` when `when_reach_80pct` (or growth-only `first_seen_at`) is outside `recencyMinutes` (default 240). Prevents 12h-late opens that booked `first_mcap × 1.8` while live chart was far higher.
- **Entry mcap** — timely milestone still uses `first_mcap × 1.8`; late-but-allowed opens use **`current_mcap`** so Telegram/toast match a real buy price. Optional **Live mcap** line when it differs from entry.

### Security — npm audit remediation

- **Next.js 16.2.9**, **postcss 8.5.x**, **@solana/web3.js 1.98.x** — addresses reported Next/postcss/uuid advisories.
- **npm overrides** — `bigint-buffer-fixed@1.1.6` (GHSA-3gc7-fjrx-p6mg), `uuid@^11.1.1`; blog front matter uses [`parseFrontMatter`](src/lib/frontmatter.ts) instead of `gray-matter`/`js-yaml`.
- **Residual:** `elliptic` via `crypto-browserify` (browser polyfill only; no non-breaking npm fix); `postcss` nested in Next 16.2.9 (patched at app level via direct dep); `tar` via `node-gyp` build chain for native addons (install-time only).
- **Rebuild perf** — skip native rebuild when `.node` already built; removed duplicate rebuild from [`npm-ci-sync.sh`](scripts/npm-ci-sync.sh) (postinstall only).

### Fixed — bigint-buffer native bindings (macOS / Linux)

- **[`scripts/rebuild-native-deps.sh`](scripts/rebuild-native-deps.sh)** — postinstall rebuild of `bigint-buffer` when python3/make/C++ compiler are available; skips gracefully otherwise.
- **[`Dockerfile`](Dockerfile)** — removed `npm ci --ignore-scripts`; explicit `npm rebuild bigint-buffer` in deps/dev stages.
- **[`next.config.js`](next.config.js)** — externalize `bigint-buffer` on server; browser alias to `bigint-buffer/dist/browser` (Solana packages stay transpiled — avoids Turbopack conflict with `serverExternalPackages`).

### Added — MCap tracker sim strategies

- **`mcap_enter_first_seen` / `mcap_enter_at_80`** — paper-trade strategies for tokens entering mcap tracking or crossing the +80% milestone; registry + DB seeds in [`src/strategies/registry.ts`](src/strategies/registry.ts).
- **[`POST /api/mcap-tracking/sim-track`](src/app/api/mcap-tracking/sim-track/route.ts)** — opens/closes sim positions in wallet `mcap-tracker-sim`, writes `strategy_outcomes` on close via `recordMcapTrackerOutcome()`.
- **Go cron worker `mcap_tracker_sim_track`** — every `MCAP_TRACKER_SIM_INTERVAL` (default 120s); manual trigger `POST /trigger/mcap-tracker-sim-track` ([`main.go`](main.go)).
- **[`src/utils/mcap-sim-track.ts`](src/utils/mcap-sim-track.ts)** — shared entry/exit helpers: `resolveMcapSimEntry`, `getMcapSimOpenSkipReason`, `getOpenMcapSimPositions`, `countOpenMcapSimPositions`.
- **[`src/strategies/load-mcap-tracker.ts`](src/strategies/load-mcap-tracker.ts)** — DB merge loader for active mcap tracker strategies.
- **Strategy Admin** — MCap tracker strategy cards and report stats (`mcap_tracker_stats`, milestone buckets) on [`/dev/strategies`](src/app/(trade)/dev/strategies/page.tsx).

### Added — Tracker insights & tests

- **[`src/components/signals/tracker-insights.ts`](src/components/signals/tracker-insights.ts)** — per-row chips: Risk (0–100), Momentum, Milestones, Age, Liquidity (Vol/MCap), timeline inconsistency badge.
- **Vitest** — [`signals-scoring.test.ts`](src/strategies/signals-scoring.test.ts), [`mcap-tracker-timeline.test.ts`](src/utils/mcap-tracker-timeline.test.ts), [`mcap-sim-track.test.ts`](src/utils/mcap-sim-track.test.ts), [`anomaly-detection.test.ts`](src/utils/algo/anomaly-detection.test.ts), [`tracker-insights.test.ts`](src/components/signals/tracker-insights.test.ts); `npm test` script in [`package.json`](package.json).

### Fixed — MCap timeline (First Seen ~8h bug)

- **[`normalizeTrackingTimeline()` v2](src/utils/mcap-tracker.ts)** — nulls stale milestones before `first_seen_at`, reconciles growth vs milestones, clamps `first_seen` only when valid milestones remain (fixes ALONE case where stale session milestones aged First Seen backward).
- **`reconcileMilestonesFromGrowth()`** — backfills `when_reach_*` from current growth after timeline repair; called from track, list fetch, and `fixTrackingTimeline()`.
- **`resetTrackingSession()`** — fresh baseline when max tracking age exceeded; clears milestones on session reset.
- **`persistMilestoneBackfillIfNeeded()`** — runs before small-change gating early return so milestones are not permanently null after DB repair.
- **SQL patch v2** — [`supabase/patches/fix_mcap_first_seen_timeline.sql`](supabase/patches/fix_mcap_first_seen_timeline.sql): null stale milestones first, then safe `LEAST` clamp (run once on Supabase after deploy).
- **`is_finished`** — list API computes age from post-normalize `first_seen_at` ([`mcap-tracking/route.ts`](src/app/api/mcap-tracking/route.ts)).

### Fixed — MCap sim trading & strategy reports

- **`mcap_enter_at_80` never opening** — sim entry accepts `mcap_growth_percent >= 80` when milestone column was nulled by timeline v2; entry mcap falls back to `first_mcap * 1.8`.
- **Sim close reasons** — `getMcapSimCloseReason()` adds `take_profit_200` (growth ≥ 200%) and `tracking_stopped` (`stop_reason` set) so closed trades write to `strategy_outcomes` and appear in reports.
- **Reports coverage** — `open_tracker_count` populated for `mcap_tracker` strategies from `mcap-tracker-sim` wallet (was `null` / invisible while `sim_trade_count` stayed 0 for open-only positions).
- **Sim-track skip reasons** — response `skipped` array includes `no_milestone`, `out_of_range`, `rugged`, `no_entry_mcap` for debugging.

### Fixed — Duplicate mcap sim outcomes

- **Re-entry guard** — [`mcap-sim-track.ts`](src/utils/mcap-sim-track.ts) + [`sim-track/route.ts`](src/app/api/mcap-tracking/sim-track/route.ts) skip `already_closed` tokens so `mcap_enter_at_80` cannot reopen after close.
- **Read-time dedupe** — [`outcome-dedupe.ts`](src/strategies/outcome-dedupe.ts) + [`db.ts`](src/strategies/db.ts) dedupe strategy outcome rows in reports/lists.
- **Idempotent insert** — guard on duplicate `(strategy_id, token_address, entry_at)` before insert.
- **Tests** — [`strategy-outcomes-dedupe.test.ts`](src/strategies/strategy-outcomes-dedupe.test.ts), extended [`mcap-sim-track.test.ts`](src/utils/mcap-sim-track.test.ts).
- **Ops patch** — [`supabase/patches/dedupe_mcap_strategy_outcomes.sql`](supabase/patches/dedupe_mcap_strategy_outcomes.sql) for historical duplicate cleanup (run once on Supabase).

### Fixed — TrackerTab display & analytics

- **Timestamps** — First Seen, milestones (+80% / +120% / +200% labels), Last Updated, Finished At use `formatAppDateTime` (absolute + relative subtitle).
- **Analytics accordion** — risk on 0–100 scale (fixes 8000% display bug); Z-Score shows `—` when cohort too small; liquidity via Vol/MCap; momentum strength `(strength ?? 0) * 100`.
- **Chart button** — opens `ChartBuyModal` (works on finished tokens); separate mcap refetch button.
- **CSV export** — milestone columns + formatted dates.
- **Timeline badge** — warns when `first_seen_at` is still after a milestone post-normalize.

### Fixed — TrackerTab summary stats

- **`stats.highestGrowth`** — API returns max growth across filtered tokens; summary card wired in [`TrackerTab.tsx`](src/components/signals/TrackerTab.tsx).
- **PnL time windows** — entry/exit hourly buckets use Asia/Bangkok (`getAppLocalParts`) instead of UTC/local server hour in [`mcap-tracking/route.ts`](src/app/api/mcap-tracking/route.ts).
- **Mcap range buckets** — bucket bounds aligned at 50K boundary in summary analytics.

### Fixed — Z-Score & analytics API

- **[`ZScoreAnomalyDetector`](src/utils/algo/anomaly-detection.ts)** — `crossSection` mode (min cohort 3, leave-one-out peers) for TrackerTab batch analytics; `z_score_available` on response.
- **[`POST /api/analytics/token`](src/app/api/analytics/token/route.ts)** — single cohort Z-score pass over page tokens before per-token enrichment.
- **[`data-aggregation.ts`](src/utils/data-aggregation.ts)** — cross-section mode + nullable `z_score` types.

### Fixed — Signals scoring pipeline

- **[`signals-scoring.ts`](src/strategies/signals-scoring.ts)** — milestone gating for enter/hold decisions; `holdGrowthFloor`; timeline speed bonus via `computeTimeTo80Minutes`.
- **[`signals-pipeline.ts`](src/strategies/signals-pipeline.ts)** — `rescoreScoredSignal()` after rug validation; re-sort by score.
- **`GET /api/trading/signals`** — default `minGrowth` changed to `0` (was filtering out low-growth tokens incorrectly).
- **[`mcap-tracker-constants.ts`](src/utils/mcap-tracker-constants.ts)** — `STOP_LOSS_THRESHOLD` extracted for tests.

### Added — ML outcomes feed & capture

- **[`src/strategies/outcome-features.ts`](src/strategies/outcome-features.ts)** — shared helpers: `entry_mcap` / `entry_mcap_band` buckets, `formatEntryMcap`, `readTokenSymbol`, `buildEntryMcapFeatures`.
- **Outcome write paths** — signals sim-track, trending bot close ([`bot-position-close.ts`](src/utils/bot-position-close.ts)), and DLMM close store `token_symbol`, entry mcap, and band in `strategy_outcomes.features` JSONB.
- **Outcomes API filters** — `GET /api/strategies/outcomes` supports `status`, `pnl_filter` / `pnl_min` / `pnl_max`, and `entry_mcap_band`; CSV export adds `token_symbol`, `entry_mcap`, `entry_mcap_band`.
- **Legacy symbol enrichment** — `listStrategyOutcomes()` backfills missing `features.token_symbol` from `trending_token_tracker` / `trading_signals` at read time.
- **Strategy Admin Reports** — Status, PnL preset, and Entry mcap band filters; **Entry MCap** column; token column shows symbol + truncated address (algo-tester style).
- **ML labeling stats** — reports API returns `ml_stats` (total, unlabeled, by label/condition); Reports tab shows filter-scoped summary.
- **Coverage table** — **Open (tracker)** column for trending bot strategies (holding-only count via [`isOpenTrackerPosition`](src/utils/trading-simulation.ts)).

### Added — Strategy ML feature pipeline

**Assignment / att fix**

- **[`strategy-filters.ts`](src/strategies/strategy-filters.ts)** — `tokenMatchesTrendingBotStrategy()` enforces per-strategy mcap/organic/holders bands.
- **[`assign.ts`](src/strategies/assign.ts)** + **[`trending/track/route.ts`](src/app/api/trending/track/route.ts)** — assignment and buy path respect strategy filters (fixes `att` trading below 200k mcap).
- **[`registry.ts`](src/strategies/registry.ts)** — `att` conditions synced to 200k–5M band.
- **Tests** — [`assign.test.ts`](src/strategies/assign.test.ts).

**Entry feature store**

- **[`entry-feature-snapshot.ts`](src/strategies/entry-feature-snapshot.ts)** — `buildEntryFeatureSnapshot()`: token age, organic score, top holders %, volume at entry, monitor snapshot count.
- **Extended [`outcome-features.ts`](src/strategies/outcome-features.ts)** — readers for new feature keys; reports/CSV columns.
- **Wired on buy/close** — mcap sim-track, signals sim-track, trending bot close ([`bot-position-close.ts`](src/utils/bot-position-close.ts)); `PriceRecord.volume_5m` on track route.

**Auto ML labels**

- **[`outcome-labeling.ts`](src/strategies/outcome-labeling.ts)** — auto `training_class`, `ml_label`, `ml_condition`, `ml_note` on [`insertStrategyOutcome`](src/strategies/db.ts) (respects existing `ml_manual` override).
- **Manual override** — [`OutcomeReviewModal.tsx`](src/components/strategies/OutcomeReviewModal.tsx) sets `ml_manual`.
- **Tests** — [`outcome-labeling.test.ts`](src/strategies/outcome-labeling.test.ts).

**Mcap tracker config UI**

- **Extended `McapTrackerStrategyConfig`** — entry/exit thresholds, organic/holders filters in [`types.ts`](src/strategies/types.ts), defaults in registry, merge in [`merge-mcap-tracker.ts`](src/strategies/merge-mcap-tracker.ts).
- **PATCH API** — [`strategies/[id]/route.ts`](src/app/api/strategies/[id]/route.ts).
- **`McapTrackerCard`** — full config editor in [`StrategyAdminHub.tsx`](src/components/strategies/StrategyAdminHub.tsx); per-strategy exit/entry in [`mcap-sim-track.ts`](src/utils/mcap-sim-track.ts) / [`mcap-tracker.ts`](src/utils/mcap-tracker.ts).

**Reports and market regime**

- **Outcomes API** — extra CSV/table fields (organic, holders, age, volume, training class) in [`outcomes/route.ts`](src/app/api/strategies/outcomes/route.ts).
- **`market_regime_tags`** — schema + [`supabase/patches/market_regime_tags.sql`](supabase/patches/market_regime_tags.sql); [`GET/POST /api/strategies/regime`](src/app/api/strategies/regime/route.ts); Reports UI panel to tag daily regime (stored as `regime_tag_at_exit` on new outcomes). Run `market_regime_tags.sql` on Supabase after deploy.
- **Outcomes table** — collapsible entry-feature columns (Organic, Holders%, Age, Vol@entry, Track samples); **Track samples** replaces abbreviated **Mon** (count of price/volume/mcap snapshots while position was open).

### Added — Trade window volume overlay

- **[`TradeWindowChart.tsx`](src/components/strategies/TradeWindowChart.tsx)** — dual axis: price (left), Vol 5m bars (right); bar color green/red vs previous sample.
- **Missing volume** — null `volume_5m` renders as a chart gap (not a zero-height gray bar); tooltip shows “missing”.
- **Chart API** — [`loadOutcomeTradeWindowChart`](src/strategies/db.ts) passes `volume_5m` from tracker `price_history` and [`monitor_snapshots`](src/strategies/entry-feature-snapshot.ts); synthetic 2-point fallback enriches entry/exit volume from outcome features.

### Added — Volume capture (all strategy domains)

- **[`trade-window-chart-data.ts`](src/strategies/trade-window-chart-data.ts)** — legacy `volume` → `volume_5m` parsing, domain-aware chart loading, monitor volume merge by timestamp.
- **`insertStrategyOutcome`** — on close, clips trending tracker `price_history` into `monitor_snapshots` and backfills `volume_at_entry` when missing.
- **Sim-track cycles** — [`mcap-tracking/sim-track`](src/app/api/mcap-tracking/sim-track/route.ts) and [`signals/sim-track`](src/app/api/signals/sim-track/route.ts) append `monitor_snapshots` each cycle while positions are open; open paths resolve live `volume_5m` via [`sim-monitor-snapshots.ts`](src/strategies/sim-monitor-snapshots.ts).
- **Trending bot close** — [`bot-position-close.ts`](src/utils/bot-position-close.ts) embeds clipped tracker history into outcome features.
- **DLMM close** — stores `pool_volume` / `fee_tvl_ratio_24h` on outcome features; chart shows “Volume N/A for DLMM pools” when no pool metric.
- **Chart API debug** — `has_volume` and `volume_point_count` on [`outcomes/[id]/chart`](src/app/api/strategies/outcomes/[id]/chart/route.ts); Outcome review modal subtitle when volume is missing.
- **Tests** — [`trade-window-chart-data.test.ts`](src/strategies/trade-window-chart-data.test.ts), extended [`monitor-chart-points.test.ts`](src/strategies/monitor-chart-points.test.ts).

### Added — Pipeline alignment (algo-tester vs Strategy Admin)

- **[`src/utils/trading-simulation.ts`](src/utils/trading-simulation.ts)** — `resolveTrackerStrategyId()`, `isOpenTrackerPosition()`, `isSimulatedTrackerPosition()` shared by stats API and coverage reports.
- **[`src/utils/trending-execution-mode.ts`](src/utils/trending-execution-mode.ts)** — per-strategy `sim_only` / `live_only` / `ab_parallel` resolution for trending track buys.
- **[`src/utils/signals-outcome-capture.ts`](src/utils/signals-outcome-capture.ts)** — `maybeRecordLiveSignalsOutcome()` on full live wallet closes with `bot_strategy` (hooked into `POST /api/trading/records`).
- **[`src/utils/simulation-trades.ts`](src/utils/simulation-trades.ts)** — `computeOpenTradeCycle()` for sim or live record cycles.
- **UI copy** — Strategy Admin and Algo Tester explain closed outcomes vs open tracker positions; A/B section notes trending `ab_parallel` does not dual-buy.

### Changed — GMGN chart embeds

- **[`getGmgnKlineUrl`](src/utils/gmgn.ts)** — single URL builder; default interval `5` (TradingView numeric).
- **[`GmgnChartEmbed`](src/components/signals/shared/GmgnChartEmbed.tsx)** — uses shared helper; removed iframe `sandbox`; `key` remount on token/interval change; `loading="lazy"`.
- **Inline iframes migrated** — chart page, `ChartBuyModal`, `BulkTokenBuyer`/`Seller`, `PnLTracker`, dev pools page.
- **LiveTab hover chart** — 150ms debounced iframe mount to reduce GMGN TradingView remount noise.

### Changed — Algo Tester accuracy & filters

- **`GET /api/trending/stats`** — open list filtered to holding positions only; strategy filter reads `buy_operation.bot_strategy` / persisted `strategy_id`; sim filter fixed for null sim; exposes `watching_tokens_count`.
- **Algo Tester** — strategy dropdown lists all trending strategies (including inactive); labels **Open (holding)**; shows waiting-queue count.
- **Track route** — persists `strategy_id` and `entry_market_cap` on successful buy; immediate-buy path only upserts `tracking` when buy succeeds; respects per-strategy `execution_mode` via `resolveTrendingSimMode`.

### Changed — Strategy Admin config

- **Trending bot cards** — `execution_mode` merged from DB into registry; TrendingBotCard initializes dropdown from saved mode (not hardcoded `sim_only`).

### Fixed — CSP & third-party embeds

- **[`next.config.js`](next.config.js)** — allow Cloudflare Insights beacon (`static.cloudflareinsights.com` in `script-src`, `cloudflareinsights.com` in `connect-src`).
- **[`src/utils/axiom.ts`](src/utils/axiom.ts)** — browser calls use relative `/api/axiom/...` via `getApiBaseUrl()` (fixes CSP block on raw IP host).

### Fixed — Algo Tester / tracker data quality

- **Strategy filter showing 0 tracking** — stats route now resolves strategy from `trading_simulation.buy_operation.bot_strategy`.
- **Ghost “open” rows** — failed buys no longer upsert `status: tracking` without a holding simulation.
- **Ghost tracker cleanup SQL** — idempotent `UPDATE` in [`supabase/schema.sql`](supabase/schema.sql) sets non-holding `tracking` rows to `stopped`; dev table constraint patch drops misnamed `trending_token_tracker_status_check` before re-adding allowed statuses.

### Fixed — React / UI

- **LiveTab** — debounced chart hover uses deferred `setTimeout` for clear/set (fixes `react-hooks/set-state-in-effect` lint).
- **OutcomeReviewModal** — shows token symbol subtitle and entry mcap in metadata row.

### Added — Strategy admin hub

- **[`/dev/strategies`](src/app/(trade)/dev/strategies/page.tsx)** — central admin for trending bot strategies (editable TP/SL, buy size, mcap band, active toggle); read-only Signals templates and DLMM config; outcomes table for ML feed.
- **[`src/strategies/`](src/strategies/)** — typed registry (`att`, `lowcap_moonbag`, `scalper`, `hodl`), DB merge loader, token assignment, union pre-filter for multi-strategy mode.
- **Supabase** — `strategy_definitions`, `strategy_outcomes` tables; PATCH `/api/strategies/[id]` persists overrides.
- **Track route** — uses shared registry instead of inline `TRADING_STRATEGIES`; writes `strategy_outcomes` on full bot close via [`bot-position-close.ts`](src/utils/bot-position-close.ts).

### Added — Phase 2 simulation hub

- **Signals** — editable scoring/query config in admin; automated paper trading via `POST /api/signals/sim-track` (cron `SIGNALS_SIM_INTERVAL`); `recordSignalsOutcome` on sim close.
- **DLMM** — editable thresholds in admin (syncs to `dlmm_agent_config`); `recordDlmmOutcome` on position close.
- **Reports** — `GET /api/strategies/reports`, CSV export on outcomes, A/B tab on `/dev/strategies`, optional Discord/Telegram digest (`STRATEGY_REPORT_*` env).
- **Promotion** — `POST /api/strategies/[id]/promote` copies winning config to live slot after A/B review.
- **Algo Tester** — strategy + sim/live filters on stats; link to strategy reports.
- **Schema** — `execution_mode` on `strategy_definitions`, `is_simulated` on `strategy_outcomes`; seed `signals_*` and `dlmm_default` rows.

### Added — Unified datetime (Asia/Bangkok)

- **[`src/utils/datetime.ts`](src/utils/datetime.ts)** — single formatter for display (`formatAppDateTime`, `formatAppTime`, `formatAppDateTimeWithZone`, `getAppLocalParts`); storage stays UTC ISO in Supabase and log buffers.
- **Signals, Algo Tester, DLMM UI** — absolute timestamps use Bangkok wall clock instead of browser/Docker locale.
- **Server notifications** — Discord/track route/mcap-tracker replace manual `+7h` offsets and `toLocaleString()` with shared formatters; trading-hours check uses `getAppLocalParts`.
- **Logs** — [`api-logger`](src/utils/api-logger.ts), [`unified-logger`](src/utils/unified-logger.ts), [`/api/logs?format=text`](src/app/api/logs/route.ts), and [`scripts/tail-logs.js`](scripts/tail-logs.js) format human-readable lines in Asia/Bangkok.

### Changed — Repo cleanup (Docker-only deploy)

- **Removed PM2 deploy path** — deleted `deploy_pm2.yml`, `ecosystem.config.js`, and PM2 shell scripts (`deploy-single-core.sh`, `deploy-update.sh`, `install-deploy-hook.sh`, `choose-package-manager.sh`); production docs now point at [`docker-deploy.sh`](scripts/docker-deploy.sh) and [`.github/workflows/deploy_docker.yml`](.github/workflows/deploy_docker.yml).
- **Removed stale root docs** — deleted completed migration/planning markdown (integration summaries, `refactor_plan.md`, `slim_features.md`, etc.); history remains in this changelog.
- **Removed duplicate Cursor skill** — deleted `.agents/react-doctor/` (user-level skill covers this).
- **Dev Dockerfile healthcheck** — [`Dockerfile`](Dockerfile) uses `wget -O /dev/null` (GET) like [`Dockerfile.web`](Dockerfile.web).

### Added — Bot automation env documentation

- **`.env.docker.example`** — documents `BOT_TRADING_FAILURE_THRESHOLD`, `BOT_TRADING_HALT_MINUTES`, `BOT_TRADE_LOCK_TTL_SEC`, and optional `BOT_JOB_LOCK_TTL_SEC`; replaces legacy `SUPABASE_ANON_KEY` / `NEXT_PUBLIC_SUPABASE_*` with `SUPABASE_SECRET_KEY`.
- **[`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md)** — Docker-only production guide with recommended bot env values for real trading.

### Fixed — Auto trade robustness (algo + cron)

- **Priority fee bug** — `getPriorityFeeForStrategy()` returns lamports; buy path no longer multiplies by `1e9` twice (was causing astronomical fees on real trades).
- **Unified bot close path** — new [`src/utils/bot-position-close.ts`](src/utils/bot-position-close.ts) records sells to `trading_records` and sets tracker `status: won/lost` on full close; SL/TP monitor calls it after on-chain sells.
- **Real sell deferral** — track route skips on-chain sells when an active `sl_tp_positions` row exists (SL/TP monitor is the sole real closer; avoids double-sell races).
- **Sell metadata** — bot sells use the position's assigned `bot_strategy`, not `getCurrentBotStrategy()`.
- **SL/TP auth** — `GET /api/sl-tp-monitor` requires `TRENDING_TRACKER_SECRET`; cron passes `key=` from [`main.go`](main.go).
- **DLMM screen auth** — uses `DLMM_CONFIG.screenSecret` fallback chain (aligns with cron `DLMM_MANAGE_SECRET`).
- **DLMM manage errors** — returns HTTP 500 on failure instead of masking as `skipped: true`.
- **Job overlap locks** — [`bot_job_locks`](supabase/schema.sql) table + locks on trending track, SL/TP monitor, and DLMM manage cycles.
- **DB trade locks + circuit breaker** — [`bot_trade_locks`](supabase/schema.sql) and [`bot_trading_state`](supabase/schema.sql) prevent duplicate buys across instances; halts real trading after consecutive failures.
- **Cron timeouts** — trending track request timeout extended to 300s in [`main.go`](main.go).

### Fixed — Docker deploy health wait

- **`scripts/docker-deploy.sh`** — verifies `.next/standalone` + `.next/static` immediately after `npm run build` (fails fast on incomplete builds); recreates containers with `--force-recreate`; waits on Docker `reloadsol-web` health before curling `/api/health` (surfaces web logs on `unhealthy` instead of a blind 5-minute loop).
- **Host health URL** — resolves published port from `docker port reloadsol-web` / `WEB_PORT` in `.env` (fixes production mappings like `80:3000` where the script previously curled `:3000` forever).
- **`GET /api/health`** — explicit `HEAD` handler for Docker `wget` and in-app connectivity checks.
- **Docker healthchecks** — [`docker-compose.yml`](docker-compose.yml) and [`Dockerfile.web`](Dockerfile.web) use `wget -O /dev/null` (GET) instead of `--spider` (HEAD).

### Improved — Post-implementation hardening

- **Shared record notifications** — `afterTradingRecordInserted()` invalidates server cache (30s TTL) and broadcasts SSE for all inserts, including bot/cron paths via `insertTradingRecord`.
- **`checking` wallet session** — reconnect no longer flashes P&amp;L/History skeleton while validating an existing cookie.
- **Deduped refetch** — removed redundant client SSE notify after POST save; SSE subscriber uses invalidate-only (no double refetch).
- **Sim close proceeds** — `closeSimulationPosition()` returns `solReceived`; success modals show received SOL, not buy cost.
- **`TradeOutcomeModal`** extended to Bulk Buy/Sell and BoardTab instant buy.

### Fixed — Sim close, trade feedback, real-time records, wallet session

- **`trackOperation`** — re-throws API failures when online (no silent success); offline still caches locally. Notifies SSE subscribers after successful save.
- **`POST /api/trading/records`** — broadcasts `trade_update` to SSE clients after insert.
- **`TradingDataProvider`** — optimistic record updates on track; `staleTime` 10s + 15s refetch interval while session ready.
- **Sim close** — close records use `status: 'won'`; failures surface in UI instead of disappearing on refetch.
- **`TradeOutcomeModal`** — unified success/failure modal on PnL, LiveTab, and BoardTab (sim + live buy/sell).
- **`WalletSessionProvider`** — session cookie persists across wallet disconnect; re-sign only when session missing or wallet address changes (not every reconnect).

### Fixed — Wallet sign-in (401 on trading records)

- **Session status check** — `getWalletSessionStatus()` now uses `GET /api/auth/wallet/session` (no query) instead of broken `HEAD` + JSON parse.
- **Message signing** — uses Jupiter `useWallet().signMessage` first, with adapter fallback (`wallet-session-client.ts`).
- **`WalletSessionProvider`** — replaces silent `WalletSessionBridge`; exposes `useWalletSession()` with `signIn()` retry and error state.
- **`WalletSignInPrompt`** — visible Sign in button on History/P&amp;L when session is missing or rejected.
- **`TradingDataProvider`** — defers record fetch until `walletSessionStatus === 'ready'` (stops 401 retry spam).
- **Dev env** — ephemeral `WALLET_SESSION_SECRET` in non-production when unset; documented in `.env.docker.example`.

### Added — Trade tracking utilities

- **`src/utils/simulation-trades.ts`** — `computeOpenSimCycle()` and `closeSimulationPosition()` close sim positions using exact open-cycle token amounts (not recalculated spot prices).
- **`src/utils/trade-tracking.ts`** — shared wrappers: `trackRealBuy` / `trackRealSell` / `trackRealClose`, `trackSimBuy`, `trackSimClose`.
- **`src/utils/trading-records-db.ts`** — `insertTradingRecord()` and `buildTradingRecord()` for direct Supabase writes (server/cron paths).
- **`TrackingRecord.close_position`** — optional flag on sim sells to force-close a cycle when amounts drift.

### Fixed — History & PnL data pipeline

- **`getWalletRecords`** — re-throws `WALLET_SESSION_REQUIRED` instead of returning `[]`, so React Query retries and session errors surface correctly; still merges offline `localStorage` cache as fallback.
- **`WalletSessionBridge`** — always dispatches `reloadsol-wallet-session` after successful sign-in (fixes race where first fetch 401’d before cookie was set).
- **`TradingHistory` / `PnLTracker`** — show “Sign in to load history/P&amp;L” when wallet session is missing (not a misleading empty state).
- **`/api/trading/subscribe`** — moved from dev tier to **wallet tier** in [`api-access.ts`](src/config/api-access.ts) so all connected users get SSE record refresh.
- **`getAllRecords`** — fetch now sends `credentials: 'include'`.
- **`TradingDataProvider` / `PnLTracker` / `TradingHistory`** — use `useWalletAddress()` consistently so Jupiter adapter “connected” state matches record fetches (fixes empty History/PnL when wallet was connected but adapter `connected` was false).
- **Trading record fetches** — `credentials: 'include'` on client GETs; refetch on `reloadsol-wallet-session` after wallet sign-in completes.

### Fixed — Simulation trade close

- **`PnLTracker`** — Fast Sell and bulk **Sell** route SIM positions through `closeSimulationPosition()` (no on-chain Jupiter swap); bulk button label becomes **Close (N)** when all selected positions are sim.
- **PnL cycle math** — sim sells honor `close_position` and treat ≥99% of remaining tokens as a full close (handles float drift).
- **`BoardTab`** — `handleSimulateSell` uses shared close helper + live `records` (replaces approximate price-based sell sizing that left positions stuck open).
- **`LiveTab`** — sim buy via `trackSimBuy`; **Sim Close** button when an open sim cycle exists; real buy/sell now tracked to `/api/trading/records`.

### Changed — Route trade tracking coverage

- **`LiveTab`** — real Jupiter buy/sell calls `trackRealBuy` / `trackRealSell` after confirmed txs (previously on-chain only, no history).
- **`BoardTab`** — weighted Potential bulk buy also calls `trackOperation` (was points-only via `trackBuy`); sim buy/sell use `trade-tracking` helpers.
- **`trackBotOperation`** ([`/api/trending/track`](src/app/api/trending/track/route.ts)) — writes directly to Supabase via `insertTradingRecord()` (no wallet-cookie HTTP POST); sets `is_simulation`, `simulation_type: 'strategy'`, and correct sell `tokenAmount` from input lamports (not SOL output).

### Changed — WalletConnectGate UX

- **Non-connected layout** — two-column grid matching the buy page: **Trending Tokens** on the left, connect CTA on the right (`lg:grid-cols-3`, same as connected bulk buy).
- **Gate copy** — default title “Catch the trending token with our platform”; button **Check now** (`UniversalWalletButton` `connectLabel`).
- **Trending preview** — public GET for `/api/trending/filtered` and `/api/trending/prices`; `TrendingTokens` `preview` mode on the gate (click token → open wallet modal).
- **History/P&amp;L overlays** — gate still uses `showTrending={false}` and “Connect Wallet” label.

### Added — Deploy lockfile repair

- **`scripts/npm-ci-sync.sh`** — runs `npm ci`, and on lockfile drift runs `npm install` once then retries (fixes `Missing: tweetnacl@1.0.3 from lock file` and similar deploy failures).
- **`package.json`** — `lockfile:sync` and `install:ci` scripts; [`docker-deploy.sh`](scripts/docker-deploy.sh), [`docker-install.sh`](scripts/docker-install.sh), and [`docker-dev-entrypoint.sh`](scripts/docker-dev-entrypoint.sh) use the sync script.

### Changed — Supabase secret API keys

- **New key model** — server requires `SUPABASE_SECRET_KEY` (`sb_secret_...`); legacy `service_role` / `anon` / `NEXT_PUBLIC_SUPABASE_*` env vars removed.
- **Pure admin client** — [`src/utils/supabase.ts`](src/utils/supabase.ts) uses secret key only with `detectSessionInUrl: false` (no user JWT mixing).
- **Scripts / CI** — admin scripts and [`deploy_docker.yml`](.github/workflows/deploy_docker.yml) updated for `SUPABASE_SECRET_KEY`.

### Added — Wallet API sessions + Supabase hardening (Phase 2)

- **Wallet sign-in** — `/api/auth/wallet/session` issues an httpOnly cookie after ed25519 message signing (`WalletSessionBridge` auto-signs on connect).
- **API middleware** — [`proxy.ts`](proxy.ts) + [`src/config/api-access.ts`](src/config/api-access.ts) enforce wallet vs dev tiers on API routes; cron/webhook bearer secrets still bypass.
- **Supabase RLS** — all app tables in [`supabase/schema.sql`](supabase/schema.sql) now have RLS enabled (blocks direct PostgREST access).
- **Env** — `SUPABASE_SECRET_KEY`, `WALLET_SESSION_SECRET`, optional `WALLET_SESSION_TTL_HOURS`.

### Changed — Wallet tier access (UI)

- **Route tiers** — [`src/config/route-access.ts`](src/config/route-access.ts): wallet-required routes (`/buy`, `/sell`, `/swap`, `/history`, `/pnl`) vs dev whitelist routes (`/dev/signals`, `/dev/algo-tester`, `/dev/dlmm`).
- **`WalletConnectGate`** — blocks wallet-required pages and History/P&amp;L overlays until a Solana wallet is connected.
- **`DevRouteGate`** — centralized in [`src/app/(trade)/layout.tsx`](src/app/(trade)/layout.tsx); connect-first, then dev allowlist check. Removed per-page gates on Signals and Algo Tester.
- **DLMM** — removed hardcoded `PasswordGate`; dev wallet allowlist only (DLMM API writes still use `DLMM_API_PASSWORD`).
- **Navigation** — Swap, History, and P&amp;L visible to all users; dev tool links remain dev-wallet only.
- **Env** — `NEXT_PUBLIC_DEV_WALLETS` or `DEV_WALLETS` (comma-separated) plus built-in defaults in [`src/utils/dev-wallet.ts`](src/utils/dev-wallet.ts).

### Changed — Unified shared rug list

- **`token_rug_list`** — canonical app-wide rug registry (renamed from `dlmm_rug_list`); one list shared by DLMM, Signals, and Algo Tester.
- **Backfill migration** in [`supabase/schema.sql`](supabase/schema.sql) — copies legacy `trading_signals.label = 'rugged'` and `token_mcap_tracking.label = 'rugged'` into `token_rug_list`.
- **Shared service** — [`src/utils/rug-list/service.ts`](src/utils/rug-list/service.ts) `markTokenRug` / `unmarkTokenRug` syncs legacy labels and removes from `dlmm_potential_list`.
- **API** — canonical `GET/POST/DELETE` [`/api/rug`](src/app/api/rug/route.ts); [`/api/dlmm/rug`](src/app/api/dlmm/rug/route.ts) delegates for backward compat.
- **Server sync** — [`/api/signals`](src/app/api/signals/route.ts) and [`/api/mcap-tracking/label`](src/app/api/mcap-tracking/label/route.ts) read/write the shared rug list; Board GET merges rug-list tokens into the Rugged column.
- **Filtering** — manual rugs excluded from [`/api/trading/signals`](src/app/api/trading/signals/route.ts) feed and Board Watching/Potential columns.
- **Hook** — `useRugList` (replaces `useDlmmRugList`); Live/Board/Tracker/Signals invalidate or read unified rug state.

### Added — DLMM Potential / Rug chart actions

- **DLMM Hunter Candidates** — split into **General** (automated Hunter screen) and **Potential** (manual watchlist) tabs via `HunterCandidateTabs`.
- **`dlmm_potential_list`** — persisted watchlist; tokens added from Signals, Board, Tracker, Algo Tester, or DLMM charts.
- **`token_rug_list`** — shared exclusion list; rugged tokens hidden from DLMM General/Potential, trading signals feed, and non-Rugged board columns.
- **`DlmmChartActions`** — shared **Potential** / **Rug** toggle buttons on every chart/token row:
  - DLMM dashboard (`HunterCandidateTabs` cards)
  - Signals hub — Signals, Live, Board, Tracker tabs
  - Algo Tester — Dashboard and History tabs
- **API** — `GET/POST/DELETE` `/api/potential`, `/api/rug` (`/api/dlmm/potential` and `/api/dlmm/rug` are thin aliases).
- **Hooks** — `usePotentialList` (alias `useDlmmPotentialList`), `useRugList`, `useDlmmChartActions` (mutually exclusive: marking Potential clears Rug and vice versa).

### Added — Slim dev surfaces (Signals, Algo Tester, DLMM)

- **Signals hub** (`/dev/signals`) — four tabs via `?tab=signals|live|board|tracker`:
  - **Signals** — trading signal list, filters, floating GMGN charts (`SignalsTab`)
  - **Live** — trending sniper grid, buy/sell, Axiom risk (from catch-the-coin → `LiveTab`)
  - **Board** — kanban columns, `@dnd-kit`, weighted bulk buy on Potential, chart capture (from `/charts` → `BoardTab`)
  - **Tracker** — mcap list, filters, refetch/stop, labels (from `/dev/mcap-tracker` → `TrackerTab`)
- **Algo Tester** (`/dev/algo-tester`) — two tabs via `?tab=dashboard|history`:
  - **Dashboard** — trending win/loss stats, active tracking (from `/dev/trending-tracker`)
  - **History** — token tracking history + Chart.js (from `/dev/tracking-history`)
- **Hub shells** — `SignalsHub.tsx`, `AlgoTesterHub.tsx` with URL-driven tabs and lazy-loaded tab bodies (`next/dynamic`).
- **Shared Signals primitives** under `src/components/signals/shared/`:
  - `parseAddresses.ts` / `boardTabUrl()` — deep links to Board tab with `?addresses=`
  - `GmgnChartEmbed.tsx` — unified GMGN kline iframe
  - `TokenLabelActions.tsx` — rugged / potential / watching label buttons (extracted; wiring in tabs is incremental)
- **`DevRouteGate`** — dev-wallet check on `/dev/*` routes via trade layout (replaces per-page gates and DLMM password gate).
- **`slim_features.md`** — plan + checklist for the dev-route consolidation.

### Added — Next.js 16 migration

- **Next.js 16.1.7** and **React 19** (Node `>=20.9.0`).
- **`eslint.config.mjs`** — ESLint 9 flat config (replaces `next lint`).
- **`proxy.ts`** — request boundary for slim-route redirects (query-aware `/charts?addresses=`), API CORS, and forwarded headers (Next.js 16 replacement for `middleware.ts`).

### Changed — Slim dev consolidation

- **Dev navigation** — reduced to three tools: Signals, Algo Tester, DLMM (desktop + mobile); removed catch-the-coin, charts, trending-tracker, tracking-history, mcap-tracker, pools, pools-test from nav.
- **Route redirects** (single source: `proxy.ts`; `next.config.js` `redirects()` cleared to avoid duplication):

  | Old route | New destination |
  |-----------|-----------------|
  | `/catch-the-coin` | `/dev/signals?tab=live` |
  | `/charts` | `/dev/signals?tab=board` (preserves `?addresses=`) |
  | `/dev/mcap-tracker` | `/dev/signals?tab=tracker` |
  | `/dev/trending-tracker` | `/dev/algo-tester` |
  | `/dev/tracking-history` | `/dev/algo-tester?tab=history` |
  | `/dev/pools` | `/dev/dlmm` |
  | `/dev/pools-test` | `/dev/algo-tester` |

- **Deleted page routes** (logic moved into tab components): `catch-the-coin`, `charts`, `dev/mcap-tracker`, `dev/trending-tracker`, `dev/tracking-history`.
- **Backward-compat re-exports** — `TradingSignals.tsx` → `SignalsTab`; `CatchTheCoinClient.tsx` → `LiveTab`.
- **Cross-tab links** — “Open in Board” uses `/dev/signals?tab=board&addresses=...` from Live, Tracker, and Algo Dashboard.
- **Tab state** — visited Signals/Algo tabs stay mounted (hidden) so filters and scroll persist across tab switches.
- **README** — dev dashboard table updated to the three-surface model.

### Changed — Slim dev improvements (post-merge)

- **BoardTab** — restored weighted “Buy All (Weighted)” UI on the Potential column (`DroppableColumn`).
- **LiveTab** — consolidated duplicate 5s polling into one auto-update loop; removed dead `fetchBuyQuotes`.
- **TrackerTab** — slimmed (~3.6k → ~2.5k LOC): removed toast alerts, 30-day summary, daily ranking viz, growth histograms, and per-row GMGN iframes; kept paginated list, refetch/stop, labels, compact PnL cards.
- **Layout** — removed nested `min-h-screen` and duplicate `<h1>` titles inside tab bodies (Board, Algo Dashboard, History, Tracker, Live).
- **GmgnChartEmbed** — adopted in Board, Signals, and Live tabs (consistent `gmgn.cc/kline` embeds).
- **Orphan pages** — `/dev/pools` and `/dev/pools-test` remain reachable but redirect via proxy; duplicate `NavigationTabs` removed from those pages.

### Changed — Next.js 16 migration

- **`middleware.ts` → `proxy.ts`** — renamed export `middleware` → `proxy` per Next.js 16 convention.
- **Async route params** — `params` / `searchParams` treated as Promises where required (e.g. blog slug, DLMM position API).
- **`next.config.js`**:
  - `images.remotePatterns` (replaces deprecated `domains`)
  - `turbopack.resolveAlias` for Solana/crypto browser polyfills
  - `outputFileTracingRoot`, `serverExternalPackages: ['puppeteer']`
  - Production build uses **`--webpack`** (Turbopack prod build fails on some Solana/DLMM modules)
- **Scripts** — `dev` and `build` default to `--webpack`.

### Fixed — Next.js 16 / dev stability

- **Dev hydration / reload loop** — scripts moved into `<body>` via `next/script`; `suppressHydrationWarning` on root layout.
- **`WalletProvider`** — stable `WALLET_APP_URL` metadata (no `window.location.origin`); memoized wallet config.
- **`HomePageClient`** — `router.replace('/sell')` with ref guard instead of `window.location.href`.
- **`LastReloadTracker`** — graceful handling of 500 from last-reload API.
- **`TradingDataProvider`** — corrected `/api/solprice` fetch path.
- **`/api/trending/track`** — replaced removed `request.ip` with header-based client IP.

### Unchanged (by design)

- Core trading routes: `/buy`, `/sell`, `/swap`, `/pnl`, `/history`
- Backend APIs: `/api/mcap-tracking/*`, `/api/trading/signals`, `/api/trending/*`, `/api/dlmm/*`
- Standalone chart deep link: `/chart/[tokenAddress]`
- DLMM dashboard behavior and all `/api/dlmm/*` routes

---

## Prior releases (wallet, Docker, DLMM)

### Added

- **Jupiter Universal Wallet Kit** — wallet connectivity via [`@jup-ag/wallet-adapter`](https://developers.jup.ag/docs/tool-kits/wallet-kit), supporting 20+ Solana wallets through Wallet Standard auto-discovery (Phantom, Solflare, Backpack, Jupiter Wallet Extension, mobile QR, and more).
- **`UniversalWalletButton`** — connect/disconnect UI that opens Jupiter’s unified wallet picker modal.
- **`WalletNotification`** — lightweight toast feedback for connect, disconnect, and install prompts.
- **DLMM Agent Dashboard** (`/dev/dlmm`) — Hunter screener + Healer position manager for Meteora DLMM pools, with deploy/edit/close, dry-run mode, decision feed, and Telegram bot integration.
- **Docker stack** — one-command local and production deployment for Next.js web + Go cron (`npm run docker:up`, `docker:dev`, `docker:prod`); always runs `npm ci` before build/start.
- **DLMM cron jobs** — automated pool screening (5m) and position management (60s) via `main.go`.
- **`.env.docker.example`** — documented env template for Docker and DLMM agent configuration.
- **`supabase/schema.sql`** — single consolidated Supabase schema (all app tables; removed unused `dlmm_pool_snapshots`).
- **README** — full setup guide from git clone, Docker, Supabase, env vars, dashboards, and troubleshooting.

### Changed

- **Dependencies** — wallet stack trimmed to `@jup-ag/wallet-adapter` only; removed direct `@solana/wallet-adapter-react`, `@emotion/*`, `styled-components`, and legacy `@solana/wallet-adapter-wallets` / `react-ui` (eliminates blocked `xrpl` on Tencent mirrors). `.npmrc` uses `registry.npmjs.org` + `legacy-peer-deps=true`.
- **RPC provider** — all Solana RPC calls now use **Shyft** via `SHYFT_API_KEY` / `RPC_URL` (`src/utils/rpc-urls.ts`). Removed `HELIUS_API_KEY` and Helius Sender from `/api/buy`.
- **`WalletProvider`** — replaced Phantom-only `window.solana` injection with Jupiter `UnifiedWalletProvider`; existing `useWallet()` / `useConnection()` hooks remain compatible across the app.
- **`PhantomWalletButton`** — now re-exports `UniversalWalletButton` for backward compatibility.
- **Jupiter Terminal** — continues to use wallet passthrough with the unified adapter context.
- **`next.config.js`** — added `output: 'standalone'` for Docker, `transpilePackages` for `@jup-ag/wallet-adapter`, and `styledComponents` compiler support.
- **`Dockerfile`** — switched to `npm ci` for reproducible installs.

### Fixed

- Docker web image OOM during in-container `next build` — host-build path via `Dockerfile.web` packages pre-built `.next/standalone`.
- Removed duplicate nested `WalletProvider` wrappers in `HomePageClient` and `SwapPageClient`.
- DLMM dashboard/cron errors when Supabase is unreachable — graceful fallbacks, setup banner on `/dev/dlmm`, `/api/dlmm/health`, and cron manage returns 200 (skipped) instead of 500.
- Supabase schema script fails on existing DBs — `label` and `waiting_started_at` indexes moved after column patches.

---

## Migration notes

### Bookmark / link updates

If you bookmarked old dev URLs, use the redirects above or navigate directly:

- Live sniper → `/dev/signals?tab=live`
- Chart kanban → `/dev/signals?tab=board` (optional `&addresses=mint1,mint2`)
- MCap admin → `/dev/signals?tab=tracker`
- Trending algo → `/dev/algo-tester`
- Tracking history → `/dev/algo-tester?tab=history`

### Wallet session required for History / PnL

After Phase 2, `/api/trading/records` requires a wallet API session (httpOnly cookie from `POST /api/auth/wallet/session`). Ensure `WALLET_SESSION_SECRET` is set in production. Users must approve the sign-message prompt once after connecting; without it, History and P&amp;L show a sign-in prompt rather than data.

Sim positions are closed from P&amp;L via **Close** (not on-chain sell). Use **Sim Close** on Live tab or Board simulate sell for the same behavior.

### Build & verify

```bash
pnpm type-check
pnpm build --webpack
pnpm dev   # uses webpack dev server
```

### Docs still referencing old routes

Some files under `docs/` may still mention deleted paths (`/catch-the-coin`, `/dev/trending-tracker`, etc.). Prefer this changelog and `README.md` for current routing.
