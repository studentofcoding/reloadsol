# SPEC — Target machine spine v1

**Status:** implemented (2026-09-24)  
**Date:** 2026-09-24  
**Related:** [SPEC-ohlc-rug-spine-v1.md](./SPEC-ohlc-rug-spine-v1.md) (OHLC Stage-1 facts)

## Goal

One tidy entry spine for paper opens:

`rug → cl(p) → size/TP/SL(p) → paper execute → resolve → retrain`

## Locked decisions

| Lock | Value |
|------|--------|
| Execute | **Paper / sim only** (no live flips on this spine) |
| Stage 2 `p` | Closed-loop `mlScore` only (not ML1 `pBad`, not Pattern `pWinner`) |
| OHLC | Existing dump/wick/vol **+** `up_only_10` (see OHLC SPEC) |
| `up_only_10` | Last **10×1m** all `c > o`; no trip if `n < 10` |
| Enforce | OHLC hard-reject on Target **paper** paths only; elsewhere shadow |
| Gallery | Out of scope — `signal_ohlc_labels` is corpus for later calibration, **not** the gate |

### Demotions (not Stage-2 / not parallel product)

- Noul as enter gate
- Pattern enforce as Stage-2
- ML1 / v2 soft-size-as-gate (size comes from `cl` `p` instead)
- Z / anomaly enter
- Early Enter as a second product on this spine

### Keep as Stage-1 candidates

Strategy templates (`first_seen`, `at_80`, …) feed candidates into the spine. Rug list + OHLC trip are rug facts.

## Stages

1. **Rug** — OHLC last ≤10×1m via `evaluateOhlcRugRules` / `attachOhlcRugShadow`. On paper sim-track: `enforce: true` → skip open on trip.
2. **Score** — `p =` closed-loop `mlScore` from `loadCombinedScore` / `scoreClosedLoopFromCombined`. Fail-soft; missing → `p = 0.5` for sizing (no hard gate).
3. **Size / TP / SL** — [`target-machine-cl-size.ts`](../src/strategies/target-machine-cl-size.ts): size via `softMlSize(base, { pBad: 1 - p })`; TP/SL multipliers `0.8+0.4p` / `1.2-0.4p` on strategy base exit %.
4. **Paper execute** — existing signals / mcap sim opens.
5. **Resolve → retrain** — Stage **5a** (shipped): paper resolve honors stamped `cl` TP/SL. Signals manage closes on score `exit` **OR** frozen `effective_exit` (prefer mcap growth `entry_mcap`→live, else price PnL via `shouldCloseSignalsClExit`). Auto-retrain / cron train still out of scope.

## Wire points

| Path | Behavior |
|------|----------|
| `GET/POST` signals `sim-track` | Always paper: OHLC enforce; size/TP/SL from `cl`; ML1/Pattern stamp only (`enforce: false`) |
| mcap `sim-track` when **simulated** | Same as signals |
| mcap `sim-track` when **live** | Unchanged (OHLC shadow; existing ML1/Pattern enforce) |
| Elsewhere (radar, list, concentration) | OHLC shadow only |

## Out of scope v1

- Gallery / corpus training / labeling honesty
- Global OHLC `enforce: true`
- Live execute on this spine
- Auto-retrain / cron train (Stage 5b+)
