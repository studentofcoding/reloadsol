# Strategies & Automation

> **Diagram:** [Strategy engine spine](./diagrams/04-strategy-engine.html).

Single entry doc for what ReloadSOL calls "strategies": the automated monitoring / paper-trading workers that watch markets, wallets and social channels, then **alert** (Telegram / Discord / UI toasts) or **act** (open / manage / close sim or live positions). Primary source: `src/` + `main.go` + `worker_tracker.go` (code wins when docs disagree). Related: [algo_overview.md](./algo_overview.md), [STRATEGY_ARCHITECTURE.md](./STRATEGY_ARCHITECTURE.md), [GMGN_STRATEGY.md](./GMGN_STRATEGY.md), [ARCHITECTURE_SUMMARY.md](./ARCHITECTURE_SUMMARY.md). Legacy/historical only: [ReloadSOL_Algo_Strategy.md](./_archive/ReloadSOL_Algo_Strategy.md) — an old pre-Phase-2 plan; its `trades`/Supabase references are stale and not current code.

## 1. What a "strategy" is

A strategy is a **definition row + one or more workers** that apply it:

- **Config**: a typed registry default (`src/strategies/registry.ts`) merged with DB overrides from `strategy_definitions` (see `src/strategies/merge.ts`, `mergeStrategyOverride`; per-domain `load-*.ts` / `merge-*.ts`, e.g. `load-strategy.ts`, `load-mcap-tracker.ts`, `load-gmgn.ts`, `load-signals.ts`, `load-dlmm.ts`, `load-social.ts`). Every definition carries `domain`, `config` JSONB, `execution_mode` (`sim_only` | `live_only` | `ab_parallel`) and `is_active`. Schema: `db/init/02-schema.sql` (`strategy_definitions`, `strategy_outcomes`, `bot_job_locks`, `bot_trade_locks`, `bot_trading_state`).
- **Worker**: a Go cron tick (registered in `main.go` `Start()`, declared in `worker_tracker.go` `initWorkerRegistry()`) that calls a Next.js API route. The Go service is container/binary **`reloadsol-cron`** (repo-root `main.go`); the `reloadsol-cron` file at repo root is the compiled Mach-O binary, not a source directory.
- **Outcome**: a `strategy_outcomes` row is written **only when a position fully closes** (see §3) — never on open/hold (`src/strategies/outcomes.ts`).
- **State / safety tables** (Postgres `reloadsol_db`, `db/init/02-schema.sql`):
  - `strategy_definitions` — DB-tunable config overrides + `is_active` + `execution_mode` + `domain` (per chain via `db/init/24-strategy-chain.sql`).
  - `strategy_outcomes` — closed results: `strategy_id`, `domain`, `token_address`, `entry_at`, `exit_at`, `pnl_pct`, `status`, `is_simulated`, `features` (JSONB entry snapshot + ML labels).
  - `bot_job_locks` — per-job lock (`job_name` PK, `expires_at`) preventing overlapping cron/API runs across instances (`src/utils/bot-job-lock.ts`).
  - `bot_trade_locks` — per token+strategy short lock preventing duplicate concurrent buys (`src/utils/bot-trading-state.ts`).
  - `bot_trading_state` — global **circuit breaker** row (`id='global'`: `consecutive_failures`, `real_trading_halted`, `halted_at`, `halt_reason`).
  - Supporting state: `sl_tp_positions` (SL/TP book), `token_mcap_tracking` (mcap tracker), `radar_alert_threads` (`db/init/13`), `radar_digest_pins` (`db/init/14`), `mcap_social_pattern_24h` (`db/init/06`), `trading_records` (open sim/live positions with `bot_strategy` + `trading_simulation` JSONB).

### Kill switch + activation

