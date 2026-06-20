# Slim Dev Features Plan

Consolidate six overlapping dev/trade tools into three focused surfaces: **Signals**, **Algo Tester**, and **DLMM**.

## Todos

- [x] phase1-shell-nav — Tabbed Signals shell, algo-tester route, slim nav, redirects
- [x] phase2-live-tab — Live tab from catch-the-coin; delete route
- [x] phase3-board-tab — Board tab from charts; delete /charts
- [x] phase4-tracker-tab — Tracker tab from mcap-tracker; delete page
- [x] phase5-algo-merge — History in Algo Tester; remove orphan dev routes from nav
- [x] phase6-cleanup — Stale links, type-check, build

## Target routes

| Tool | Route | Tabs |
|------|-------|------|
| Signals | `/dev/signals` | signals, live, board, tracker |
| Algo Tester | `/dev/algo-tester` | dashboard, history |
| DLMM | `/dev/dlmm` | (unchanged) |

## Redirects

| Old | New |
|-----|-----|
| `/catch-the-coin` | `/dev/signals?tab=live` |
| `/charts` | `/dev/signals?tab=board` (+ preserve `?addresses=` via proxy) |
| `/dev/mcap-tracker` | `/dev/signals?tab=tracker` |
| `/dev/trending-tracker` | `/dev/algo-tester` |
| `/dev/tracking-history` | `/dev/algo-tester?tab=history` |

## Removed from nav

catch-the-coin, charts, trending-tracker, tracking-history, mcap-tracker, pools, pools-test
