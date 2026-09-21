# SPEC — Algo Tester unify: all domains, Config + Open + Closed v1

**Status:** implement  
**Date:** 2026-09-21  
**Surface:** `reloadsol` `/dev/algo-tester` (expand in place); `/dev/strategies` redirect; PnL `AlgoPositions` shrink  
**Lane:** autotrade & algo  
**Depends on:** strategy registry + `strategy_outcomes` (all six domains), `getAlgoPositions`, Strategy Admin hub, trending Algo Tester

**Provenance:** Wayfinder unify pack (locked 2026-09-21). Implement from this document; do not reopen grilling unless a lock is contradicted by production data after ship.

Implement from this document. Destination: `/dev/algo-tester` Config · Open positions · Closed reports.

---

## Implementer checklist (build first)

Do this order. Do **not** start with live trade, engine rewrites, schema drops, or a new `/api/algo-tester/*` mega-endpoint.

1. **Expand `/dev/algo-tester` in place.** Same URL. Page title / nav stay **Algo Tester** (see §7.1). Replace the hub’s two tabs (`dashboard` | `history`) with **Config · Open positions · Closed reports**.
2. **Port Strategy Admin UX**, do not rewrite cards. Lift `StrategyAdminHub` Config + Reports (ML feed / outcomes) into those tabs. Fold **Workers** into Config and **Review** into Closed (deep-linkable panels — §5.4).
3. **Open positions = all six domains** via existing `getAlgoPositions` → `GET /api/strategies/positions`. Do not keep Open as trending-only `useTrendingStats`.
4. **Closed reports = `strategy_outcomes` + reports APIs** already used by Strategy Admin (`GET /api/strategies/outcomes`, `GET /api/strategies/reports`). Domain filter on every tab.
5. **Redirect** `/dev/strategies` → `/dev/algo-tester` in `proxy.ts`, preserving tab / `tokenAddress` / `chain` / domain query (§6).
6. **Shrink PnL `AlgoPositions`** to a link-out (optional counts). Desk of record is Algo Tester Open / Closed.
7. **Inbound links** (`token-locate`, search-token, nav) point at the unified desk. Tracker (`/dev/signals?tab=tracker`) stays the operator list — optional mint deep-link only.
8. **No engine / schema work.** Do not rewrite sim-open crons, flip `EVAL_SHADOW`, live-trade, delete `strategy_outcomes` / `trending_token_tracker`, or touch Flowey.

---

## 1. Goal

One operator desk on **`/dev/algo-tester`** that:

1. Configures **all six** strategy domains (today split: Config lives on `/dev/strategies`, trending observation lives on Algo Tester).
2. Shows **open** positions across those domains (today only on PnL `AlgoPositions`, while Algo Tester Open is trending-tracker-only).
3. Shows **closed** ML-feed / outcomes / A/B reports (today Strategy Admin Reports).
4. Retires `/dev/strategies` as a destination via **redirect**, and stops PnL from being a second algo desk.

### 1.1 Non-goals (out of scope)

- Rewriting entry engines, sim-open / sim-track / trending-track cron workers, or exit logic.
- Live (real) trading; flipping `EVAL_SHADOW` / eval paper opens; changing `execution_mode` semantics.
- Deleting or migrating away from `strategy_outcomes` or `trending_token_tracker` / `_dev` schemas.
- Flowey / insight-scout / `/dev/fomo` / `/dev/insight`.
- A new aggregate HTTP API (`/api/algo-tester/...`) in v1 — **compose existing APIs** (§7.2).
- Making Tracker (`/dev/signals?tab=tracker`) the closed desk, or merging Tracker list UX into Algo Tester.
- Redesigning DLMM hunter UI (`/dev/dlmm`), Social hub (`/dev/social`), or Signals Live/Board/Roster.
- Training / enforcing a new ML model; Pattern ML remaining display-only where it already is.
- Dropping Combined Score / Eval / ML2 overlay panels — they move with Config, they are not deleted.

---

## 2. Locked decisions (do not reopen)

| Decision | Lock | Ticket |
|---|---|---|
| Home | **Expand `/dev/algo-tester` in place.** Not a new URL. | `where-does-the-unified-desk-live` |
| Nav / display name | Default keep **“Algo Tester”**. SPEC does **not** rename the nav label. Page subtitle may change (§7.1). | `display-name` |
| Domains v1 | **All six:** `trending_bot`, `mcap_tracker`, `signals`, `gmgn`, `social`, `dlmm`. | `which-domains` |
| Tab IA | **One page, three tabs:** **Config** + **Open positions** + **Closed reports** (ML feed / outcomes). | `tab-ia` |
| Strategy Admin | Port **config + reports UX** into those tabs. `/dev/strategies` **redirects** to `/dev/algo-tester` (preserve useful query/tab). | `retire-strategies-route` |
| PnL | `AlgoPositions` on PnL **remove or shrink** with link-out to Algo Tester. | `pnl-shrink` |
| Tracker | `/dev/signals?tab=tracker` stays the **operator list**. Deep-link optional; **not** the closed desk. | `tracker-stays-list` |
| Engines / eval / schemas | Do **not** rewrite sim-open cron; no live trade; no `EVAL_SHADOW` flip; do **not** delete `strategy_outcomes` / `trending_token_tracker`. | `non-goals-engines` |

