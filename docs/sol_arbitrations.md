# SOL Arbitration (triangular / scale loop)

Arbitration-only domain: `SOL → A → B → SOL`. No directional strategies (gmgn / signals / mcap / trending / dlmm).

## Locked shape

| Item | Choice |
|------|--------|
| MVP | Sequential three-leg loop (three txs), abort + hold inventory if a mid-leg fails |
| Hops | `RAPTOR_MAX_HOPS_ARBITRAGE` on arb Raptor calls only; global `RAPTOR_MAX_HOPS` stays default `1` |
| Multi-wallet | Out of scope |
| Atomic single-tx | Phase 3 — needs instruction compose (see below) |

## Flow (MVP)

```
quote:  SOL→A  →  A→B  →  B→SOL   (chain amountOut → next amountIn)
EV:     netSol = outSol - inSol
        roiPct = netSol / inSol * 100
execute: prepare → sign → submit → confirm per leg; stop on failure
```

## EV math

```
inSolLamports   = amount spent on leg1
outA            = leg1.amountOut
outB            = leg2.amountOut (amountIn = outA)
outSolLamports  = leg3.amountOut (amountIn = outB)
netSolLamports  = outSolLamports - inSolLamports
roiPct          = netSolLamports / inSolLamports * 100
```

Min edge gate (scanner): `netSolLamports >= SOL_ARB_MIN_EDGE_LAMPORTS` (default `0`).

## Env

| Var | Purpose | Default |
|-----|---------|---------|
| `RAPTOR_MAX_HOPS_ARBITRAGE` | maxHops for arb Raptor quote/swap only | `3` |
| `RAPTOR_MAX_HOPS` | all other bots | `1` |
| `SOL_ARB_PAIRS` | JSON array `[{"mintA":"...","mintB":"...","label":"CRX/SCX"}]` | empty |
| `SOL_ARB_AMOUNT_LAMPORTS` | scanner quote size | `100000000` (0.1 SOL) |
| `SOL_ARB_SLIPPAGE_BPS` | default slippage | `300` |
| `SOL_ARB_MIN_EDGE_LAMPORTS` | alert threshold | `0` |
| `SOL_ARB_SCAN_SECRET` | auth for `/api/sol-arb/scan` (falls back to `TRENDING_TRACKER_SECRET`) | — |
| `SOL_ARB_LIVE_ENABLED` | allow `/api/sol-arb/execute` server-side live | unset/false |
| `SOL_ARB_SCAN_INTERVAL` | cron seconds (Go) | `60` |

## APIs

| Route | Role |
|-------|------|
| `POST /api/sol-arb/quote` | Three-leg quote + EV |
| `POST /api/sol-arb/execute` | Sequential live execute (gated) or return unsigned leg txs |
| `POST /api/sol-arb/execute-atomic` | Phase 3 composed single-tx (Jupiter instructions) |
| `POST /api/sol-arb/scan` | Curated pair scan + Telegram alert on edge |

## UI

`/dev/arbitrage` (dev-gated) — Run tab (quote + sequential/atomic confirm) and Log lab (paste freeform or API JSON → Readable + Raw).

## Atomic single-tx (Phase 3)

Atomic = one `VersionedTransaction` completes the cycle or fully reverts.

Needs:

1. Instruction-level swaps (Jupiter `/swap-instructions`) — not full `swapTransaction` blobs alone
2. Composer packing three ExactIn legs + ALTs into one message
3. minOuts so net edge is guaranteed or the tx fails
4. CU / size headroom (lookup tables)

Ladder: **L0 sequential (MVP)** → **L1 Jupiter instruction compose** → L2 on-chain program / L3 flash loan (not built).

## Code map

| Path | Role |
|------|------|
| `src/utils/sol-arb/` | quote, execute, scan, atomic, EV |
| `src/utils/solanatracker-raptor.ts` | `getRaptorMaxHopsArbitrage()` |
| `src/app/api/sol-arb/*` | HTTP surface |
| `src/app/(trade)/dev/arbitrage/` | Dev console UI |
| `main.go` | `sol_arb_scan` worker |

## Non-goals

- Directional strategy domains
- Global `RAPTOR_MAX_HOPS` bump
- Multi-wallet wash choreography
- Custom on-chain arb program / flash loan unless separately requested
