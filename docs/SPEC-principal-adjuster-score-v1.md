# SPEC — Principal + adjuster combined score v1

**Status:** handoff from Wayfinder decision pack (ready to implement)  
**Map:** [Systematic strategy brain — needs lock](../MAP.md)  
**Decision pack:** [decision-pack.md](decision-pack.md)  
**Phase:** 2 of build order  
**Date:** 2026-09-20  
**Owner lane:** autotrade & algo  
**Depends on:** phase 1 brain OHLC + patterns (live)  
**Tooling:** Oxc, ponytail, graphify

## Goal

On **buy_bulk**, compute a **combined score** for a mint that treats:

- **Principal** strategies as the **foundation** (whether / when to open):  
  `mcap_enter_first_seen`, `mcap_enter_at_80`
- **Adjuster** strategies / signals as **score modifiers** (not new entry paths in v1):  
  `signals`, `gmgn`, `social`, `trending_bot` domains  
  + Freeview **mean pairwise Jaccard** overlap (`meanPairwiseOverlapCorr`)  
  + brain **OHLC rug patterns** (`GET /ohlc/patterns` or `include=patterns`)

Output is a stable score payload that **phase 3** will map to dynamic TP/SL + auto SL on market-brain. This SPEC does **not** change live TP/SL yet.

## Non-goals (v1)

- Changing who opens trades (principals keep their existing sim-open paths)
- Dynamic TP/SL / auto SL from score (phase 3)
- ML closed loop (phase 4)
- List polish (phase 5)
- Auto paper / realtrade
- Moving ranking onto market-brain (prior lock: local ranking stays buy_bulk)
- Price-correlation with SOL (algo `CorrelationAnalyzer`) — Freeview Jaccard only

## Architecture

```
principals (mcap first_seen / at_80 presence + outcome windows)
adjusters (signals/gmgn/social/trending presence + windows)
Jaccard meanPairwiseOverlapCorr (enabled domains)
brain GET /ohlc/patterns → rug.trip / features
        ↓
buy_bulk combinedScore(mint)  →  API + Freeview optional badge
        ↓ (phase 3)
market-brain risk from score
```

## Locked principals / adjusters

| Role | Strategy / input |
|------|------------------|
| Principal | `mcap_enter_first_seen`, `mcap_enter_at_80` |
| Adjuster domains | `signals`, `gmgn`, `social`, `trending_bot` |
| Adjuster meta | Jaccard overlap of enabled domain windows |
| Adjuster meta | Brain OHLC rug summary |

`dlmm` deferred unless Architype adds it later.

## Score model (v1 defaults)

All components mapped to **[0, 1]** then combined:

```
combined = clamp01(
  0.55 * principalScore
+ 0.20 * adjusterPresenceScore
+ 0.15 * jaccardScore
+ 0.10 * ohlcPatternScore
)
```

### principalScore

- `1.0` if either principal has an **open** or **won** outcome window overlapping “now” (or last 24h open), else  
- `0.6` if either principal has any closed outcome in window with pnl≥0, else  
- `0.3` if principal **presence** only (token in mcap tracking / strategy_presence), else  
- `0.0`

(Exact presence sources: reuse `token-locate` / `strategyPresence` + `token-chart` outcomes.)

### adjusterPresenceScore

Fraction of adjuster domains with presence in the locate window (0…1).  
Each of signals/gmgn/social/trending_bot that is present contributes `1/4`.

### jaccardScore

`meanPairwiseOverlapCorr(outcomes, enabledDomains)` if non-null, else `0`.  
`enabledDomains` = principals ∪ adjusters that have windows (same helper as Freeview).

### ohlcPatternScore

From brain `/ohlc/patterns` (prefer) or nested patterns:

- If `patterns.rug.trip === true` → `0.0` (hard soft-penalty for combined; does **not** block principal open in v1)
- Else map features into softness:  
  `1 - clamp01( max(dumpPct/0.4, avgUpperWick/0.6, (1-volDeathRatio) if present) )`  
  If patterns missing / brain error → `0.5` neutral (fail-soft)

Weights are **v1 defaults**; expose in one const module so phase 3 / tuning can change without API break.

## API

```
GET /api/strategies/combined-score?address=&chain=sol|robinhood&hours=24
```

Auth: same as other strategies routes (session / network access).

Response:

```ts
type CombinedScoreResponse = {
  success: true;
  mint: string;
  chain: "sol" | "robinhood";
  hours: number;
  combined: number; // 0..1
  weights: { principal: number; adjusterPresence: number; jaccard: number; ohlcPattern: number };
  parts: {
    principalScore: number;
    adjusterPresenceScore: number;
    jaccardScore: number | null;
    ohlcPatternScore: number;
  };
  principals: Array<{ strategyId: string; present: boolean; status?: string }>;
  adjusters: Array<{ domain: string; present: boolean }>;
  ohlcSource?: string;
  rugTrip?: boolean;
  generatedAt: string;
};
```

## UI (minimal)

- Freeview / TokenLocateHub: show **Combined score** badge next to Strategy correlation (read-only).  
- No change to domain toggles / chart paint beyond displaying the number.

## Consumer notes for phase 3

Phase 3 will take `combined` (+ optional parts) and resolve TP%/SL%/hold via brain (extend `/regime/params` or new `/risk/from-score`). Do **not** invent that mapping here — only guarantee a stable `combined ∈ [0,1]`.

## Acceptance tests

1. Unit: weight sum = 1; clamp01; rug trip → ohlcPatternScore 0.  
2. Unit: Jaccard null when &lt;2 domains → jaccardScore treated as 0 in formula.  
3. Integration: known mint with mcap presence returns `success` and principals array.  
4. Brain patterns fail → ohlcPatternScore 0.5, still 200.  
5. Freeview still loads; badge optional if score endpoint errors.

## Implementation notes

- Prefer pure functions in `src/strategies/combined-score.ts` (+ tests).  
- Reuse `meanPairwiseOverlapCorr`, token-locate presence, `fetchBrainOhlcPatterns` / market-brain client.  
- No Worker changes required in v1 (score is buy_bulk-local).

## Out of scope reminders

- Phase 3 TP/SL from score  
- Phase 4 ML  
- Phase 5 list polish  
- Follow-on auto paper / realtrade  

## Open questions → defaults

| # | Question | Default |
|---|----------|---------|
| Q1 | Score owner | buy_bulk |
| Q2 | Weights | 0.55 / 0.20 / 0.15 / 0.10 |
| Q3 | Rug trip blocks open? | No — score only in v1 |
| Q4 | Include dlmm? | No |
| Q5 | Persist scores to DB? | No — compute on read |