- The per-strategy **`enabled` / `is_active`** flag is the kill switch. `/dev/strategies` Activate/Deactivate toggles `is_active` and syncs `config.notify.telegram`/`ui` through `notifySyncForActive` (`src/strategies/strategy-notify.ts`); PATCH handler in `src/app/api/strategies/[id]/route.ts` preserves/deep-merges `config` (since Jul 2026, activating no longer wipes params).
- **`enabled=false` config-flag early-return behavior** — sub-gates short-circuit when a config flag is `false`:
  - Filtering: `src/strategies/trending-track/filtering.ts` `performEnhancedFiltering()` → `if (!filterConfig.enabled) { … accept all … }`. The union pre-filter in `src/strategies/merge.ts` `mergeFiltersUnion()` drops strategies whose `filtering.enabled === false`; if none remain it returns `{ enabled: false }` (all tokens bypass).
  - Security gate: `src/strategies/gmgn-security-gate.ts` → `if (!config.enabled) return { pass: true, verdict: 'clean', … }` (the global concentration hard-ban still runs first).
  - Radar comeback: `src/strategies/gmgn-radar-comeback.ts` → `if (!config.enabled) return { isDead:false … }` / `{ isComeback:false … }`.
  - DLMM agent: `enabled` on `dlmm_agent_config` (env `DLMM_AGENT_ENABLED`) makes `dlmm_manage` (`src/utils/dlmm/manager.ts`) and `dlmm_sim-track` (`src/app/api/dlmm/sim-track/route.ts`) return `skipped` immediately; PATCH syncs it from `is_active` (`agentPatch.enabled`).
- **No active strategies ⇒ no entries**: `load-strategy.ts` `getActiveStrategiesWithState()` logs "No active trending strategies — skipping new entries" for an empty set; `gmgn_roster_watch` returns `strategy inactive` unless `gmgn_roster_concurrence` is active (`src/strategies/wallet-digger/watch.ts`); Radar Telegram only runs when ≥1 GMGN strategy is active (`GMGN_STRATEGY.md`, `isAnyGmgnRadarStrategyActive` in `src/strategies/load-gmgn.ts`); `getActiveDlmmForSim()` returns null unless `dlmm_default` is active + sim/ab_parallel (`src/strategies/load-dlmm.ts`).
- **Deactivate closes open positions**: on `PATCH` flipping a strategy to `is_active:false`, `closeIfDeactivating()` calls `closeOpenPositionsForStrategy()` (`src/app/api/strategies/[id]/route.ts`, `src/strategies/close-on-deactivate.ts`): force-closes live `sl_tp_positions`, closes trending-tracker sim holdings via `finalizeBotPositionClose`, closes price-domain sim wallets (`signals-sim`/`gmgn-sim`/`social-sim` via `closePriceDomainOpens`), closes DLMM positions via `removePosition`. Final closes carry `close_reason:'strategy_deactivated'` and full-close outcomes are recorded. Partial failure does not roll back the inactive flag.

### Re-entry / cooldown guards keyed on `strategy_outcomes`

Cooldowns are per-token and env-tunable (defaults shown):

| Guard | Mechanism | Default |
|---|---|---|
| MCap sim one-shot | a mint is blocked once any `strategy_outcomes` row exists for that `strategy_id`+mint — `loadMcapSimClosedOutcomeKeys` (`src/strategies/db.ts`) → `already_closed` skip in `getMcapSimOpenSkipReason` (`src/utils/mcap-sim-track.ts`) | 1× per strategy+mint |
| DLMM reopen cooldown | `loadRecentlyClosedDlmmOutcomes()` (`src/strategies/outcomes.ts`) feeds `reopen-guard.ts`; skips a pool/token closed within the window | `DLMM_REOPEN_COOLDOWN_MIN=60`, `DLMM_REOPEN_TOKEN_COOLDOWN_MIN=1440` |
| GMGN discovery cooldown | `config.discovery.cooldownHours` filters recent sim records per strategy (`collectRecentMints` in `src/app/api/gmgn/sim-track/route.ts`; `filterGmgnCandidatesByCooldown` in `src/strategies/gmgn-pipeline.ts`) | 24h (roster 6h) |
| Trending duplicate purchase | `TOKEN_PURCHASE_COOLDOWN_HOURS` / `MAX_PURCHASES_PER_TOKEN` (env) + `bot_trade_locks` (`src/strategies/trending-track/constants.ts`, `wallet.ts`) | 24h / 2 buys |

## 2. Worker / strategy inventory

Go cron (`main.go`) fires each worker; each row: what it tracks → action/alert → cadence (env override) → primary files. Outcomes funnel through `src/strategies/outcomes.ts`.

