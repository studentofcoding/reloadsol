# Changelog

All notable changes to ReloadSOL are documented in this file.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

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

### Fixed — TrackerTab display & analytics

- **Timestamps** — First Seen, milestones (+80% / +120% / +200% labels), Last Updated, Finished At use `formatAppDateTime` (absolute + relative subtitle).
- **Analytics accordion** — risk on 0–100 scale (fixes 8000% display bug); Z-Score shows `—` when cohort too small; liquidity via Vol/MCap; momentum strength `(strength ?? 0) * 100`.
- **Chart button** — opens `ChartBuyModal` (works on finished tokens); separate mcap refetch button.
- **CSV export** — milestone columns + formatted dates.
- **Timeline badge** — warns when `first_seen_at` is still after a milestone post-normalize.

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
- **API** — `GET/POST/DELETE` `/api/dlmm/potential`, `/api/rug`, and `/api/dlmm/rug` (alias).
- **Hooks** — `useDlmmPotentialList`, `useRugList`, `useDlmmChartActions` (mutually exclusive: marking Potential clears Rug and vice versa).

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