---

## 3. As-built (verified in repo before writing this section)

### 3.1 Two desks, overlapping jobs

```
/dev/algo-tester          AlgoTesterHub
  ?tab=dashboard (default)  AlgoDashboardTab
       useTrendingStats → GET /api/trending/stats
       strategy filter = trending_bot ids only  (GET /api/strategies → j.trending_bot)
       copy points at Strategy Admin reports
  ?tab=history              HistoryTab
       useTrackingHistory → GET /api/trending/history
       trending_token_tracker rows only

/dev/strategies           StrategyAdminHub
  ?tab=config (default)     StrategyConfigTab — all six domain card grids
                            + CombinedScoreWeightsPanel + EvalEnginePanel + Ml2ExitOverlayPanel
  ?tab=reports|outcomes     coverage / A/B / ML feed / strategy_outcomes table
                            GET /api/strategies + /outcomes + /reports
  ?tab=review               StrategyReviewPanel → GET /api/strategies/review
  ?tab=workers              WorkersTab → GET /api/workers/status, POST /api/workers/trigger

/pnl                      PnLTracker
  AlgoPositions (toggle)    GET /api/strategies/positions → getAlgoPositions
                            open: tracker + mcap sim + signals/gmgn/social wallets + DLMM
                            closed: strategy_outcomes (limit 100)
```

Algo Tester **does not** consume `getAlgoPositions`. Strategy Admin Reports copy already admits Open lives on Algo Tester — but that Open is trending-only, so mcap/signals/gmgn/social/dlmm opens are **only** on PnL (plus a small mcap open-sim table inside Reports).

### 3.2 Algo Tester today is trending-only

| Piece | Path | Behavior |
|---|---|---|
| Page | `src/app/(trade)/dev/algo-tester/page.tsx` | H1 **Algo Tester**. Subtitle: “Trending tracker dashboard and token tracking history.” |
| Hub tabs | `AlgoTesterHub.tsx` | `dashboard` \| `history` via `?tab=` (`ScrollableMenuRow`). |
| Dashboard data | `AlgoDashboardTab.tsx` → `useTrendingStats` (`src/hooks/useTrendingStats.ts`) | `GET /api/trending/stats?nocache=true` + optional `is_simulated`, `strategy_id`, `date`. |
| Strategy filter | `AlgoDashboardTab` `useEffect` | `fetch(/api/strategies?chain=)` then **`j.trending_bot` only** (`active`, `allocation`, `Object.keys(effective)`). Dropdown ids: `att` / `lowcap_moonbag` / … — no mcap/signals/gmgn/social/dlmm. |
| Local “Trading Config” | `AlgoDashboardTab` `localStorage.tradingConfig` | Manual sim/live banner. Copy already says cron workers use Strategy Admin `execution_mode`, **not** this banner. |
| Cross-link | `AlgoDashboardTab` ~874 | `href="/dev/strategies?tab=reports"`. |
| History | `HistoryTab.tsx` → `useTrackingHistory` | `GET /api/trending/history` on `trending_token_tracker` (`_dev` in development). |
| Legacy redirects | `proxy.ts` | `/dev/trending-tracker` → `/dev/algo-tester`; `/dev/tracking-history` → `/dev/algo-tester?tab=history`; `/dev/pools-test` → `/dev/algo-tester`. |

### 3.3 Strategy Admin today is the all-domain config + closed desk