| Worker (Go ID) | Tracks | Action / alert | Cadence (env) | Files |
|---|---|---|---|---|
| `trending_tracker` | Jupiter 1h trending (`toptrending/1h`) | Union pre-filter across active trending strategies → `assignTokenToStrategy` → sim/real buy (TP/SL per strategy); full-close → `recordTrendingBotOutcome` | 5m | `main.go`, `src/strategies/trending-track/cycle.ts`, `filtering.ts`, `wallet.ts`, `src/app/api/trending/track/route.ts`, `registry.ts` |
| `filtered_trending` / `unfiltered_trending` | same feed, filtered / raw | Discord list notifications (dedup slots) + mcap bulk-track snapshots; keeps "hot list" dashboards warm | 2m | `src/app/api/trending/filtered/route.ts`, `src/app/api/trending/route.ts`, `src/utils/trending-notification-dedup.ts` |
| `signals_refresh` | signals scoring data | warms `GET /api/trading/signals`; powers Stage-1 Early Enter scoring | 60s | `main.go runSignalRefresh`, `src/app/api/trading/signals/route.ts` |
| `signals_sim_track` | mcap-tracking candidates scored per signals strategy | paper buys/sells on `signals-sim` wallet; full close → `recordSignalsOutcome` + Telegram CLOSE | 120s | `src/app/api/signals/sim-track/route.ts`, `src/strategies/signals-pipeline.ts`, `signals-scoring.ts`, `telegram-alpha-sim.ts` |
| Signals board / live / tracker (UI) | watch/potential/rugged labels, Live/Board tabs | sim or live buys tagged `bot_strategy`; close via `POST /api/trading/records` → `maybeRecordSignalsOutcome` | user-driven | `src/app/api/signals/route.ts`, `src/components/signals/LiveTab.tsx`, `BoardTab.tsx`, `src/utils/simulation-trades.ts` |
| Signals crosscheck | Telegram signal-channel messages with price fields | parse alert → compare live price within tolerance → optional `signals_*` sim open; writes `signal_price_crosscheck` | event-driven (Telethon) | `src/strategies/social/run-crosscheck.ts`, `parse-telegram-alert.ts`, `crosscheck-db.ts`, `src/app/api/social/crosscheck/route.ts` |
| `mcap_tracker_sim_open` | `token_mcap_tracking` snapshots (entry phase) | entry templates `first_seen` / `milestone_80` → L1 rules → social gate → ML1/Pattern shadow → paper open; Stage-2 copy-trade alert (`sendMcapSimManualTradeAlert` + toast) | 15s, `phase=open` | `src/app/api/mcap-tracking/sim-track/route.ts`, `src/utils/mcap-sim-track.ts`, `src/strategies/mcap-sim-open-alerts.ts` |
| `mcap_tracker_sim_track` | open mcap sims (manage phase) | exit by SL/TP/max-hold + drop stamps → full close → `recordMcapTrackerOutcome` | 120s, `phase=manage` | same as above + `src/strategies/outcomes.ts` |
| `sltp_monitor` | `sl_tp_positions` (manual + bot live) | server-side SL/TP sells (Jupiter Lite + keypair), Discord summary of triggers | 60s | `main.go runSLTPMonitor`, `src/utils/sl-tp-tracker.ts`, `src/app/api/sl-tp-monitor/route.ts` |
| `dlmm_screen` (Hunter) | Meteora DLMM pools | score pools → `dlmm_candidates`; Telegram candidate alert | 300s | `src/app/api/dlmm/screen/route.ts`, `src/utils/dlmm/screener.ts` |
| `dlmm_sim_track` | top candidates | auto paper-deploy in `dry_run` only, with outcome-keyed reopen cooldowns | 300s | `src/app/api/dlmm/sim-track/route.ts`, `src/utils/dlmm/reopen-guard.ts` |
| `dlmm_manage` (Healer) | open / out-of-range / pending positions | reasoner per position: keep in-range or close (TP 5% / SL -10% / OOR 16m) → `sendDlmmDecisionAlert` → close → `recordDlmmOutcome` (+ backfill) | 60s | `src/app/api/dlmm/manage/route.ts`, `src/utils/dlmm/manager.ts`, `reasoner.ts`, `actions.ts` |
| `rh_clmm_manage` | Robinhood CLMM v3/v4 positions (DB ledger) | **alert-only**: RPC reads OOR + claimable fees via Multicall3 → Telegram OOR / fee alerts; no signing, no writes | 300s | `src/app/api/dlmm/rh-clmm-manage/route.ts`, `src/utils/dlmm/rh-clmm-manage.server.ts`, `rh-clmm-manage-alerts.ts` |
| `gmgn_activity_poll` | GMGN smart-money + KOL buys (60m activity) | score hot tokens (≥ `GMGN_ACTIVITY_SCORE_THRESHOLD` 50) → 2h Radar accumulator → Radar ENTER/WATCH/SKIP → single-thread Telegram lifecycle cards (NEW/TRACKING/SURGE/FADING) + sticky/dump/comeback → social events ingest | 180s | `src/app/api/gmgn/activity-poll/route.ts`, `src/strategies/gmgn-activity-score.ts`, `gmgn-radar-accumulate.ts`, `gmgn-radar-review.ts`, `gmgn-radar-price.ts`, `gmgn-radar-thread-sync.ts`, `gmgn-radar-dump.ts`, `gmgn-radar-comeback.ts` |
| `gmgn_sim_track` | score-sorted SM/KOL discovery (wallet follow) | security gate (`clean` only) → same Radar accumulator → paper open/close on `gmgn-sim` → `recordGmgnOutcome`; live stub behind `GMGN_PRIVATE_KEY` (`gmgn-execution.ts`) | 120s | `src/app/api/gmgn/sim-track/route.ts`, `src/strategies/gmgn-pipeline.ts`, `gmgn-open-sim.ts`, `gmgn-execution.ts` |
| `gmgn_radar_digest` | closed sim+live outcomes per **active** strategy | pinned 24h Strategy-PnL leaderboard (top 8 by realized `pnl_pct`), state `radar_digest_pins` | 86400s (0=off) | `src/app/api/gmgn/radar-digest/route.ts`, `src/strategies/gmgn-radar-digest.ts`, `gmgn-radar-digest-db.ts` |
| `gmgn_wallet_digger` | roster candidate wallets | dig wallet stats / portfolio edge → upsert roster candidates; feeds `gmgn_roster_concurrence` | 14400s | `src/app/api/gmgn/wallet-digger/route.ts`, `src/strategies/wallet-digger/digger.ts`, `portfolio-edge.ts`, `defaults.ts` |
| `gmgn_roster_watch` | dug-roster wallets (concurrence) | alert + sim when ≥4 roster wallets buy the same fresh mint within 15m (bands per chain) | 75s | `src/app/api/gmgn/roster-watch/route.ts`, `src/strategies/wallet-digger/watch.ts`, `concurrence.ts` |
| `social_sim_track` | social-only rollup candidates (FOMO >7 mentions 30m) | paper trades for `social_only_fomo_gt7` on `social-sim`; full close → `recordSocialOutcome` | 90s | `src/app/api/social/sim-track/route.ts`, `src/strategies/social/social-only-discovery.ts` |
| `social_rollup` | `social_token_events` | refresh `social_token_rollups` + `mcap_social_pattern_24h` (24h winner ≥120% / loser <80% cohorts for Pattern ML) | 300s | `src/app/api/social/rollup/route.ts`, `src/strategies/social/db.ts`, `social/mcap-patterns-24h.ts` |
| `social_wallet_poll` | tracked wallets (Shyft holdings) | poll each wallet → new holdings become `wallet_buy` events (source `tracked_wallet_poll`) | 300s | `src/app/api/social/wallet-poll/route.ts`, `src/utils/social/wallet-poll.ts`, `src/strategies/social/db.ts` |
| `social_cleanup` | stale social events | TTL cleanup | 30m | `src/app/api/social/cleanup/route.ts` |
| social ingest (Telethon) | Telegram channels | `social-ingest/main.py` listens → extracts CAs → `POST /api/social/ingest` (`mention` / `wallet_buy` events); crosscheck messages → `/api/social/crosscheck` | live event + 60s listen-config poll | `social-ingest/main.py`, `parsers.py`, `alert_parser.py`, `src/app/api/social/ingest/route.ts` |
| `sol_arb_scan` | SOL→A→B→SOL triangular arb pairs | scan curated pairs; Telegram alert when net edge ≥ `SOL_ARB_MIN_EDGE_LAMPORTS`; `/api/sol-arb/execute` gated by `SOL_ARB_LIVE_ENABLED` | 60s (0=off) | `main.go`, `src/app/api/sol-arb/scan/route.ts`, `src/utils/sol-arb/`, `docs/sol_arbitrations.md` |
| `strategy_report` | all closed strategy outcomes | strategy report digest (Telegram/Discord) incl. best-trade windows + ranking | 86400s (0=off) | `src/app/api/strategies/report-digest/route.ts`, `src/strategies/report-notify.ts`, `best-trade-windows.ts` |
| `pnl_update` | all wallet trading records | recompute wallet PnL into `token_operations` | daily 02:00 UTC | `main.go runPnLUpdate`, `src/app/api/pnl/update/route.ts` |
| `daily_summary` | trending tracker history | daily summary stats | daily 00:00 UTC | `main.go`, `src/app/api/trending/summary/route.ts` |

