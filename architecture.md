# Architecture

ReloadSOL is a **dual-chain algorithmic trading platform**: Solana mainnet (bulk buys, trending/mcap strategies, Meteora DLMM) + **Robinhood Chain 4663** (EVM; Uni v3/v4-fork CLMM, Kyber swaps, batch-executor contract).

Full system architecture documentation lives in **[docs/architecture.md](docs/architecture.md)**; single-page overview in **[docs/ARCHITECTURE_SUMMARY.md](docs/ARCHITECTURE_SUMMARY.md)**; the 2026-07 infra audit with file:line evidence in **[recommendations.md](recommendations.md)**.

## At a glance

```
Browser (Phantom / Rabby, EIP-6963)              VPS Docker
┌──────────────────────────────────┐             ┌────────────────────────────────────┐
│ Network toggle: 'sol'|'robinhood'│             │ nginx → reloadsol-web (Next.js)    │
│ Solana: wallet signs txs         │             │ reloadsol-cron (Go) → POST web API │
│ RH: 1 sig → BatchExecutor        │── tx ─────► │ reloadsol-db + PgBouncer + Redis   │
│   (wrap + Permit2 + N swaps)     │             │ social-ingest, ML artifacts (ro)   │
└──────────────────────────────────┘             └────────────────────────────────────┘
        │                                                   │
        ▼                                                   ▼
Robinhood Chain 4663 (EVM)                        Solana mainnet
- BatchExecutor (owner-scoped, atomic)            - Raptor / Jupiter swaps, server keypair
- Permit2 approvals, Kyber router                 - Meteora DLMM agent (auto manage,
- Uni v3 + v4 forks (CLMM), WETH/USDG               REDEPLOY, auto-fee-claim)
```

## Quick links

- [System topology & Docker](docs/architecture.md#1-system-topology)
- [Product domains (manual / algo / admin)](docs/architecture.md#2-product-domains)
- [Cron workers](docs/architecture.md#3-cron-workers-11-jobs) — Go cron binds 27 workers incl. `rh_clmm_manage` (alert-only); all `/trigger/*` endpoints require `X-Trigger-Secret`
- [Postgres data layer](docs/architecture.md#6-data-layer-docker-postgres) — schema `db/init/` (`02-schema.sql` + migrations `04`–`25`)
- [Dual-chain details & ML tracks](docs/ARCHITECTURE_SUMMARY.md)

Related: [docs/whole_process.md](docs/whole_process.md) · [docs/algo_overview.md](docs/algo_overview.md) · [recommendations.md](recommendations.md) · [handoff.md](handoff.md)
