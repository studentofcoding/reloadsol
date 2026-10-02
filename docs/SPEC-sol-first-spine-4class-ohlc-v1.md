# SPEC — Sol-first spine: 4-class OHLC second head + soft size v1

**Status:** draft (Wayfinder handoff)  
**Date:** 2026-09-27  
**Wayfinder map:** [Wayfinder: Sol-first spine — 3-class + OHLC second head](https://github.com/studentofcoding/reloadsol/issues/79) (all child tickets closed)  
**Related:** [SPEC-target-machine-spine-v1.md](./SPEC-target-machine-spine-v1.md) (extend; do not fork a second paper desk), [SPEC-ohlc-rug-spine-v1.md](./SPEC-ohlc-rug-spine-v1.md), [docs/04-machine-learning.md](./04-machine-learning.md), [SPEC-token-info-universal-ledger-v1.md](./specs/SPEC-token-info-universal-ledger-v1.md) (immutable detect Token Info ledger for the concentration soft path and later enrichment; does not replace 4-class labels or the live >65% hard ban)

## Goal

One Sol-first paper spine:

`filter → CL p + OHLC 4-class second head → soft size → paper execute → label / retrain`

Buy sides for this SPEC: **`mcap_enter_first_seen`** and **`mcap_enter_at_80`** only. Everything else is brake / label / report — not a new buy button.

## Locked decisions (product)

| Lock | Value | Ticket |
|------|--------|--------|
| Execute | Paper / Target–EVAL spine only | map Notes |
| Stage-2 `p` | Closed-loop CL `mlScore` stays Stage-2 | map / Target SPEC |
| OHLC role | **Second head for sizing** — past ≤10×1m at alert → class probs | OHLC v1 room lock |
| OHLC head targets | **4-class growth only** (no P(rug) from OHLC head) | [#86](https://github.com/studentofcoding/reloadsol/issues/86) |
| 4-class cuts | loser `<0%`; bep `≥0%` and `≤20%`; winner `>20%` and `<120%`; moonbag `≥120%` | [#83](https://github.com/studentofcoding/reloadsol/issues/83) |
| Binary Pattern (≥120 / `<80`) | Temporary **shadow** until 4-class READY, then **retire** (archive OK) | [#83](https://github.com/studentofcoding/reloadsol/issues/83), [#88](https://github.com/studentofcoding/reloadsol/issues/88) |
| Sleeve rug SoT | **Concentration soft score**; hard ban `>65%` stays **outside** soft size | [#86](https://github.com/studentofcoding/reloadsol/issues/86) |
| Soft size | Missing usable ≤10 bars → **CL-only**; with bars → OHLC risk sleeve × CL rank inside sleeve; sleeve may enlarge or soft-zero | [#82](https://github.com/studentofcoding/reloadsol/issues/82) |
| bep on sleeve | **Mild shrink** (not neutral; weaker than loser) | [#87](https://github.com/studentofcoding/reloadsol/issues/87) |
| READY ladder | Paper-shadow OHLC first; **one READY flip** enables sleeve soft-size | [#85](https://github.com/studentofcoding/reloadsol/issues/85) |
| High-loss labels | `gmgn_sm_kol_combined` + `kol_momentum`; fire must precede dump / negative growth; **train/features + reports only** (no live veto) | [#84](https://github.com/studentofcoding/reloadsol/issues/84) |
| Dropped | first_mcap band as brake; Bubblemaps; generative next-10 candles; live enforce while not READY | map Out of scope |

## Stages

### 1. Filter / candidates

- Enter candidates from **first-seen** and **~80k** mcap strategies only for this spine’s buy side.
- Hard concentration ban (`CONCENTRATION_BAN_PCT`, live **65**) remains a **hard skip** outside soft size.
- Other signals (social FOMO, trending, high-loss fires, etc.) may annotate / brake / label — they do **not** open a parallel buy path in v1.

### 2. Probability

| Head | Output | When used for size |
|------|--------|--------------------|
| CL Stage-2 | scalar `p` | Always (rank inside sleeve, or sole size when CL-only) |
| OHLC second head | `P(loser), P(bep), P(winner), P(moonbag)` | Soft-size sleeve **after READY**; until READY → **paper-shadow log only** |
| Concentration | soft score (same feature family as hard ban) | Sleeve soft-zero / enlarge gate; **not** ML-READY-gated |
| Binary Pattern | shadow `pWinner`-style until READY | Log / compare only; **retire on READY** |

Feature window for OHLC head: **past ≤10×1m bars as-of alert** (own-1m OK). Generative next-10 candle forecast is **out of scope**.

### 3. Soft size (formula sketch — numerics TBD)

```
if n_usable_1m_bars < usable_threshold:   # v1 intent: need ≤10 available
  size ∝ CL_p                              # CL-only
else if not ohlc_4class_READY:
  size ∝ CL_p                              # still CL-only; log OHLC probs (shadow)
else:
  sleeve = f(
    P_moon, P_winner,   # enlarge when high AND concentration soft score low
    P_bep,              # mild shrink
    P_loser,            # stronger shrink
    concentration_soft  # soft-zero when high; may override
  )
  size = sleeve × rank(CL_p)
  # sleeve → 0 allowed; CL does not force a fill that tick
```

**Class direction (locked):**

| Signal | Sleeve effect |
|--------|----------------|
| moon / winner + low concentration soft | enlarge |
| bep | mild shrink |
| loser | stronger shrink |
| high concentration soft | soft-zero (may override) |

**TBD after first OOS / READY calibration (map fog):** numeric enlarge / shrink / soft-zero multipliers and concentration soft thresholds below the hard 65% ban.

### 4. Paper execute

- Extend Target / EVAL paper paths (`sim-track` / existing paper opens).
- No live flips on this spine while models are not READY / out of scope for v1 live enforce.

### 5. Label / retrain

- Primary growth labels: **4-class** on Sol `token_mcap_tracking` (full table labelable; former 0–20% gap = bep). See research [#80](https://github.com/studentofcoding/reloadsol/issues/80).
- High-loss strategy fires: feature / report corpus only ([#84](https://github.com/studentofcoding/reloadsol/issues/84)).
- Binary Pattern export/train as shadow until READY, then stop serving ([#88](https://github.com/studentofcoding/reloadsol/issues/88)).

## READY gates (4-class OHLC head)

Until READY: log OHLC probs; **sizing stays CL-only**.

**All must pass** (no human-sign-off gate). Soft placeholders — revisit after first OOS ([#85](https://github.com/studentofcoding/reloadsol/issues/85)):

| Bar | Soft placeholder |
|-----|------------------|
| F1 | macro ≥ **0.40**; no class F1 < **0.25** (excl. rare if n tiny) |
| n / coverage | train labeled ≥ **1,500**; OOS labeled ≥ **300**; ≥**60%** of sleeve-eligible alerts have usable ≤10 bars |
| Lead-time / as-of | pred usable **before** size decision on first-seen / @80 (own-1m OK; ST freeze = fail) |
| Calibration | ECE ≤ **0.15** or reliability slope in **[0.7, 1.3]** on OOS |
| OOS beat | sleeve soft-size **beats CL-only** on same cohort (PnL or utility proxy) |

On READY flip: enable sleeve soft-size **and** retire binary Pattern shadow the same day.

## Feasibility notes (research)

- Label coverage: Sol mcap fully labelable under 4-class ([#80](https://github.com/studentofcoding/reloadsol/issues/80)).
- OHLC density: v1 train feasible on label/detect-capture (~3k ge10 / ~1.7k ∩ old 3-class); blocked as-of first_seen (ST freeze); enter@80 grows via own-1m ([#81](https://github.com/studentofcoding/reloadsol/issues/81)).

## Out of scope v1

- Bubblemaps / paid rug-filter API
- Generative next-10 candle forecast
- Live enforce / `live_only` while not READY
- Demoting mcap first-seen / at_80
- Parallel rh-tape-like second paper desk
- RH dual-chain and climate overlay (post-Sol; map fog)
- Reopening Score (#55) from this SPEC
- Numeric sleeve multipliers (calibrate after READY)

## Implementation order (suggested)

1. 4-class label export + train/eval harness (shadow serve).
2. Wire OHLC 4-class shadow probs beside CL on first-seen / @80 paper paths.
3. Concentration soft score into sleeve helpers (hard ban unchanged).
4. READY dashboard / checklist; flip → sleeve soft-size + Pattern retire.
5. Fill TBD numerics from OOS; optional follow-on SPEC amendment.

## Acceptance

- [ ] SPEC checked into `docs/` and linked from map [#79](https://github.com/studentofcoding/reloadsol/issues/79)
- [ ] No product code required to close the Wayfinder map
- [ ] Implementers can build without reopening closed grills; only TBD numerics + post-Sol fog remain