### Strategy definitions (registry + seeds)

| Strategy id | Domain | Default | Key params |
|---|---|---|---|
| `att` / `att_rh` | trending_bot | active (sim_only; RH twin sim_only) | TP1 45% sell 90%, TP2 100%, SL -35%, max 24h, buy 0.035 SOL (RH 0.0015 ETH) |
| `lowcap_moonbag` | trending_bot | active | mcap 35k–90k; TP 200/400/600%, SL -30%, 12h, 0.008 SOL |
| `scalper` / `hodl` | trending_bot | inactive | dip/breakout variants (registry seeds) |
| `signals_default` / `signals_default_rh` | signals | active | template `default`, `enterScoreFloor` 50, recency 240m |
| `signals_sell_over_100` | signals | active | template `sell_over_100`; exits at mcap ≥100% (PnL at close uses live price) |
| `mcap_enter_first_seen` (+ `_rh`) | mcap_tracker | active | `first_seen` baseline, mcap 30k–2M, SL -50%, TP 200%, 96h |
| `mcap_enter_at_80` (+ `_rh`) | mcap_tracker | active (primary thesis) | `milestone_80`; fill = live `current_mcap` at open |
| `dlmm_default` | dlmm | active | min TVL 50k, fee/TVL 0.1, TP 5%, SL -10%, OOR 16m |
| `gmgn_smartmoney_default`, `gmgn_kol_momentum`, `gmgn_sm_kol_combined`, RH twins, `gmgn_roster_concurrence` | gmgn | inactive by default (sim_only) | security gate `clean` only; `config.radar`; roster bands |
| `social_only_fomo_gt7` | social | active | FOMO mentions >7 / 30m on TRENDINGSSOL |

