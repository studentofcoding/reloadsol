# SPEC — Tracker catch-train + social join + decision-useful risk v1

**Status:** implement  
**Date:** 2026-09-21  
**Surface:** `reloadsol` `/dev/signals?tab=tracker` (`TrackerTab`)  
**Lane:** autotrade & algo  
**Depends on:** live mcap tracking, trending list social fields, combined-score + ML score (phase 2–4, shadow OK)

## Goal

Make Tracker the place to **catch mcap-tracker winner trains early** by:

1. Joining **trending-list social/web** (and related) onto each tracked token card  
2. Making the **Risk / Momentum / Analytics** block **decision-useful** (missing price/vol must not read as Risk 100/100 High)  
3. Adding a **catch-train strip**: early `first_seen` age + combined/ml badges + one-tap ChartBuy

## Non-goals

- Auto live buys from Tracker (keep ChartBuy manual; sim opens stay on `mcap-tracking/sim-track` cron)  
- Turning off `EVAL_SHADOW` / eval paper opens  
- Redesigning Live/Board/Roster tabs  
- Changing principal entry templates in registry (except optional display of their scores)

## Locked product rules

### A. Social / web join (from trending list)

For each Tracker row (`token_address`), attach when available:

| Field | Source priority |
|-------|-----------------|
| `twitter` | GMGN filtered trending map → Jupiter/trending payload if present |
| `telegram` | same |
| `website` | same |
| `organic_score` | Jupiter trending when present |
| `logo_url` | trending when present |

Implementation notes:

- Reuse existing mappers (`gmgn-trending-filtered.ts` `twitter`/`telegram`/`website`, `TrendingTokens.tsx` `socialUrl` helpers).  
- Prefer a **batch join** in `GET /api/mcap-tracking?action=list` (or a thin `/api/mcap-tracking/enrich` called by the hook) keyed by mint — do not N+1 from the client.  
- Cache join ~2–5 min (align with trending cache TTL).  
- UI: icon links on the card (same pattern as `TrendingTokens.tsx`); show `organic` chip when finite.

### B. Decision-useful Risk / Analytics

Rewrite `deriveTrackerTokenInsights` / `computeRiskScore` (`tracker-insights.ts`):

1. **Data quality gate:** if `current_price_usd` missing/0 **and** `volume_24h` missing → `riskLabel = 'Unknown'`, `riskScore` null or separate `dataQuality: 'thin'`, never clamp to 100 from “low mcap alone.”  
2. Low mcap only adds risk when **price or volume is present**.  
3. Drop milestones (`when_drop_40pct` / `when_drop_80pct`) → explicit **Rug signal** chip (already shown as Dropped −40%); fold into decision, not only into raw risk +.  
4. Momentum: prefer analytics `momentum_category` / signal; if analytics thin, show `momentum: unknown` not `negative` by default.  
5. Liquidity: keep vol/mcap bands; if no volume → `Liquidity: unknown` (not “No volume data” as the only story — still OK as detail).  

**Decision line** (new, one line on card):

`decision ∈ { catch | watch | skip }` with short `reason`:

| decision | when (v1) |
|----------|-----------|
| `skip` | drop −40/−80 stamped, **or** dataQuality thin + age > 30m, **or** combined < 0.25 when score available |
| `catch` | tracking age ≤ **45m** AND no drop stamp AND (combined ≥ 0.45 **or** mlScore ≥ 0.55 when ML on **or** growth ≥ 80% with liquidity not thin) |
| `watch` | else |

Show: `Decision: catch — first_seen 12m · combined 0.62` (example).

Expose scores on the card when APIs succeed (fail-soft nulls):

- `GET /api/strategies/combined-score?address=`  
- `GET /api/strategies/ml/score?address=` (null if flag/model off)

Batch or debounce (max concurrency) — do not block list render; hydrate badges async.

### C. Catch-train strip

Above the list (or sticky under filters):

- Count of tokens with `decision=catch` in current filter page  
- Sort shortcut: **Catch train** → sort by `first_seen_at` asc among catch/watch, age < 45m first  
- Per catch row: accent border + **Buy** opens existing `ChartBuyModal` (no new execution path)

Optional filter chip: `catch only`.

## API / types

- Extend list payload tokens with optional:

```ts
social?: { twitter?: string; telegram?: string; website?: string }
organic_score?: number | null
logo_url?: string | null
insights?: { /* server or client */ decision, reason, dataQuality, riskScore, riskLabel, ... }
```

Prefer computing insights **client-side** from enriched fields + hydrated scores to keep list API fast; social join can be server-side.

## UI copy / layout

Keep existing fields user listed (Risk, Momentum, Milestones, Age, Liquidity, First Seen, Status, Dropped, Last Updated, Analytics panel) but:

- Risk shows `—/100 · Unknown` when thin data  
- Analytics panel: hide fake $0.000000 as “Price unavailable”  
- Add social icons + organic + Decision line + combined/ml chips  

## Tests

- `computeRiskScore` / insights: thin data → Unknown, not High 100  
- drop stamp → skip  
- age ≤45m + combined 0.5 → catch  
- social join mapper maps twitter/telegram/website  
- Tracker card renders links when social present (component test light)

## Flags

| flag | default | role |
|------|---------|------|
| `TRACKER_SOCIAL_JOIN` | on | join trending social onto list |
| `TRACKER_CATCH_TRAIN` | on | decision line + strip |
| `TRACKER_SCORE_BADGES` | on | hydrate combined/ml |

## Done when

- Draft PR on `studentofcoding/reloadsol`  
- Screenshots or notes: thin-data card, catch card with social links, strip count  
- Do not merge/deploy unless coordinator asks  

## Notes

- Oxc / existing patterns; avoid cursoragent@ commits when possible  
- Wallet gate still applies to `/dev/signals` — no change  
- Phase-4 shadow eval remains independent; Tracker decision is UI guidance only  