| Piece | Path | Behavior |
|---|---|---|
| Page | `src/app/(trade)/dev/strategies/page.tsx` | H1 **Strategy Admin**. |
| Tabs | `StrategyAdminHub.tsx` `TabId` | `config` \| `reports` \| `review` \| `workers`. `parseTabParam`: `outcomes` **or** `reports` → reports. |
| Config cards | `StrategyConfigTab` (same file, ~3247) | Sections: Combined/Eval/ML2 overlays, then **Trending bot, Signals, MCap tracker, GMGN, Social, DLMM**. `PATCH /api/strategies/[id]`, promote via `POST /api/strategies/[id]/promote`. |
| Domain list API | `GET /api/strategies` (`src/app/api/strategies/route.ts`) | Already returns `trending_bot`, `signals`, `mcap_tracker`, `gmgn`, `social`, `dlmm` keyed objects + `canonical`. |
| Reports filters | Domain `<select>` | `""` All · `trending_bot` · `signals` · `mcap_tracker` · `gmgn` · `social` · `dlmm`. Plus strategy, sim/live, ML label/condition, status, PnL, entry mcap band, `tokenAddress`. |
| Outcomes | `GET /api/strategies/outcomes` | Closed rows from `strategy_outcomes`; CSV `format=csv`. `OutcomeReviewModal` + training_class PATCH. |
| Aggregates | `GET /api/strategies/reports` | `aggregateStrategyReports`: breakdown, coverage, A/B pairs, ranking, `ml_stats`, `mcap_tracker_stats` (incl. **open sim positions** with tracker deep-links), best-trade windows. |
| Review | `StrategyReviewPanel.tsx` | Weekly heatmap; `GET /api/strategies/review`. |
| Workers | `WorkersTab` | `GET /api/workers/status`, `POST /api/workers/trigger`. Domain heartbeat from last closed outcome. |
| Tracker links (already) | Config MCap section + Reports open-sim table | `/dev/signals?tab=tracker` and `?search={mint}`. |

### 3.4 Cross-domain opens already exist — consumed by PnL, not Algo Tester

`getAlgoPositions` (`src/strategies/algo-positions.ts`) → `GET /api/strategies/positions` (`src/app/api/strategies/positions/route.ts`).

**Open (Promise.all, chain-aware):**

| Domain | Source | Mapper |
|---|---|---|
| `trending_bot` (sol) | `trending_token_tracker` (`_dev` locally) `status='tracking'` | `mapTrackerRowToAlgoPosition` |
| `trending_bot` (RH) | `TRENDING_BOT_SIM_WALLET` twin `trading_records` | `mapWalletOpenToAlgoPosition` |
| `mcap_tracker` | `getOpenMcapSimPositions` on mcap sim wallet records | `mapMcapOpenToAlgoPosition` (entry/exit **mcap**, not price) |
| `signals` | `SIGNALS_SIM_WALLET` | `mapWalletOpenToAlgoPosition` |
| `gmgn` | `GMGN_SIM_WALLET` | same |
| `social` (sol only) | `SOCIAL_SIM_WALLET` | same |
| `dlmm` (sol only) | `getPositions()` DLMM rows `open` / `out_of_range` / `pending` | `mapDlmmPositionToAlgoPosition` |

**Closed:** `listStrategyOutcomes({ limit, chain })` → `mapOutcomeToAlgoPosition`. No `domain` query param on the positions route today — client must filter.

Consumer: `src/components/AlgoPositions.tsx` (Open/Closed inner tabs, `PositionCard`, metadata batch). Mounted from `PnLTracker.tsx` behind `showAlgoStrategies` localStorage toggle (`pnl-show-algo-strategies`).

### 3.5 Domain enum (DB + types)

`StrategyDomain` in `src/strategies/types.ts` and `strategy_definitions` / `strategy_outcomes` CHECKs (`db/init/02-schema.sql`, `15-social-strategy-domain.sql`):

`trending_bot` | `signals` | `dlmm` | `mcap_tracker` | `gmgn` | `social`

That **is** the v1 set. Do not invent a seventh domain.

### 3.6 Hypothesis — confirmed

> Unifying the desk is **UI composition + redirects**, not a new data plane.

- Config already has all six domains on one hub and one `GET /api/strategies`.
- Closed already has all-domain outcomes + reports with a domain filter.
- Open-all-domains already has `getAlgoPositions`; Algo Tester simply does not call it.
- Tracker is a **candidate/operator list** (`token_mcap_tracking`), not `strategy_outcomes`. Catch-train SPEC owns that list.

---

## 4. Destination information architecture

### 4.1 One page, three tabs

`AlgoTesterHub` tab row (same `ScrollableMenuRow` chrome as today):

| Tab id (`?tab=`) | Label | Owns |
|---|---|---|
| `config` | **Config** | Strategy Admin Config: overlays + all domain cards + **Workers** panel |
| `open` | **Open positions** | Cross-domain opens (`getAlgoPositions.open`) + optional trending history **view** |
| `closed` | **Closed reports** | Strategy Admin Reports (coverage, A/B, ML feed, outcomes table) + **Review** panel |

Default when visiting `/dev/algo-tester` with **no** `tab`: **`open`** (preserves Algo Tester as a monitoring desk).

`/dev/strategies` with **no** `tab` redirects to **`?tab=config`** (preserves Strategy Admin’s default).

### 4.2 Reuse vs wrap vs leave

**Reuse as-is (move / re-export, do not rewrite):**