Full typed defaults incl. RH twins: `src/strategies/registry.ts`; seeds + later GMGN/social inserts: `db/init/02-schema.sql`, `10`, `11`, `15`.

## 3. Execution shapes

### Sim vs real

Both paths share the same decision pipeline (`StrategyParameterSet` + `CanonicalEntryFeatures`, engine spine in `src/strategies/canonical-params.ts` / `canonical-features.ts`); they differ only in the wallet + write layer:

- **Sim**: paper buys/sells written to `trading_records` with `is_simulation:true`, `simulation_type:'strategy'`, `bot_strategy:<id>`; wallet = domain sim wallet (`signals-sim`, `gmgn-sim`, `social-sim`, `mcap-tracker-sim`; RH twins via `simWalletForChain` in `src/strategies/sim-wallets.ts`). Exit prices come from live token/mcap fetches.
- **Real**: on-chain swaps via server keypair (`TRADING_KEYPAIR_JSON`) / bound GMGN wallet; opens are gated by the circuit breaker, `bot_trade_locks`, balance / `MAX_SOL_AT_RISK` / `MIN_SOL_BALANCE`, and duplicate checks (`src/strategies/trending-track/wallet.ts`, `src/app/api/mcap-tracking/sim-track/route.ts` live branch). Robinhood has no live server path yet — all RH definitions stay `sim_only` (`resolveMcapExecutionMode('sim_only', false)` when `chain==='robinhood'`).

`execution_mode` semantics: `sim_only` (paper only; included in sim workers), `live_only` (real only; skipped by sim workers), `ab_parallel` (both; Reports tab shows A/B pairs for signals/DLMM only — trending bot is excluded from dual-buy).

### strategy_outcomes recording

Written **only on full close** (partial TP sells do not record until 100% closed):

