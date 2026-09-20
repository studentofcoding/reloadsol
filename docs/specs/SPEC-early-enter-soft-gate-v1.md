# SPEC — Early Enter soft gate + Tracker filters + Analytics minimal+price v1

**Status:** to-spec  
**Date:** 2026-09-21  
**Surface:** `reloadsol` Early Enter toast + Telegram; `/dev/signals?tab=tracker` (`TrackerTab`) filters + analytics panel  
**Lane:** autotrade & algo  
**Depends on:** live mcap tracking, closed-loop ML (`ML_CLOSED_LOOP`, `cl-*`), Tracker catch-train (#40)

**Provenance:** Wayfinder map *early-enter-ml-gate* (locked 2026-09-21). Implement from this document; do not reopen grilling unless a lock is contradicted by production data after ship.

This PR is **documentation only**. No product code.

---

## Implementer checklist (build first)

1. **Soft-gate Early Enter at emit time** — toast + Telegram share one rule. Closed-loop `mlScore` (`cl-*`) available and **≥ 0.55**; n/a or below cut → **suppress** (no quieter watch substitute). Pattern `pWinner` stays display-only.
2. **Do not touch** mcap sim-open / paper / `EVAL_SHADOW`. Z is **not** an entry gate.
3. **Tracker filters** on `tab=tracker`: Z-Score, Anomaly Type, Momentum, Risk Score. Momentum + base Risk from list fields; Z / Anomaly from the analytics cohort (POST or equivalent page/list cohort).
4. **Analytics banner** — align/drop `maxAge` with list `timeFilter`; never 404 empty/partial batches; distinguish error vs stale vs missing mint.
5. **Price migrate** — analytics enrich off `price.jup.ag/v4` onto `getUsdPrices` / `/api/tokens/prices` (Jupiter Price V3). Thin price must not fail the batch.

---

## 1. Goal

One implementation slice that:

1. Makes Stage-1 **Early Enter** “ML-checked” as a **toast/Telegram soft gate** (closed-loop only).
2. Adds **Tracker list filters** for the Analytics strip fields the operator already sees (Z, Anomaly, Momentum, Risk).
3. Fixes the **“Analytics data not available / Retry Analytics”** banner (list freshness vs `maxAge: 60` + 404-on-empty) and migrates analytics price off the sunset Jupiter v4 host.

### 1.1 Non-goals (out of scope)

- Live (real) trading from Early Enter.
- Turning off `EVAL_SHADOW` / eval paper opens globally.
- Changing mcap `sim-track` / sim-open skip reasons or paper size.
- Redesigning Risk label semantics (Risk remains a **danger** heuristic, not “good to enter”).
- Phase-5 list polish unrelated to these four filters.
- Z as an Early Enter / paper entry trigger (`Z ≥ 2.5` is **display only**).
- A quieter “watch” toast when ML is n/a or below cut.
- Training a new model or flipping `ML_CLOSED_LOOP` / Pattern enforce modes.

---

## 2. Locked decisions (do not reopen)

| Decision | Lock | Ticket |
|---|---|---|
| What “ML-checked Early Enter” means | **Soft gate on toast only.** Emit when ML available + above threshold. No paper / sim-open change. | `what-does-ml-checked-early-enter-mean` |
| Which ML + cut | Closed-loop **`mlScore` (`cl-*`) ≥ 0.55**. Pattern `pWinner` **display only**. ML n/a → **suppress** toast (no watch substitute). | `which-ml-and-threshold-for-soft-gate` |
| Who owns the gate | **Toast only** (signals Early Enter UI + Telegram). Derived: no sim-open change. | `who-owns-early-enter-ml-gate` |
| Telegram | **Same suppress rule** as UI toast. No quieter Telegram-only path. | `telegram-soft-gate-parity` |
| Z ≥ 2.5 + first_seen | **C — display only.** Entry stays first_seen / milestone / combined (+ soft-gate ML on toast). No Z gate on toast or paper. | `is-z-2-5-first-seen-an-entry-trigger` |
| Tracker filters | **In destination** (same to-spec). Z / Anomaly / Momentum / Risk. UX presets left to this SPEC. | `tracker-filters-z-anomaly-momentum-risk` |
| Analytics banner | **In destination.** Root cause locked: list `timeFilter` vs analytics `maxAge: 60`; empty after filter → **404** → whole query fails; Retry = same POST; Jupiter thin ≠ banner. | `research-analytics-unavailable-root-cause` |
| Analytics fix scope | **minimal+price** — maxAge align + no-404 + clearer UX, plus price migrate to `/api/tokens/prices` and/or Jupiter Price V3. | `analytics-fix-scope` |

Standing (map, not a new ticket): Risk score = danger heuristic, **not** “risk to enter.” `EVAL_SHADOW` stays shadow unless a later ticket unlocks opens.

---

## 3. As-built (verified in repo before writing this section)

### 3.1 Hypothesis — confirmed

> Soft gate reads closed-loop score the **same way** catch-train / combined-score ML badges do.

| Consumer | Path | What `mlScore` is |
|---|---|---|
| Tracker ML badge | `useTrackerScoreBadges` → `GET /api/strategies/ml/score` and `GET /api/strategies/combined-score` | `finiteOrNull(mlPayload.mlScore) ?? finiteOrNull(combinedPayload.mlScore)` |
| Both APIs | `loadCombinedScore` (`combined-score-load.ts`) | If `ML_CLOSED_LOOP` off → `mlScore: null`. Else `scoreClosedLoopFromCombined` → `inferClosedLoopScore` + `modelVersion` like `cl-*`. |
| Catch-train decision | `deriveDecision` in `tracker-insights.ts` | `CATCH_ML_MIN = 0.55`: `isFiniteScore(mlScore) && mlScore >= 0.55` (one of three catch legs). |

**Do not** invent a second closed-loop infer path. Soft gate must use `loadCombinedScore` / `scoreClosedLoopFromCombined` (or a thin wrapper over the same helpers + `loadClosedLoopModel`). Fail-soft null = **unavailable**.

### 3.2 Early Enter today (no closed-loop gate)

```
GET /api/trading/signals  (+ signals_refresh worker hitting the same route)
  → fetchAndScoreSignals
  → enrichSignalsWithPatternShadow   // Pattern pWinner only; never gates
  → emitSignalsEarlyAlertsFromScored
        shouldEmit: decision=enter && growth < 100 && not stuck && not rugged
        recordSignalsEarlyAlert → in-memory pending + 24h dedup
  → for each recorded alert:
        notify.telegram → sendSignalsEarlyEnterAlert
        notify.ui off → discardPendingSignalsEarlyToasts
UI toast poll: GET /api/mcap-tracking/sim-open-alerts → drainSignalsEarlyAlerts
```

- Pattern ML is **shadow display only** (`mlShadow: true`, toast snippet `ML pW …` or `ML n/a`). Confirmed in `signals-early-alerts.ts`.
- `ScoredSignal` has `ml_pattern_p_winner` / `ml_pattern_predicted`. It does **not** carry closed-loop `mlScore`.
- Telegram iterates the **same** `earlyAlerts` array. Suppressing **before** `recordSignalsEarlyAlert` automatically covers Telegram + toast. If emit is ever split, apply the same predicate.

### 3.3 Analytics banner today

```
TrackerTab
  ├─ useMCapTracker → GET /api/mcap-tracking?action=list  (timeFilter default "all")
  └─ useTokenAnalytics(tokenAddresses)
       POST /api/analytics/token  { tokenAddresses, maxAge: 60 }
            SQL: last_updated_at >= now()-60m
            empty → 404 success:false
            hook throws on !ok or !success → analyticsData = {}
            expanded panel: analyticsData[mint] missing → "Analytics data not available"
```

Jupiter `price.jup.ag/v4` soft-fails to `{}`. Thin price does **not** cause the banner. Z is computed from the mcap-growth **cohort** (`ZScoreAnomalyDetector`, `crossSectionMinCohort = 3`) and does not need Jupiter.

---

## 4. Early Enter soft gate

### 4.1 Predicate

Existing emit eligibility (`shouldEmitSignalsEarlyAlert`) is **unchanged**:

`decision === 'enter'` AND `mcap_growth_percent < 100` AND not stuck AND not `label === 'rugged'`.

**New conjunct** (when the soft-gate flag is on, default on):

```
available  = mlScore != null && Number.isFinite(mlScore)
             && ML_CLOSED_LOOP enabled && closed-loop model loaded
pass       = available && mlScore >= EARLY_ENTER_ML_MIN   // default 0.55
emit toast + Telegram iff shouldEmit && pass
```

| `mlScore` | Action |
|---|---|
| finite and ≥ 0.55 | Emit (toast + Telegram, subject to existing notify flags + 24h dedup) |
| finite and &lt; 0.55 | **Suppress** — do not record, do not toast, do not Telegram |
| `null` / non-finite / flag off / model missing / infer throw | **Unavailable → suppress** (same as below-cut). No watch/downgrade toast. |

Pattern `pWinner` / `predicted` remain attached for **display** on emitted alerts only. They must not appear in the emit predicate.

Z, anomaly, momentum, Risk, first_seen age, and combined score are **not** part of this gate.

### 4.2 Where to wire

| File | Change |
|---|---|
| `src/strategies/signals-early-alerts.ts` | Gate **before** `recordSignalsEarlyAlert` so the 24h dedup key is **not** burned on a suppress. Prefer a pure helper `passesEarlyEnterMlSoftGate(mlScore, opts)` + async enrich that attaches closed-loop score, then filter. |
| `src/app/api/trading/signals/route.ts` | After Pattern shadow enrich, load closed-loop `mlScore` for Stage-1 candidates (batch / concurrency-capped, fail-soft null). Pass into emit. Telegram path stays “for each recorded alert” — no second rule. |
| Telegram | `src/utils/telegram.ts` `sendSignalsEarlyEnterAlert` — no extra gate if emit is shared. If a future split appears, copy the same predicate. |

Suggested attach field on `ScoredSignal` / alert (implementation PR): `ml_closed_loop_score` + `ml_closed_loop_version` (`cl-*`). Do not overload `pWinner`.

`emitSignalsEarlyAlertsFromScored` is sync today. Either:

- make a sibling `emitSignalsEarlyAlertsFromScoredAsync` that scores then emits, or
- score in the route, attach fields, keep emit sync and read `signal.ml_closed_loop_score`.

Prefer scoring in the route (or a small `signals-early-closed-loop.ts`) via **`loadCombinedScore` / `scoreClosedLoopFromCombined`**, not HTTP to `/api/strategies/ml/score` from the server.

Concurrency: cap like Pattern (`scoreStage1PatternBatch` uses 5) or catch-train badges (`MAX_CONCURRENCY = 4`). Fail-soft per mint → that mint is n/a → suppress.

### 4.3 Dedup and notify

- Suppress **before** writing `signals_enter:{chain}:{mint}` into `recentKeys`. A later poll may emit if ML becomes available.
- `notify.telegram` / `notify.ui` still apply **after** a pass. Soft gate does not override notify-off.
- When flag is off: today’s behavior (Pattern display only; no closed-loop cut).

### 4.4 Copy (emitted toasts)

Keep current title `Early Enter` and Pattern snippet (`ML pW …` / `ML n/a`). Optional (not locked): append `· cl 0.62` when `mlScore` is finite. Do not add a “suppressed” toast.

Telegram body may keep the existing Pattern shadow line. Do not add a Telegram-only “watching” message.

### 4.5 Paper / sim-open

**No change** to `mcap-tracking/sim-track`, `getMcapSimOpenSkipReason`, eval paper opens, or `ML_PAPER_MIN_ML`. Soft gate is operator notification only (same family as today’s Stage-1 alerts).

---

## 5. Z is display-only

`Z ≥ 2.5` (and `|Z| > 2.5` Risk boost in `computeRiskScore`) stays **analytics / Risk heuristic**.

Forbidden in this slice:

- `shouldEmitSignalsEarlyAlert` reading Z / anomaly
- Sim-open skip reason from Z
- “first_seen + Z cross 2.5” as an entry template

Entry remains first_seen / milestone / combined, plus this SPEC’s toast soft-gate.

Tracker **filters** may still *select* on Z (operator view). That is not an entry trigger.

---

## 6. Tracker filters (`tab=tracker`)

Add four filters in the existing **Filters & Search** grid (`TrackerTab.tsx`). Defaults = no extra restriction (same as today’s empty growth/mcap boxes).

### 6.1 Field sources

| Filter | Source | Needs analytics POST? |
|---|---|---|
| **Momentum** | List `mcap_growth_percent` → same buckets as `categorizeMomentum` / `insights.momentumLabel`. Prefer analytics `momentum_category` when present. | No |
| **Risk** | `computeRiskScore` / `riskLabel` from list (`current_mcap`, growth, stuck). Z adds **+20** only when analytics `\|z\| > 2.5`. | No for **base** Risk. Use list-only score when analytics missing so the filter still works. When analytics is present, use the same score the strip shows (Z-boosted). |
| **Z-Score** | Cohort Z on `mcapGrowthPercent` (`ZScoreAnomalyDetector`, min cohort **3**). | **Yes** — this POST after the maxAge fix, **or** equivalent: list-API join / **client page-cohort** on the current list page. Jupiter not required. |
| **Anomaly Type** | Derived from Z vs detector threshold **2.5** → `positive` \| `negative` \| `neutral`. | Same as Z |

v1 is **page-local**: filter the current list page (default `limit` 100) after insights + cohort. Do not add a new list-API query param unless pagination would otherwise lie; if you do add server params, keep them optional.

### 6.2 UX defaults (to-spec choice; no further grilling)

Place a second row under the existing growth/mcap/time controls. Empty / “Any” = show all.

| Control | Type | Options / presets |
|---|---|---|
| **Z-Score** | single select | `any` (default) · `\|z\| ≥ 2.5` · `\|z\| ≥ 1.5` · `z ≥ 2.5` · `z ≤ −2.5` · `unavailable` (`z_score_available === false` or missing) |
| **Anomaly Type** | multi-select chips | `positive` · `negative` · `neutral`. Empty = all. |
| **Momentum** | multi-select chips | `explosive` · `strong` · `moderate` · `weak` · `negative` · `unknown`. Empty = all. Buckets: ≥1000 / ≥500 / ≥100 / ≥0 / &lt;0 / non-finite. |
| **Risk** | multi-select chips + optional min/max | Chips: `Unknown` · `Low` · `Med` · `High` (same cuts as `riskLabelFromScore`: High ≥70, Med ≥45). Optional number boxes `minRisk` / `maxRisk` 0–100, same pattern as min/max growth. Empty chips + empty numbers = all. |

Unknown Risk (thin price+volume → `riskScore` null) is a **first-class** chip, not hidden.

Copy on Risk: do not imply “safe to enter.” Existing strip language (“Risk: 72/100 High”) is fine. Tooltip optional: “Danger heuristic — not an entry signal.”

### 6.3 Client state

Extend local filter state (not necessarily `FilterOptions` on the list GET):

```ts
type TrackerAnalyticsFilters = {
  zPreset: 'any' | 'abs_2_5' | 'abs_1_5' | 'pos_2_5' | 'neg_2_5' | 'unavailable'
  anomalyTypes: Array<'positive' | 'negative' | 'neutral'>
  momentumLabels: Array<'explosive' | 'strong' | 'moderate' | 'weak' | 'negative' | 'unknown'>
  riskLabels: Array<'Unknown' | 'Low' | 'Med' | 'High'>
  minRisk: string
  maxRisk: string
}
```

Apply **after** `deriveTrackerTokenInsights(token, analytics, scores)` so Decision / catch-train chips stay consistent with the filtered row.

Rows with Z unavailable:

- Hidden by Z presets other than `any` / `unavailable`.
- Anomaly filter: treat missing as `neutral` only if that matches the strip (`analytics.anomaly_type \|\| "neutral"`); prefer **not** to invent anomaly when `z_score_available === false` — those rows match Anomaly only when the multi-select is empty.

### 6.4 Cohort for Z / Anomaly

Preferred order:

1. Use `POST /api/analytics/token` map keys after the §7 fix (same shared hook as the expanded panel).
2. If a mint is still missing, **equivalent page-cohort**: run `ZScoreAnomalyDetector.detectAnomalies` on the current page’s `mcap_growth_percent` (min 3 finite peers). This unblocks filters without waiting on price.

Do not require Jupiter for Z filters.

---

## 7. Analytics fix — **minimal+price**

Root cause (research, `studentofcoding/reloadsol`): list freshness (`timeFilter`, often `all`) vs hardcoded analytics `maxAge: 60`. Zero rows after SQL cutoff → **404** `success:false` → `useTokenAnalytics` throws → `analyticsData={}` → every expanded panel shows one banner. Partial stale mints → missing map keys → per-row banner. Retry = same POST. Jupiter thin ≠ banner.

### 7.1 Align / drop `maxAge`

`useTokenAnalytics` must **stop hardcoding** `maxAge: 60`.

Pass through from Tracker list `timeFilter`:

| `timeFilter` | Analytics `maxAge` (minutes) |
|---|---|
| `all` | **omit or `0`** — no `last_updated_at` cutoff (route already skips cutoff when `!(maxAge && maxAge > 0)`) |
| `1h` | `60` |
| `4h` | `240` |
| `24h` | `1440` |
| `3d` | `4320` |
| `7d` | `10080` |
| `1m` | `43200` |

Hook signature suggestion: `useTokenAnalytics(tokenAddresses, { maxAgeMinutes })`. Other callers keep today’s default 60 unless they also pass through a freshness window.

### 7.2 Never 404 on empty / partial batches

`POST /api/analytics/token` (`src/app/api/analytics/token/route.ts`):

| Situation | Today | Required |
|---|---|---|
| Invalid JSON / empty addresses / &gt;100 | 400 | 400 unchanged |
| DB throw | 500 | 500 unchanged |
| Enrich throw | 500 | 500 unchanged |
| **Zero rows after maxAge / unknown mints** | **404 `success:false`** | **200 `success:true`** + `data: []` (or partial array) |
| Some mints in DB, some not | 200 + subset | 200 + subset; **do not** fail the batch |

Required response shape (additive):

```ts
{
  success: true,
  data: EnrichedTokenData[],          // only rows that enriched
  missing?: Array<{
    token_address: string
    reason: 'not_found' | 'stale' | 'dropped'
  }>
}
```

`success: true` even when `data` is empty. `useTokenAnalytics` must **not** throw on empty `data`.

400/500 remain errors. Client may still throw on those.

### 7.3 Client UX — not one banner for all

Expanded panel (`TrackerTab` ~2551–2691) today: `analytics ? grid : "Analytics data not available" + Retry`.

Split:

| State | Copy (defaults) | Retry? |
|---|---|---|
| `analyticsQuery.isFetching` && no data | existing spinner | no |
| `analyticsQuery.isError` | **Analytics request failed** — show HTTP/status or `error.message`. | Yes — refetch |
| Query success, mint in `missing` with `stale` | **Stale vs list filter** — e.g. “Not in analytics window (older than list freshness).” | Optional refetch |
| Query success, mint `not_found` / absent | **No analytics row for this mint.** | No global “Retry” as the only story; refetch still allowed |
| Query success, mint present | Existing Z / Anomaly / Momentum / Risk grid. Thin price: **Price unavailable** (already in catch-train SPEC) — do **not** collapse to the banner. | n/a |

List-row chips (`deriveTrackerTokenInsights`) stay fail-soft and must not use this banner.

### 7.4 Price migrate

`fetchJupiterPriceData` in `api/analytics/token/route.ts` calls **`https://price.jup.ag/v4/price`** (sunset). Replace with the in-app path:

1. **Preferred:** `getUsdPrices` from `src/utils/usd-prices.ts` (same engine as `POST /api/tokens/prices`). Already uses `https://api.jup.ag/price/v3`.
2. Acceptable: internal fetch to `/api/tokens/prices` only if process-local import is awkward in tests — prefer import over HTTP-to-self.

Rules:

- Soft-fail → `{}` / unpriced; **never** fail the analytics POST because price is thin.
- `current_price_usd` from `prices[mint]`; missing → 0 / omit as today, panel stays up.
- `volume_24h`: Price V3 / `getUsdPrices` does **not** return volume. **Do not** revive v4 to get volume. Leave `volume_24h` undefined unless another existing in-app source is already on the request. Insights already treat missing volume as thin / “unknown” liquidity.
- `DataAggregationService` in `data-aggregation.ts` still has a parallel v4 helper; **not** on the Tracker POST path. Optional cleanup in this slice if you touch that file; not required to close the banner.

---

## 8. Files to touch (implementation PR)

| Path | Why |
|---|---|
| `src/strategies/signals-early-alerts.ts` | Soft-gate predicate; emit only on pass |
| `src/strategies/signals-early-alerts.test.ts` | Table tests for suppress / pass / flag off |
| `src/app/api/trading/signals/route.ts` | Attach closed-loop score; Telegram stays on recorded alerts |
| `src/strategies/combined-score-load.ts` / `closed-loop-ml.ts` | **Reuse** — do not fork infer |
| `src/hooks/useTrackerScoreBadges.ts` | Citation only (same `mlScore`); no required change |
| `src/hooks/useTokenAnalytics.ts` | Pass `maxAge`; do not throw on empty success |
| `src/app/api/analytics/token/route.ts` | No 404 empty; missing[]; price via `getUsdPrices` |
| `src/components/signals/TrackerTab.tsx` | Filters + panel UX states |
| `src/components/signals/tracker-insights.ts` | Filter helpers / momentum+risk from list |
| `src/hooks/useMCapTracker.ts` | Only if list `FilterOptions` gains server fields |
| `src/utils/usd-prices.ts` / `src/app/api/tokens/prices/route.ts` | Price source (reuse) |
| `src/utils/algo/anomaly-detection.ts` | Page-cohort fallback if used client-side |
| `src/utils/telegram.ts` | No extra gate unless emit is split |

---

## 9. Flags

Default **soft gate on**. Comment in env docs; no secrets.

| Variable | Default | Meaning |
|---|---|---|
| `EARLY_ENTER_ML_SOFT_GATE` | **on** (`1` / unset) | `0` / `false` restores today’s emit (Pattern display only, no cl cut). Parse like `src/utils/tracker-flags.ts` (`1`/`true` vs `0`/`false`, fallback **true**). |
| `EARLY_ENTER_ML_MIN` | `0.55` | Closed-loop cut. Product lock is 0.55; flag exists so calibration can move without a code edit. |
| `ML_CLOSED_LOOP` | off (existing) | When off, `loadCombinedScore` returns `mlScore: null` → soft gate **suppresses**. Do not auto-enable this flag. |
| `TRACKER_ANALYTICS_MAX_AGE` | (optional) | Override minutes if you need a global cap; list `timeFilter` still wins when passed. Not required. |

`EVAL_SHADOW`, `ML_PATTERN_MODE`, `ML_GATE_MODE`, `TRACKER_CATCH_TRAIN`, `TRACKER_SCORE_BADGES` — unchanged.

---

## 10. Acceptance criteria

### Early Enter

- [ ] Closed-loop `mlScore` comes from `loadCombinedScore` / `scoreClosedLoopFromCombined` (same artifact as `/api/strategies/ml/score` and catch-train badges).
- [ ] Emit toast **only** when `mlScore` finite and ≥ 0.55 (flag on).
- [ ] `mlScore` null / model off / infer fail → **no** toast and **no** Telegram.
- [ ] `mlScore` 0.54 → suppress; 0.55 → emit (if other Stage-1 rules pass).
- [ ] Pattern `pWinner` still display-only on emitted alerts; a high `pWinner` with n/a cl score does **not** emit.
- [ ] Telegram uses the same recorded-alert set (or the same predicate).
- [ ] Suppress does **not** write the 24h dedup key.
- [ ] `EARLY_ENTER_ML_SOFT_GATE=0` → pre-SPEC emit behavior.
- [ ] No diff in `mcap-sim-track` / sim-open skip / eval paper opens.

### Z

- [ ] No Z conjunct in Early Enter or sim-open.
- [ ] Expanded strip may still color `|z| > 2.5`.

### Tracker filters

- [ ] Four controls on `tab=tracker`: Z, Anomaly, Momentum, Risk.
- [ ] Defaults show the same set as today (no hidden rows).
- [ ] Momentum + base Risk work with list data alone.
- [ ] Z / Anomaly work from POST cohort and/or page-cohort (min 3).
- [ ] Risk chips include Unknown; copy does not say “good to enter.”

### Analytics

- [ ] `timeFilter=all` → analytics has **no** 60m cutoff.
- [ ] Empty / partial batch → **200** `success: true`, never 404-for-empty.
- [ ] Expanded panel distinguishes request error vs stale vs missing mint.
- [ ] Retry on real errors; Retry is not the only copy for “mint not in map.”
- [ ] No `price.jup.ag/v4` on the analytics route; prices from `getUsdPrices` / Price V3.
- [ ] Thin / missing price does not 404 and does not replace the panel with the old banner.

---

## 11. Test plan

No product tests in this docs PR. Implementation PR ships:

### 11.1 Soft gate (unit)

| Fixture | Expect |
|---|---|
| `shouldEmit` true, `mlScore = 0.55`, flag on | record + toast |
| `mlScore = 0.549` | no record |
| `mlScore = null` | no record |
| `ML_CLOSED_LOOP` off | no record (flag on) |
| infer throws | no record |
| `pWinner = 0.99`, `mlScore = null` | no record |
| `pWinner = 0.10`, `mlScore = 0.70` | record; toast still shows Pattern snippet |
| flag off, `mlScore = null`, Stage-1 eligible | record (legacy) |
| suppress then later score ≥ 0.55 | second poll may emit (dedup not burned) |
| `notify.telegram` off, pass | no Telegram; toast per `notify.ui` |

### 11.2 Analytics API

- `maxAge` 0 / omitted → SQL has no `last_updated_at` cutoff.
- `maxAge` 60 → cutoff present.
- Zero DB rows → 200 `{ success: true, data: [] }`, not 404.
- Two requested, one row → 200, `data.length === 1`, `missing` includes the other.
- `getUsdPrices` reject / empty → still 200 with mcap enrich; `current_price_usd` 0 / missing.
- No outbound host contains `price.jup.ag`.

### 11.3 Hook + UI (light)

- `fetchTokenAnalytics` on `{ success: true, data: [] }` returns `{}` and does not throw.
- `isError` panel copy ≠ missing-mint copy.
- Filter: momentum `explosive` hides `weak` list rows using growth only.
- Filter: Z `\|z\| ≥ 2.5` keeps only finite Z matching the preset.
- Risk `Unknown` keeps thin-data rows.

---

## 12. Suggested code shape (implementation PR, not this one)

```ts
export const DEFAULT_EARLY_ENTER_ML_MIN = 0.55

export function isEarlyEnterMlSoftGateEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // unset → true (default on)
}

export function passesEarlyEnterMlSoftGate(
  mlScore: number | null | undefined,
  opts?: { min?: number; enabled?: boolean },
): boolean {
  if (!(opts?.enabled ?? true)) return true
  const min = opts?.min ?? DEFAULT_EARLY_ENTER_ML_MIN
  return mlScore != null && Number.isFinite(mlScore) && mlScore >= min
}
```

Keep this helper free of I/O so tests do not load the model.

---

## 13. Open items (non-blocking)

1. Whether to show `cl 0.62` on the toast — optional display, not a lock.
2. Server-side list filters for Z (cross-page) — v1 is page-local.
3. Volume after v4 removal — leave undefined unless an existing source is free.
4. Cleaning `DataAggregationService`’s unused v4 helper.

---

## 14. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-21 | ML-checked Early Enter | Soft gate, toast only; no paper |
| 2026-09-21 | Artifact + cut | `cl-*` `mlScore` ≥ 0.55; n/a suppress; Pattern display |
| 2026-09-21 | Owner | `signals-early-alerts` + Telegram; not sim-open |
| 2026-09-21 | Telegram | Same suppress as UI |
| 2026-09-21 | Z ≥ 2.5 | Display only |
| 2026-09-21 | Tracker filters | In destination; UX defaults in this SPEC |
| 2026-09-21 | Analytics | Banner = maxAge vs list + 404 empty; Jupiter thin ≠ banner |
| 2026-09-21 | Fix scope | **minimal+price** |
| 2026-09-21 | Score source (repo verify) | Same `loadCombinedScore` `mlScore` as catch-train badges / `/api/strategies/ml/score` |

---

## 15. Related docs

- Catch-train (scores + Risk rewrite): [SPEC-tracker-catch-train-v1.md](./SPEC-tracker-catch-train-v1.md)
- Closed-loop / eval: [../04-machine-learning.md](../04-machine-learning.md), `ml/README.md`
- Stage-1 alerts: [../ML_GATE_PLAN.md](../ML_GATE_PLAN.md) (Pattern remains display-only)
- Strategy spine: [../03-strategies-and-automation.md](../03-strategies-and-automation.md)
- Research notes (Wayfinder asset, not in-repo): `analytics-unavailable-findings.md`