| Component / API | Goes to |
|---|---|
| `StrategyConfigTab` + per-domain cards (`TrendingBotCard`, `SignalsCard`, `McapTrackerCard`, `GmgnCard`, Social, DLMM) | Config tab |
| `CombinedScoreWeightsPanel`, `EvalEnginePanel`, `Ml2ExitOverlayPanel` | Config tab (keep order: overlays then domain cards) |
| `WorkersTab` + `/api/workers/status` + `/api/workers/trigger` | Config, `?panel=workers` |
| Reports filter bar + coverage / A/B / ML / outcomes table + `OutcomeReviewModal` | Closed tab |
| `StrategyReviewPanel` + `/api/strategies/review` | Closed, `?panel=review` |
| `GET/PATCH /api/strategies`, `GET /api/strategies/outcomes`, `GET /api/strategies/reports`, promote, regime tag, label backfill | unchanged |
| `getAlgoPositions` / `GET /api/strategies/positions` / `AlgoPosition` type / `PositionCard` | Open tab (primary) |
| `HistoryTab` + `useTrackingHistory` | Open, `?view=history` (trending tracker history — not outcomes) |
| Domain `<select>` options already on Reports | shared domain filter on all three tabs |

**Wrap / thin adapter:**

| New (implementation PR) | Why |
|---|---|
| `AlgoTesterHub` tab ids + query parser | Replace `dashboard`/`history`; aliases in §6 |
| Shared **domain + strategy + sim/live** filter strip | One control set; drives Config card emphasis, Open client filter, Closed existing report params |
| Extract `StrategyConfigTab` / reports body out of the 3k-line hub **only if** it makes the port cleaner — optional, not required | Prefer move-the-hub-into-the-tab over a ground-up rewrite |
| PnL shrink wrapper | Counts + link; stop rendering the card grid |

**Leave in place (do not merge into the desk):**

| Surface | Why |
|---|---|
| `/dev/signals?tab=tracker` (`TrackerTab`) | Operator list + catch-train. Optional deep-link only. |
| `/dev/signals` Live / Board / Roster | Manual / discovery. Config already links “Open Signals hub”. |
| `/dev/dlmm` hunter | Runtime LP UI. Config already links DLMM. |
| `/dev/social` | Social ingest UI. |
| `/api/trending/stats` and `/api/trending/history` | Keep serving History view + optional trending strip. Not the Open source of truth. |
| `AlgoDashboardTab` trending overview/winners/losers | **Do not** make this the Open tab. Optional: compact strip when domain=`trending_bot` (§5.2). May unmount the localStorage “Trading Config” live banner from the default Open view (it is not the worker kill switch). |

### 4.3 What happens to today’s extra tabs

| Today | v1 |
|---|---|
| Algo Tester `dashboard` | Alias → `open`. Trending stats are **not** the primary Open feed. |
| Algo Tester `history` | Alias → `open&view=history`. Component stays. |
| Strategy Admin `config` | Config tab. |
| Strategy Admin `reports` / `outcomes` | Closed tab. Preserve `tokenAddress`, domain, chain. |
| Strategy Admin `review` | Closed + `panel=review`. |
| Strategy Admin `workers` | Config + `panel=workers`. |
| PnL full `AlgoPositions` grid | Shrink / remove (§8). |

Do **not** keep a fourth top-level tab for Workers, Review, or History. Deep-link panels/views only.

---

## 5. Tab specs

### 5.1 Domain filter UX (all three tabs)

Shared query params (single source; hub owns them so switching tabs does not wipe filters):

```ts
type AlgoTesterQuery = {
  tab: 'config' | 'open' | 'closed'   // default open on this URL
  domain?: StrategyDomain | ''        // '' = All
  strategyId?: string                 // '' = All; options derived from GET /api/strategies for the selected domain
  simulated?: 'all' | 'sim' | 'live'  // Open + Closed; Config ignores
  chain?: 'sol' | 'robinhood'         // existing AppNetwork; keep `?chain=` sync like Strategy Admin
  tokenAddress?: string               // Closed outcomes search; Config ignores
  panel?: 'workers' | 'review'        // Config workers | Closed review
  view?: 'history'                    // Open only — trending tracker history
}
```

**Control:** one Domain `<select>` (same labels as Strategy Admin Reports today) plus Strategy `<select>` (ids for that domain; empty = all) plus Sim/Live on Open and Closed.

When Domain = All, Strategy dropdown lists every id grouped or flattened with `domain/id` (Reports already does a strategy dropdown). Fog default: flattened `id` with domain prefix in the label (`mcap_tracker / mcap_enter_first_seen`).

**Config tab behavior when a domain is selected:** scroll to / visually emphasize that domain’s card section; still render other sections (do not hide — operators compare bands). Optional: collapse non-selected sections. Fog default: **collapse others** to a one-line “N strategies · Active: …” so the selected domain is the working set, All shows today’s full page.