- Signals sim: in `POST /api/signals/sim-track`; signals UI sim/live: `maybeRecordSignalsOutcome` in `POST /api/trading/records`
- Trending bot: `finalizeBotPositionClose` when `isFullClose === true`
- MCap tracker: `recordMcapTrackerOutcome` on sim close
- DLMM: `recordDlmmOutcome` in dlmm actions + backfill `syncMissingDlmmOutcomesFromPositions`
- GMGN / social: `recordGmgnOutcome` / `recordSocialOutcome` on close

Columns: `strategy_id`, `domain`, `token_address`, `entry_at`, `exit_at`, `pnl_pct`, `status`, `is_simulated`, `features` (entry-feature snapshot + ML shadow labels: `ml_gate_*`, `ml_pattern_*`, `ml_label`/`ml_condition` via Reports review modal). API: `GET /api/strategies/outcomes`, `PATCH /api/strategies/outcomes/[id]`. Outcomes feed ML export/training (`ml/`), Reports, the strategy digest, and the reopen-cooldown guards.

### Close alerts: exit/current values, not entry

`notifyStrategyClose` (`src/strategies/strategy-telegram-notify.ts`) reads features with `{ preferExit:true }` so the Telegram card's market-cap line uses `market_cap`/`exit_mcap`/`current_mcap` before falling back to `entry_mcap`. The CLOSE card (`buildStrategyAlertText`, `src/utils/telegram.ts`) shows `Market Cap: <exit>`, `PnL: ±x%`, `Result: <status>` and a 🟢/🔴 title from the `won`/`lost` status. OPEN cards show entry mcap (plus live mcap when it differs).

### WON / LOST semantics

`status` defaults to `pnl_pct >= 0 ? 'won' : 'lost'` — derived from realized PnL at close, not from which rule fired (`src/strategies/strategy-telegram-notify.ts`; DLMM backfill `outcomes.ts`; gmgn sim close sets `status: pnlPct >= 0 ? 'won' : 'lost'` in `src/app/api/gmgn/sim-track/route.ts`). Caveat: `signals_sell_over_100` prices PnL at close with live token price (not mcap growth), so rugged tokens can close ~-97% even when the mcap ≥100% exit rule triggered.

### Circuit breaker (`bot_trading_state`)

`src/utils/bot-trading-state.ts`: a `global` row accumulates `consecutive_failures` (`recordTradingFailure`), flips `real_trading_halted=true` + `halt_reason` after `BOT_TRADING_FAILURE_THRESHOLD` (5) consecutive failures, auto-resets after `BOT_TRADING_HALT_MINUTES` (30) or on `recordTradingSuccess`. `isRealTradingHalted()` is checked before every live open (`wallet.ts`, mcap sim-track live branch). Sim workers are **not** halted by it. DLMM pause is a separate Telegram `/pause` on `dlmm_agent_config.enabled`, not unified. Separate infra circuit: `isDbCircuitOpen()` (`src/utils/db-health.ts`) makes job/trade locks skip cleanly while the DB is unhealthy.

### Re-entry & ML shadow gates on entry

MCap sim entry pipeline (open phase): candidate → L1 rules (`mcap-sim-track.ts`) → social L1 gate (`social-snapshot.ts`) → **sim-outcome ML gate shadow** (`entry-ml-scorer.server.ts`) → **Pattern ML shadow** (`entry-pattern-scorer.server.ts`) → paper buy. `attachMlEntryShadow` (`src/strategies/ml-entry-shadow.ts`) merges `ml_gate_*` / `ml_pattern_*` into `entry_features`; both models are shadow-only until `*_ready` meta flags are true (`ML_GATE_MODE`, `ML_PATTERN_MODE` env; `pattern_ready` needs macro-F1 ≥ 0.60). Skip reasons (`ml_gate_reject`, `ml_pattern_reject`) are logged as counterfactuals, and mcap sim enforces when flags demand it; other domains log-only.

## 3b. Domains at a glance

