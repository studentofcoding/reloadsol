# Specs

Implementable handoffs. Code PRs should follow these rather than re-litigating product grilling.

| Spec | Status |
|---|---|
| [SPEC-rug-filter-v1.md](./SPEC-rug-filter-v1.md) | To-spec (docs only). Bubblemaps + Jupiter organic rug filter for buy_bulk / reloadsol |
| [SPEC-tracker-catch-train-v1.md](./SPEC-tracker-catch-train-v1.md) | Implementing. Tracker social join + decision-useful risk + catch-train strip |
| [SPEC-early-enter-soft-gate-v1.md](./SPEC-early-enter-soft-gate-v1.md) | Implementing. Early Enter closed-loop soft gate + Tracker Z/Anomaly/Momentum/Risk filters + Analytics minimal+price |
| [SPEC-strategies-algo-tester-unify-v1.md](./SPEC-strategies-algo-tester-unify-v1.md) | Implementing. Unify Algo Tester: all six domains, Config + Open + Closed; `/dev/strategies` redirect |
| [SPEC-potential-rug-labels-tracker-honesty-v1.md](./SPEC-potential-rug-labels-tracker-honesty-v1.md) | To-spec (docs only). MCap auto-rule potential/rugged labels, OHLC corpus, Tracker tabs, token-map honesty |
| [SPEC-jev-soft-gate-shadow-v1.md](./SPEC-jev-soft-gate-shadow-v1.md) | Implementing. Jev Noul shadow beside Early Enter soft gate (`early_enter_noul_shadow`); paper untouched |
| [SPEC-signals-strategy-list-v1.md](./SPEC-signals-strategy-list-v1.md) | To-spec (docs only). Signals-tab strategy picker ranked by raw unfloored PnL; unique mint + cross-strategy badge |
| [SPEC-trending-gmgn-feed-reentry-guard-v1.md](./SPEC-trending-gmgn-feed-reentry-guard-v1.md) | **Shipped** (5d019b5). Trending: GMGN as single discovery feed (`TRENDING_FEED=gmgn` live), durable `strategy_outcomes`-keyed re-entry guard, drop rugged from the feed |
| [SPEC-ohlc-own-1m-v1.md](./SPEC-ohlc-own-1m-v1.md) | Implementing. Own 1m OHLC series (`token_ohlc_bars` + 15s `ohlc_sampler`), window-first chart fetch, honest failure copy. No new dependency; GeckoTerminal/DexScreener deferred |
| [SPEC-index-hygiene-v1.md](./SPEC-index-hygiene-v1.md) | **Shipped** (40-index-hygiene applied to prod). Indexes that were never scanned because the indexed expression didn't match the predicate: −423 MB, four seq-scanning queries 159→2 ms, 427→1.6 ms, 187→0.06 ms |