**Open / Closed:** filter the list/report. Closed already has server `domain` / `strategy_id` / `is_simulated` — **keep using them**. Open: v1 **client-filter** `getAlgoPositions` results by `position.domain` / `strategyId` / `isSimulated` unless you add optional query params to `/api/strategies/positions` (allowed, not required).

### 5.2 Open positions

Primary list: `GET /api/strategies/positions?limit=100&chain=` — reuse `AlgoPositions` layout (`PositionCard`, metadata batch, 30s refetch).

Required vs today:

- Domain + strategy + sim/live filters (§5.1).
- Empty copy names the filter (“No open mcap_tracker positions”) not “No open algo positions” only.
- Per-row **optional Tracker deep-link** when `domain === 'mcap_tracker'` (and fog: `signals` too) and `tokenAddress` is set: `/dev/signals?tab=tracker&search={mint}` — same pattern as Reports’ open-sim table (`StrategyAdminHub` ~1490). Do **not** send the operator to Tracker as the default Closed path.
- DLMM rows may link to `/dev/dlmm` (pool), not Tracker.
- Trending rows may keep existing chart/board helpers from `AlgoDashboardTab` **if** cheap; not required to port the whole dashboard.

**Trending history view:** `?tab=open&view=history` renders existing `HistoryTab` (tracker table, not outcomes). Banner: “Trending token tracker history — not `strategy_outcomes`.”

**Optional trending stats strip** (not required to close Open): if `domain` is All or `trending_bot`, a compact win-rate / still-tracking line from `useTrendingStats`. Must not replace the positions grid. Do **not** block Open on `/api/trending/stats` failure.

Remove Open’s dependency on `strategyFilter` from `trending_bot` only.

### 5.3 Closed reports (ML feed / outcomes)

Port Strategy Admin **Reports** body verbatim in spirit:

- Date range, timezone, domain, strategy, sim/live, ML label/condition, status, PnL, entry mcap band, token search.
- Coverage table, mcap tracker stats, A/B, ranking, ML stats, outcomes table + class chips + `OutcomeReviewModal`, CSV, label backfill, regime tag.
- Copy update: closed = `strategy_outcomes`; opens = **this page’s Open tab** (not “Algo tester trending tracker”). Replace `Link href="/dev/algo-tester"` that implied trending-only.

`?tab=closed&tokenAddress=` must still open the filtered outcomes list (search-token + token-locate inbound).

### 5.4 Panels folded into the three tabs

| Panel | Parent tab | Query | UX |
|---|---|---|---|
| Workers | Config | `panel=workers` | Existing `WorkersTab` below or above domain cards. If `panel=workers`, auto-scroll / expand. |
| Review | Closed | `panel=review` | Existing `StrategyReviewPanel` above or below the outcomes table. |
| Tracker history | Open | `view=history` | Existing `HistoryTab`. |

Fog default placement: Workers **below** domain cards on Config; Review **above** the outcomes table on Closed (weekly context before the feed).

---

## 6. Redirect + query mapping

Add `/dev/strategies` to `proxy.ts` `slimRedirects` (same helper style as `/dev/trending-tracker`).

Preserve query when present. Mapping:

| Incoming (`/dev/strategies` or old Algo Tester) | Destination |
|---|---|
| `/dev/strategies` (no tab) | `/dev/algo-tester?tab=config` + pass `chain` |
| `?tab=config` | `?tab=config` |
| `?tab=reports` or `?tab=outcomes` | `?tab=closed` + `tokenAddress`, `chain`, `domain` if present |
| `?tab=workers` | `?tab=config&panel=workers` |
| `?tab=review` | `?tab=closed&panel=review` |
| `/dev/algo-tester` (no tab) | default hub `open` (no redirect) |
| `?tab=dashboard` | `?tab=open` (normalize in hub parser; optional  replaceState) |
| `?tab=history` | `?tab=open&view=history` |
| `/dev/tracking-history` (already) | update target from `?tab=history` → `?tab=open&view=history` |
| `/dev/trending-tracker`, `/dev/pools-test` | stay `/dev/algo-tester` (now lands Open) |

Unknown `tab` values: Config for `/dev/strategies` origins; Open for `/dev/algo-tester`.

Keep `/dev/strategies` in `DEV_ROUTES` / `route-network.ts` so the **pre-redirect** request still passes the wallet gate; after 302 the destination is already a dev route.

### 6.1 Inbound link updates (implementation PR)