| Domain | Discovery input | UI | Outcome writer | Notes |
|---|---|---|---|---|
| trending_bot | Jupiter trending feed | `/dev/algo-tester`, `/dev/strategies` | `recordTrendingBotOutcome` | 4 strategies; registry floor 200k mcap; RH twin sim-only |
| signals | `token_mcap_tracking` + scoring | `/dev/signals` (board/live/tracker) | `recordSignalsOutcome` | `signals_default` + `signals_sell_over_100` |
| mcap_tracker | mcap snapshots + milestones | mcap tracker UI, `/dev/strategies` | `recordMcapTrackerOutcome` | `first_seen` / `milestone_80` templates |
| dlmm | Meteora pools | `/dev/dlmm` | `recordDlmmOutcome` | hunter (screen) + healer (manage); separate agent pause |
| rh clmm | RH CLMM ledger (v3/v4) | `/dev/dlmm` RH tabs | ledger rows (live outcomes pending) | `rh_clmm_manage` alert-only |
| gmgn | GMGN smart-money/KOL/roster | `/dev/strategies` (Radar knobs) | `recordGmgnOutcome` | sim-only default; Radar Telegram loop |
| social | Telegram events + rollups | `/dev/social` | `recordSocialOutcome` | `social_only_fomo_gt7` |
| arb | curated SOL pairs | `/dev/arbitrage` | — (alert/execute, no strategy domain) | `sol_arb_scan` |

Chain split: definitions and sim wallets are per `chain` (`sol` | `robinhood`); sim tracking loops both `STRATEGY_CHAINS` per tick (mcap sim-track iterates `for (const chain of STRATEGY_CHAINS)`).

## 3c. Admin & API surface

- **Admin UI `/dev/strategies`**: Config (edit params / activation / execution mode / notify toggles), Reports (coverage + outcomes + ML review + Pattern ML columns), Workers (cron health + Run now).
- **Strategy APIs**: `GET /api/strategies` (merged registry), `PATCH /api/strategies/[id]` (partial config deep-merge; deactivate ⇒ close positions; DLMM syncs `dlmm_agent_config`), `POST /api/strategies/[id]/promote` (copy winning config), `GET /api/strategies/outcomes`, `PATCH /api/strategies/outcomes/[id]` (ML label), `GET /api/strategies/reports`, `POST /api/strategies/report-digest`.
- **Workers API**: `GET /api/workers/status`, `GET /api/workers/runtime`, `POST /api/workers/trigger` (dev proxy that forwards `X-Trigger-Secret`).
- **Outcome review → ML**: rows are labeled in the Reports modal (`ml_label` skip/interesting/anomaly + optional `ml_condition`), persisted into `features`, and re-exported by `npm run ml:export` / `ml:export-patterns` for training (see [OPERATOR_STATE.md](./OPERATOR_STATE.md) data-hygiene section — "menuju 200" tracks extractable closed sims, not all rows).

## 4. Where the code lives