| Caller | Today | After |
|---|---|---|
| `src/strategies/token-locate.ts` `links.strategies` | `/dev/strategies?tab=outcomes&tokenAddress=` | `/dev/algo-tester?tab=closed&tokenAddress=` (keep `chain`) |
| `SearchTokenClient.tsx` (two hrefs) | same | same mapping |
| `AlgoDashboardTab` reports link | `/dev/strategies?tab=reports` | in-page `?tab=closed` or drop after port |
| `NavigationTabs.tsx` Strategy Admin | `href="/dev/strategies"` | fog: **remove the extra icon** (Algo Tester remains). Bookmarks still hit the redirect. If removing the icon is too sharp, retarget href to `/dev/algo-tester?tab=config` and set `isActive` from `/dev/algo-tester`. |
| `NavigationTabs` Algo Tester | `/dev/algo-tester` | unchanged; active on that path |
| Tests that assert `/dev/strategies` strings (`combined-score-load.test.ts`, `route-network.test.ts`) | update expected dest / keep network support on both paths | |
| Docs that teach `/dev/strategies` as the admin URL | point at Algo Tester tabs; keep “legacy URL redirects” | implementation PR or a tiny docs follow-up — this SPEC PR only indexes itself |

`isActive("/dev/strategies")` will never match after redirect — do not leave a dead highlighted nav item.

---

## 7. Suggested defaults for remaining fog

These are **to-spec choices** so implementers do not re-grill. Tune in the implementation PR only if a lock above is violated.

### 7.1 Display name

Keep **Algo Tester** on:

- `NavigationTabs` `title` / `aria-label`
- Page `<h1>`
- Redirect landing

Update the **subtitle** only, e.g. “Config, open positions, and closed reports across all strategy domains.”

Do **not** rename the route, nav, or H1 to “Strategy Desk” / “Strategy Admin” in v1 (bookmark + muscle memory). Internal comments may say “unified strategy desk.”

### 7.2 Compose APIs vs new aggregate endpoint

**Compose. No new aggregate route in v1.**

| Need | Use |
|---|---|
| Config | `GET /api/strategies?chain=` + `PATCH /api/strategies/[id]` (+ promote, combined-score weights, eval, ml2 as today) |
| Open | `GET /api/strategies/positions` |
| Closed list / ML feed | `GET /api/strategies/outcomes` |
| Closed aggregates | `GET /api/strategies/reports` |
| Workers | `GET /api/workers/status`, `POST /api/workers/trigger` |
| Review | `GET /api/strategies/review` |
| Trending history | `GET /api/trending/history` |
| Optional trending strip | `GET /api/trending/stats` |

Allowed additive (not required): `domain` / `strategy_id` / `is_simulated` query params on `/api/strategies/positions` that filter `open`/`closed` server-side. If added, keep today’s unfiltered behavior when params are omitted (PnL shrink + any other caller).

Forbidden in v1: `GET /api/algo-tester` that joins stats+positions+outcomes+workers in one payload.

### 7.3 Tracker deep-link

Tracker stays `/dev/signals?tab=tracker`.

| Row | Link |
|---|---|
| Open `mcap_tracker` mint | **Yes** — `?tab=tracker&search={mint}` (already used in Reports). |
| Open `signals` mint | **Yes** (same). Fog: also acceptable to skip if search-on-tracker is noisy. |
| Open `trending_bot` mint | Prefer existing Algo Tester / board / chart affordances; Tracker is the wrong list. |
| Open `gmgn` / `social` / `dlmm` | Domain hubs (`/dev/social`, `/dev/dlmm`), not Tracker. |
| Closed outcome mint | Stay on Closed (`tokenAddress` filter). Optional secondary “view on Tracker” if the mint is still tracked — not required. |
| Config MCap section | Keep “Open MCap tracker tab” link. |

Closed desk **is** Algo Tester Closed, never Tracker.

---

## 8. Redirect + PnL shrink — acceptance

### 8.1 Redirect

- [ ] `GET /dev/strategies` → 302/307 to `/dev/algo-tester?tab=config` (or equivalent Next redirect).
- [ ] `?tab=outcomes&tokenAddress=ABC&chain=sol` → `/dev/algo-tester?tab=closed&tokenAddress=ABC&chain=sol`.
- [ ] `?tab=workers` → Config + workers panel visible without extra clicks beyond the landing expand/scroll.
- [ ] Dev wallet gate still allows the old path (redirect runs after / as part of the same proxy).
- [ ] `/dev/algo-tester` remains the canonical URL in the address bar after redirect.

### 8.2 PnL `AlgoPositions`

Pick **one** (fog default = **B**):

| Option | Behavior |
|---|---|
| **A — remove** | Delete the PnL block. No `showAlgoStrategies` toggle. |
| **B — shrink (default)** | Replace the card grid with a single row: title “Algo strategies”, optional `open.length` / `closed.length` if you still fetch, primary link **Open on Algo Tester** (`/dev/algo-tester?tab=open`) and secondary **Closed reports** (`?tab=closed`). Hide-algo toggle may go away. |

- [ ] PnL is no longer a second full open/closed card desk.
- [ ] Clicking through lands on Algo Tester with the right tab.
- [ ] Wallet PnL (user buys/sells) is **unchanged**.