| Path | Contents |
|---|---|
| `main.go` + `worker_tracker.go` (repo root) | Go scheduler: cron job registrations, interval env vars, worker registry + runtime persistence, `/health`, `/status`, `/workers`, and all `/trigger/*` endpoints guarded by **`X-Trigger-Secret`** (`TRIGGER_SECRET`, falls back to `TRENDING_TRACKER_SECRET`). Compiled binary: `reloadsol-cron`. |
| `strategies/` (repo root) | **Docs only** (`RUG_SIGNAL.md`, `overview_signals.md`) — no worker TS lives here. |
| `src/strategies/` | Shared engine: `registry.ts` (defaults), `load-*.ts`/`merge-*.ts` (DB merge), `canonical-params.ts`/`canonical-features.ts` (spine), `signals-pipeline.ts`/`signals-scoring.ts` + `signals-early-alerts.ts`, `outcomes.ts` + `db.ts` (outcome writers, `loadMcapSimClosedOutcomeKeys`, `listTopPnlByActiveStrategy`), `ml-entry-shadow.ts` + `entry-ml-scorer*.ts` + `entry-pattern-scorer*.ts` (ML shadows), `close-on-deactivate.ts`, `strategy-review.ts`, `strategy-search-bandit.ts` + `domain-strategy-search.ts` (`search_*` experiment clones), `strategy-telegram-notify.ts`/`strategy-notify.ts`, `strategy-filters.ts`, `sim-wallets.ts`, `sim-monitor-snapshots.ts`, `social/` (rollups, crosscheck, parse-telegram-alert, pattern 24h, social-only-discovery), `trending-track/` (cycle/filtering/wallet/executors/schedule), `wallet-digger/` (digger/watch/concurrence/db), all `gmgn-*` radar/activity/sim/digest files, `ohlc-telegram-svg.ts`/`ohlc-telegram-paint.ts`. |
| `src/app/api/*` | HTTP surface per worker: `/api/trending/{track,filtered}`, `/api/trading/signals`, `/api/signals/{sim-track,ohlc-labels}`, `/api/mcap-tracking/sim-track` (+`sim-open-alerts`), `/api/gmgn/{sim-track,activity-poll,radar-digest,roster-watch,wallet-digger,roster}`, `/api/dlmm/{screen,sim-track,manage,rh-clmm-manage,positions,telegram,…}`, `/api/social/{ingest,ingest-listen,rollup,sim-track,wallet-poll,crosscheck,cleanup,channels,events}`, `/api/sol-arb/{scan,quote,execute,execute-atomic}`, `/api/sl-tp-monitor`, `/api/strategies/{report-digest,outcomes,[id],promote,ml/backfill-features}`, `/api/pnl/update`, `/api/trading/records`, `/api/workers/{status,trigger,runtime}`. |
| `src/utils/` | Execution & domain helpers: `bot-trading-state.ts`, `bot-job-lock.ts`, `dlmm/` (manager/reasoner/actions/screener/reopen-guard/rh-clmm-*), `mcap-sim-track.ts`, `mcap-tracker.ts`, `simulation-trades.ts`, `trading-records-db.ts`, `social/wallet-poll.ts`, `social/config.ts`, `telegram.ts` (alert builders; `isStrategyTrackTelegramEnabled()` global switch on `STRATEGY_TRACK_TELEGRAM_ENABLED`), `sl-tp-tracker.ts`, `db-health.ts`. |
| `social-ingest/` | Python Telethon sidecar: `main.py` (listeners, event building, `POST /api/social/ingest` + `/api/social/crosscheck`), `parsers.py`, `alert_parser.py`, Dockerfile. |
| `db/init/*.sql` | Schema + migrations. Strategy state: `02-schema.sql` (`strategy_definitions`, `strategy_outcomes`, `bot_job_locks`, `bot_trade_locks`, `bot_trading_state`, `sl_tp_positions`, `token_mcap_tracking`), `06` (`mcap_social_pattern_24h`), `10`/`11` (GMGN domain + SM/KOL combined), `13` (`radar_alert_threads`), `14` (`radar_digest_pins`), `15` (social domain), `16` (strategy episodes), `18` (signal ohlc labels), `19`/`20` (wallet digger), `24` (strategy chain), `26`/`27` (pattern/social chain). |
| `ml/` | Pattern / gate / potential training artifacts + ONNX scorers (shadow vs enforce decided by `*_ready` flags). |

### Ops notes

- Monitor/trigger workers at `/dev/strategies` → **Workers** tab (needs `CRON_SERVICE_URL`, default `http://cron:8080`). Worker status: `ok` (last success within 2× interval), `stale` (>2× interval), `error` (failed after last success), `never_run`, `disabled`, `offline`.
- Manual run: `POST /trigger/<worker>` on cron `:8080` with `X-Trigger-Secret`, or the dev proxy `POST /api/workers/trigger`. `npm run dev` alone does not run cron — sim/social history gaps usually mean the `reloadsol-cron` container is down (see algo_overview.md gap-diagnosis).
- Key env defaults: `TRENDING_TRACKER_SECRET`/`TRIGGER_SECRET` (auth), `SIGNALS_SIM_INTERVAL=120`, `MCAP_TRACKER_SIM_OPEN_INTERVAL=15`, `MCAP_TRACKER_SIM_INTERVAL=120`, `GMGN_SIM_INTERVAL=120`, `GMGN_ACTIVITY_POLL_INTERVAL=180`, `SOCIAL_ROLLUP_INTERVAL=300`, `DLMM_SCREEN_INTERVAL=300`, `DLMM_MANAGE_INTERVAL=60`, `RH_CLMM_MANAGE_INTERVAL=300`, `SOL_ARB_SCAN_INTERVAL=60`, `STRATEGY_REPORT_INTERVAL=86400`, `STRATEGY_TRACK_TELEGRAM_ENABLED` (global telegram kill switch).
- Docs disagreements resolved in favor of code: registry now includes RH sim twins (`att_rh`, `signals_default_rh`, `mcap_enter_*_rh`) and `social_only_fomo_gt7`, GMGN strategies are **inactive by default**, and DLMM/RH cadences differ from older docs' "5m DLMM" phrasing (screen/sim-track 300s, manage 60s).