Do not move `getAlgoPositions` *off* the API; Open tab is the consumer. PnL must not be the only UI for mcap opens after this ships.

---

## 9. Files to touch (implementation PR, not this one)

| Path | Why |
|---|---|
| `src/components/algo-tester/AlgoTesterHub.tsx` | Three tabs + query parser + aliases |
| `src/app/(trade)/dev/algo-tester/page.tsx` | Subtitle |
| `src/components/strategies/StrategyAdminHub.tsx` | Split or render Config/Closed bodies from the hub; keep cards/reports |
| `src/app/(trade)/dev/strategies/page.tsx` | May become unused if proxy redirects first — leave a stub or delete only if redirect is guaranteed |
| `proxy.ts` | `/dev/strategies` redirect + history alias |
| `src/components/AlgoPositions.tsx` | Reuse cards on Open; shrink PnL usage |
| `src/components/PnLTracker.tsx` | Shrink / remove mount |
| `src/components/NavigationTabs.tsx` | Drop or retarget Strategy Admin icon |
| `src/strategies/token-locate.ts` | `links.strategies` → closed tab |
| `src/components/search/SearchTokenClient.tsx` | outcomes links |
| `src/app/api/strategies/positions/route.ts` | Optional domain filter |
| `src/config/route-access.ts` / `route-network.ts` | Keep both paths gated |
| `src/hooks/useTrendingStats.ts` | Citation; only if optional strip stays |
| Docs: `docs/algo_overview.md`, `docs/03-strategies-and-automation.md`, `README.md` operator URLs | Follow-up OK if this SPEC is the handoff |

**Do not touch for v1:** sim-track / trending-track / mcap-sim-track workers, `outcomes.ts` writers, `EVAL_SHADOW`, `db/init/*` strategy_outcomes / tracker schemas, Flowey.

---

## 10. Flags

None required. This is a UI/IA move.

Optional (fog: **do not add** unless you need a kill switch mid-rollout):

| Variable | Default | Meaning |
|---|---|---|
| `ALGO_TESTER_UNIFY` | on | `0` would keep two desks. Prefer ship the redirect; no flag. |

`EVAL_SHADOW`, `ML_CLOSED_LOOP`, `ML_PATTERN_MODE`, Tracker flags — **unchanged**.

---

## 11. Acceptance criteria

### Desk

- [ ] `/dev/algo-tester` shows exactly three primary tabs: Config, Open positions, Closed reports.
- [ ] Nav label remains **Algo Tester**.
- [ ] All six domains appear on Config (same cards as Strategy Admin today) and are selectable on Open and Closed.
- [ ] Open list includes mcap (not only `trending_token_tracker`) when mcap sims are open — same family as today’s PnL `getAlgoPositions`.
- [ ] Closed still reads `strategy_outcomes` (ML labels, training_class, CSV). Schema stays.

### Redirect + links

- [ ] `/dev/strategies` is not a separate desk; it redirects with tab/query preserved per §6.
- [ ] `tab=outcomes&tokenAddress=` still shows that mint’s closed rows.
- [ ] Old `?tab=history` still shows trending tracker history.
- [ ] token-locate / search-token strategy links land on Closed.

### PnL

- [ ] PnL no longer presents a full algo card grid (removed or one-line link-out).
- [ ] User realized/unrealized PnL unchanged.

### Tracker

- [ ] `/dev/signals?tab=tracker` still exists and is the operator list (catch-train SPEC).
- [ ] Tracker is not required to view closed outcomes.
- [ ] Optional mint deep-link from Open mcap rows works when implemented.

### Non-goals held

- [ ] No sim-open / entry-engine behavior change.
- [ ] `EVAL_SHADOW` untouched.
- [ ] No drop of `strategy_outcomes` or `trending_token_tracker`.
- [ ] No Flowey work.
- [ ] No new aggregate algo-tester API required for the three tabs to function.

---

## 12. Test plan

No product tests in this docs PR. Implementation PR ships:

### 12.1 Query parser (unit)

| Input | Expect |
|---|---|
| `/dev/algo-tester` | tab `open` |
| `?tab=config` | config |
| `?tab=dashboard` | open |
| `?tab=history` | open + view history |
| `?tab=closed&domain=mcap_tracker` | closed, domain set |
| `?tab=reports` (if pasted on new URL) | closed |
| `?tab=workers` | config + panel workers |
| `?tab=review` | closed + panel review |

### 12.2 Redirect (route / proxy)

- `/dev/strategies` → location includes `/dev/algo-tester` and `tab=config`.
- `/dev/strategies?tab=outcomes&tokenAddress=So111` → `tab=closed` and same `tokenAddress`.
- `/dev/tracking-history` → `view=history` (or equivalent) on algo-tester.

### 12.3 Open filter (unit or component)

- Fixture with trending + mcap opens; `domain=mcap_tracker` hides trending.
- Sim filter hides `isSimulated: false`.
- Unfiltered request to positions API still returns all domains (regression for optional server filter).

### 12.4 PnL

- Shrink path: no `PositionCard` grid in PnL; link href contains `/dev/algo-tester`.
- Remove path: `AlgoPositions` not imported from `PnLTracker`.

### 12.5 Access

- `route-network` / `route-access`: `/dev/algo-tester` and `/dev/strategies` remain dev-gated; both still listed as sol+robinhood if redirect needs the old path.

---

## 13. Suggested code shape (implementation PR, not this one)

```ts
const ALGO_TESTER_TABS = ['config', 'open', 'closed'] as const
type AlgoTesterTab = (typeof ALGO_TESTER_TABS)[number]

export function parseAlgoTesterTab(raw: string | null): AlgoTesterTab {
  if (raw === 'config') return 'config'
  if (raw === 'closed' || raw === 'reports' || raw === 'outcomes') return 'closed'
  if (raw === 'review') return 'closed'
  if (raw === 'workers') return 'config'
  // dashboard | history | open | null
  return 'open'
}

export function mapStrategiesSearchToAlgoTester(
  search: URLSearchParams,
): string {
  const tab = search.get('tab')
  const next = new URLSearchParams(search)
  next.delete('tab')
  if (tab === 'workers') {
    next.set('tab', 'config')
    next.set('panel', 'workers')
  } else if (tab === 'review') {
    next.set('tab', 'closed')
    next.set('panel', 'review')
  } else if (tab === 'reports' || tab === 'outcomes') {
    next.set('tab', 'closed')
  } else {
    next.set('tab', 'config')
  }
  return `/dev/algo-tester?${next.toString()}`
}
```

Keep parsers free of I/O. Prefer `proxy.ts` redirect using `mapStrategiesSearchToAlgoTester` so one function is testable.

Open filter:

```ts
export function filterAlgoPositions(
  rows: AlgoPosition[],
  f: { domain?: string; strategyId?: string; simulated?: 'all' | 'sim' | 'live' },
): AlgoPosition[] {
  return rows.filter((p) => {
    if (f.domain && p.domain !== f.domain) return false
    if (f.strategyId && p.strategyId !== f.strategyId) return false
    if (f.simulated === 'sim' && !p.isSimulated) return false
    if (f.simulated === 'live' && p.isSimulated) return false
    return true
  })
}
```

---

## 14. Open items (non-blocking)

1. Whether to keep a compact `useTrendingStats` strip on Open — optional.
2. Whether to add server-side domain params on `/api/strategies/positions` — optional.
3. Whether Strategy Admin nav icon is deleted or retargeted — fog default **delete** (§6.1).
4. Extracting `StrategyAdminHub` into smaller files while porting — optional cleanup.
5. Updating operator docs (`algo_overview.md`, `03-strategies-and-automation.md`) in the implementation PR vs a docs follow-up.

---

## 15. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-21 | Home | Expand `/dev/algo-tester` in place; no new URL |
| 2026-09-21 | Display name | Keep **Algo Tester**; subtitle may change |
| 2026-09-21 | Domains | All six (`trending_bot`, `mcap_tracker`, `signals`, `gmgn`, `social`, `dlmm`) |
| 2026-09-21 | Tabs | Config + Open positions + Closed reports |
| 2026-09-21 | `/dev/strategies` | Redirect; preserve useful query/tab |
| 2026-09-21 | PnL | Remove or shrink with link-out (default shrink) |
| 2026-09-21 | Tracker | Operator list; optional deep-link; not closed desk |
| 2026-09-21 | APIs | Compose existing; no new aggregate endpoint |
| 2026-09-21 | Workers / Review / History | Fold into Config / Closed / Open via `panel` / `view` |
| 2026-09-21 | Engines / EVAL_SHADOW / schemas / Flowey | Out of scope |
| 2026-09-21 | As-built (repo verify) | Algo Tester trending-only via `useTrendingStats`; Admin = config+outcomes; `getAlgoPositions` already all-domain for PnL |

---

## 16. Related docs

- Strategy spine: [../03-strategies-and-automation.md](../03-strategies-and-automation.md), [../algo_overview.md](../algo_overview.md), [../STRATEGY_ARCHITECTURE.md](../STRATEGY_ARCHITECTURE.md)
- Tracker list (stays separate): [SPEC-tracker-catch-train-v1.md](./SPEC-tracker-catch-train-v1.md), [SPEC-early-enter-soft-gate-v1.md](./SPEC-early-enter-soft-gate-v1.md)
- ML closed loop / eval (do not flip): [../04-machine-learning.md](../04-machine-learning.md)
- Architecture map of the two URLs: [../architecture.md](../architecture.md)
