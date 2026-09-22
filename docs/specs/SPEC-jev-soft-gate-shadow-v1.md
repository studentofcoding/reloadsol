# SPEC — Jev soft-gate shadow (Noul beside Early Enter) v1

**Status:** to-spec (docs only)  
**Date:** 2026-09-22  
**Surface:** `reloadsol` Early Enter toast + Telegram emit path (`signals-early-alerts` / signals route); Admin / Algo Tester compare strip; new table `early_enter_noul_shadow`  
**Lane:** autotrade & algo  
**Depends on:** [SPEC-early-enter-soft-gate-v1.md](./SPEC-early-enter-soft-gate-v1.md) (`passesEarlyEnterMlSoftGate`, `EARLY_ENTER_ML_MIN`, `EARLY_ENTER_ML_SOFT_GATE`); TypeSafe / Jev Noul primitive; VPS TypeSafe creds (ops #56)

**Provenance:** Wayfinder map [#49](https://github.com/studentofcoding/reloadsol/issues/49) *Jev soft-gate shadow (Early Enter Noul)* (locked 2026-09-22). Implement from this document; do not reopen grilling unless a lock is contradicted by production data after ship.

This PR is documentation only. One implementation PR follows this SPEC. Prefer markdown data-model notes here (same as prior SPEC docs PRs); ship the SQL migration in the implement PR.

---

## Implementer checklist (build first)

1. **Shadow only.** At Early Enter emit (after Stage-1 eligibility, beside the existing soft gate), call TypeSafe **Noul** for the scoped mcap arms, log every outcome to `early_enter_noul_shadow`, and **do not** change toast/Telegram ownership until soft-active flip criteria are met.
2. **Soft-fail → SPEC.** Mid-band or API miss → follow `passesEarlyEnterMlSoftGate` / `mlScore ≥ EARLY_ENTER_ML_MIN` (default 0.55). Never call soft-fail “low confidence” (Noul has no confidence field).
3. **Null `cl_ml_score`.** Log `spec_would_pass=false`, band `skipped_null`, **skip Noul call** (SPEC already suppresses).
4. **Arm scope.** Only `mcap_enter_first_seen` / `mcap_enter_at_80` (and `_rh` twins on robinhood). Never paper / sim-open. Never att_rh / signals-only / gmgn / other domains as Noul arms.
5. **Admin strip.** Agreement rate + mid-band rate last 24h, split by `strategy_key`. Soft-active flip is a later ops decision against the §7 bar — not auto-flip in v1 code without an explicit flag.

---

## 1. Goal

Handoff-ready shadow for **Jev Noul** sitting **beside** the existing Early Enter soft gate:

1. Log Noul keep / suppress / soft-fail vs SPEC on the Early Enter emit path for the locked mcap A/B arms.
2. Give Admin / Algo Tester a minimal compare surface (agreement + mid-band rates).
3. Encode the flip bar to soft-active toast (Noul may suppress/emit) without touching paper opens — ever, in this destination.

**Jev = judgment only.** Code still owns opens / size. Soft-fail always lands on today’s SPEC / deterministic Early Enter path.

### 1.1 Non-goals (out of scope)

- Changing paper opens, sim-open skip reasons, size, SL/TP, or `EVAL_SHADOW`.
- Replacing or disabling `passesEarlyEnterMlSoftGate` in v1 (Noul sits **beside** it; toast stays SPEC-owned until soft-active).
- **Choice** (Raptor vs Jupiter) or **Score** (batched OHLC ranking) product behavior — later maps; one-liner only in this body (§13).
- Inventing Z, Anomaly, Pattern `pWinner`, mcap snapshot, OHLC bars, gmgn/social extras, or paper geometry into the Noul `state` payload.
- Wiring TypeSafe secrets into the repo (ops prerequisite #56).
- Promoting Sell-over-100 or inverting gmgn into a live gate.
- Live (real) trading from Early Enter / Noul.

---

## 2. Locked decisions (do not reopen)

| Decision | Lock | Ticket |
|---|---|---|
| Soft-fail mid-band | Soft-fail = **API miss** OR `NO < noul < YES`. Starting: **NO=0.2**, **YES=0.8**. Never “low confidence.” Soft-fail → existing SPEC Early Enter path (`passesEarlyEnterMlSoftGate` / `mlScore ≥ 0.55` etc.). | [#50](https://github.com/studentofcoding/reloadsol/issues/50) |
| Noul `state` payload | Include: `token_address`, `chain`, finite `cl_ml_score`, `cl_model_version`, `EARLY_ENTER_ML_MIN`, `EARLY_ENTER_ML_SOFT_GATE`, `spec_would_pass`, Stage-1 eligibility already true at emit, optional short `symbol`. Exclude: Z, Anomaly, pWinner/Pattern, paper size/SL/TP, OHLC bars, gmgn/social extras, mcap snapshot (v1). Null score → log suppress + **skip Noul**. | [#51](https://github.com/studentofcoding/reloadsol/issues/51) |
| Log sink | New table **`early_enter_noul_shadow`** (do **not** overload `strategy_ml_predictions`). Columns + Admin strip per §6. | [#52](https://github.com/studentofcoding/reloadsol/issues/52) |
| Arm scope | Shadow Noul only on Early Enter emit for **mcap first_seen** and **mcap Enter at 80%** strategy keys. Not att_rh / signals / gmgn / other domains. Paper paths **never** call Noul. | [#53](https://github.com/studentofcoding/reloadsol/issues/53) |
| Flip → soft-active | Soft-active only when **all**: N≥500 rows, agreement≥85% vs SPEC, mid-band rate≤20%, kill switches on API-fail / disagreement spike → revert shadow-only / hold soft-active off. Paper **never** flips in this destination. Until then: shadow = log only; toast owned by existing soft gate. | [#54](https://github.com/studentofcoding/reloadsol/issues/54) |

Standing (map, not new product tickets here): Jev = judgment only; code owns opens/size; Z and `pWinner` stay out of the gate; Early Enter soft gate ([SPEC-early-enter-soft-gate-v1](./SPEC-early-enter-soft-gate-v1.md)) remains toast+Telegram / paper untouched.

---

## 3. As-built (verified in repo before writing this section)

### 3.1 Early Enter soft gate (already shipping)

| Piece | Path |
|---|---|
| Predicate | `passesEarlyEnterMlSoftGate` in `src/strategies/signals-early-ml-gate.ts` — finite `mlScore` ≥ `EARLY_ENTER_ML_MIN` (default **0.55**); flag `EARLY_ENTER_ML_SOFT_GATE` default on |
| Emit | `emitSignalsEarlyAlertsFromScored` in `src/strategies/signals-early-alerts.ts` — gate **before** `recordSignalsEarlyAlert` |
| Score attach | Signals route loads closed-loop score via combined-score / closed-loop helpers (`cl-*` `modelVersion`) |
| Paper | Unchanged — soft gate is toast + Telegram only |

### 3.2 Strategy key literals (cite exactly)

Registry / DB seeds and consumers use these ids (Sol; robinhood twins append `_rh`):

| Arm (product language) | `strategy_key` literal | Entry template |
|---|---|---|
| mcap first_seen | **`mcap_enter_first_seen`** | `first_seen` |
| mcap Enter at 80% | **`mcap_enter_at_80`** | `milestone_80` |
| RH twins | **`mcap_enter_first_seen_rh`**, **`mcap_enter_at_80_rh`** | same templates on robinhood |

Cited in: `db/init/02-schema.sql` seeds; `src/strategies/closed-loop-ml.ts` principal set; `src/app/api/trading/signals/route.ts` (Telegram attaches active mcap ids beside `signals_default` / `signals_default_rh` when the mint is tracked).

**Shadow Noul arms = those four literals only** (pick Sol or RH set from emit `chain`). Do **not** use `signals_default`, `signals_sell_over_100`, att_rh, gmgn, or other domain ids as `strategy_key` for this table.

### 3.3 What not to overload

`strategy_ml_predictions` (`db/init/33-ml-eval-predictions.sql`) is the **eval-engine** shadow sink (`action=shadow_predict`, run_id accuracy rollup). Early Enter Noul shadow is a different product surface → **new table**.

---

## 4. Behavior — shadow Noul beside Early Enter

### 4.1 When to evaluate

At the Early Enter emit site (same Stage-1 eligibility as today: `shouldEmitSignalsEarlyAlert` already true — `decision === 'enter'`, growth &lt; 100, not stuck, not rugged), **and** the mint is in scope for a locked arm:

1. Resolve applicable `strategy_key` ∈ {`mcap_enter_first_seen`, `mcap_enter_at_80`} or RH twins when `chain === 'robinhood'`.
2. Only if that strategy is **active** in the merged mcap tracker registry (same spirit as signals-route Telegram `mcapIds` attach).
3. Fog default for which arm(s) when both are active:  
   - growth **&lt; 80** → `mcap_enter_first_seen`*`  
   - growth **≥ 80** (and &lt; 100 Stage-1 ceiling) → `mcap_enter_at_80`*`  
   Write **one** shadow row per evaluation with that `strategy_key`. Do not invent a combined key.

If no locked arm applies (signals-only / other domain): **do not** call Noul and **do not** write a shadow row.

### 4.2 Soft-fail and bands (#50)

Let `NO = 0.2`, `YES = 0.8` (starting thresholds; flag-tunable in implement PR without re-grilling product meaning).

| Condition | `band` | Soft-active meaning (later) | Shadow / soft-fail action |
|---|---|---|---|
| API miss / exception / missing creds | `api_miss` | Soft-fail → SPEC | Log; toast follows SPEC |
| `NO < noul < YES` | `mid` | Soft-fail → SPEC | Log; toast follows SPEC |
| `noul ≥ YES` | `keep` | Would emit toast | Log only until flip |
| `noul ≤ NO` | `suppress` | Would suppress toast | Log only until flip |
| Null / non-finite `cl_ml_score` | `skipped_null` | n/a (no Noul) | Log; **skip Noul**; SPEC already suppresses |

**Wording:** never describe soft-fail as “low confidence.” Noul has **no** confidence field; Choice/Score may use `confidence` later — not this gate.

### 4.3 Null `cl_ml_score` (#51)

When closed-loop score is null / non-finite (or soft-gate flag / model unavailable such that SPEC would suppress):

- Set `spec_would_pass = false`
- Set `noul_called = false`, `noul = null`, `band = skipped_null`
- **Do not** call Noul (do not burn mid-band / API budget on n/a)
- Toast path unchanged: SPEC already suppresses

### 4.4 Toast ownership until flip (#54)

| Mode | Who owns toast + Telegram |
|---|---|
| **Shadow** (default until flip bar + explicit enable) | Existing soft gate only. Noul is log-only. |
| **Soft-active** (after §7 + kill switches clear + flag on) | Noul keep/suppress may drive emit; soft-fail (mid / api_miss) still falls back to SPEC. |

Paper / sim-open: **never** reads Noul in either mode.

### 4.5 Where to wire (implementation PR)

| File / area | Change |
|---|---|
| `src/strategies/signals-early-alerts.ts` (+ thin helper module) | After Stage-1 + cl score attach, shadow-evaluate scoped arms; never block emit on Noul latency beyond a tight timeout → treat timeout as `api_miss` |
| `src/app/api/trading/signals/route.ts` | Ensure chain + active mcap registry ids available for arm scope (reuse existing `mcapIds` pattern) |
| New DB access helper | Insert into `early_enter_noul_shadow` |
| Admin / Algo Tester | Read-only strip: agreement + mid-band last 24h by `strategy_key` |
| `mcap-sim-track` / paper | **No touch** |

Concurrency / fail-soft: Noul errors → `api_miss` row; never throw past the Early Enter emit path.

---

## 5. Noul `state` payload (#51)

### 5.1 Include

```ts
type EarlyEnterNoulState = {
  token_address: string
  chain: 'sol' | 'robinhood' // AppNetwork as used at emit
  cl_ml_score: number        // finite only — caller must not invoke Noul otherwise
  cl_model_version: string   // e.g. cl-*
  EARLY_ENTER_ML_MIN: number
  EARLY_ENTER_ML_SOFT_GATE: boolean
  spec_would_pass: boolean   // passesEarlyEnterMlSoftGate(...)
  // Stage-1 eligibility is a precondition at the emit site (not optional false)
  symbol?: string            // optional / short
}
```

`spec_would_pass` **must** come from `passesEarlyEnterMlSoftGate` (same helper as toast), not a forked cut.

### 5.2 Exclude (v1)

- Z, Anomaly
- Pattern `pWinner` / `predicted` / Pattern fields
- Paper size / SL / TP
- OHLC bars
- gmgn / social extras
- **mcap snapshot** (leakage risk; not in SPEC gate)

---

## 6. Data model — `early_enter_noul_shadow` (#52)

Do **not** overload `strategy_ml_predictions`.

### 6.1 Columns (locked)

| Column | Notes |
|---|---|
| `predicted_at` | timestamptz, default now |
| `token_address` | text, not null |
| `symbol` | text, nullable (optional short) |
| `chain` | text / network enum as elsewhere |
| `strategy_key` | text — one of the §3.2 literals |
| `cl_ml_score` | double, nullable |
| `cl_model_version` | text, nullable |
| `spec_would_pass` | boolean, not null |
| `noul_called` | boolean, not null |
| `noul` | double, nullable (0–1 when called successfully) |
| `band` | `suppress` \| `mid` \| `keep` \| `skipped_null` \| `api_miss` |
| `decision_shadow` | what Noul path would do: `keep` \| `suppress` \| `follow_spec` (mid/api_miss/skipped_null → `follow_spec`) |
| `decision_spec` | `keep` \| `suppress` from `spec_would_pass` |

Implement PR may add `id` PK / indexes (`predicted_at DESC`, `(strategy_key, predicted_at DESC)`). Schema note only in this docs PR.

### 6.2 Compare surface

Admin / Algo Tester strip (minimal):

- **Agreement rate** last 24h — share of rows where Noul keep/suppress matches SPEC (`decision_shadow` ∈ {keep,suppress} agrees with `decision_spec`; treat `follow_spec` rows as soft-fail / exclude from agreement denominator **or** count as agreeing with SPEC — fog default: **exclude** `follow_spec` and `skipped_null` from agreement numerator/denominator; report mid-band rate separately).
- **Mid-band rate** last 24h — share with `band = mid`.
- **Split by `strategy_key`.**

---

## 7. Flip shadow → soft-active (#54)

Soft-active (Noul may suppress/emit Early Enter toast) only when **all** of:

| Criterion | Lock |
|---|---|
| Sample size **N** | ≥ **500** rows in `early_enter_noul_shadow` |
| Agreement vs SPEC | ≥ **85%** (Noul keep/suppress matches SPEC toast path / `spec_would_pass`) |
| Mid-band rate | ≤ **20%** of rows land mid-band |
| Kill switches | On **API fail spike** or **disagreement spike** → revert to shadow-only / hold soft-active **off** |
| Paper | **Never** flips — paper opens stay untouched forever in this destination |

Until flip criteria are met (and an explicit soft-active flag is on):

- Shadow = **log only**
- Toast + Telegram still owned by existing soft gate

Arms remain mcap first_seen + Enter at 80% only (#53). Soft-fail in soft-active still falls back to SPEC.

Suggested flags (implement PR; no secrets):

| Variable | Default | Meaning |
|---|---|---|
| `EARLY_ENTER_NOUL_SHADOW` | on | Write shadow rows + call Noul when scoped |
| `EARLY_ENTER_NOUL_SOFT_ACTIVE` | **off** | When on **and** ops confirms §7 bar, Noul may drive toast; kill switch forces off |
| `EARLY_ENTER_NOUL_NO` / `EARLY_ENTER_NOUL_YES` | `0.2` / `0.8` | Mid-band edges |

Exact spike thresholds for kill switches are ops-tunable fog (e.g. rolling API-miss rate or disagreement vs 24h baseline) — product lock is “spike → shadow-only,” not a specific formula in this SPEC.

---

## 8. Deploy prerequisite (ops #56)

TypeSafe / Jev VPS credentials (`TYPESAFE_API_KEY` or equivalent) and kill-switch env live in **ops**, not in this SPEC body. Missing / invalid creds → treat as `api_miss` (soft-fail → SPEC); do not block Early Enter emit; do not invent secrets in-repo.

---

## 9. Acceptance criteria

### Shadow path

- [ ] Shadow Noul runs only for Early Enter emit scoped to `mcap_enter_first_seen` / `mcap_enter_at_80` (and `_rh` on robinhood), when that strategy is active.
- [ ] Paper / sim-open / `EVAL_SHADOW` paths never call Noul and have no behavior diff from this SPEC.
- [ ] Soft-fail = API miss OR `0.2 < noul < 0.8` → follow `passesEarlyEnterMlSoftGate`; docs/code comments never say “low confidence” for Noul soft-fail.
- [ ] Null `cl_ml_score` → row with `spec_would_pass=false`, `noul_called=false`, `band=skipped_null`; **no** Noul HTTP call.
- [ ] Noul `state` includes only the locked fields; exclusions in §5.2 are absent.
- [ ] Rows land in **`early_enter_noul_shadow`**, not `strategy_ml_predictions`.
- [ ] Until soft-active flag + §7 bar: toast/Telegram identical to soft-gate-only behavior (Noul log-only).

### Compare + flip

- [ ] Admin/Algo Tester strip shows agreement rate + mid-band rate last 24h, split by `strategy_key`.
- [ ] Soft-active remains off by default; enabling requires N≥500, agreement≥85%, mid≤20%, and kill switches that revert to shadow-only on API/disagreement spike.
- [ ] Paper never gains a Noul gate in this destination.

### Non-goals honored

- [ ] No Choice / Score product behavior beyond the §13 one-liner.
- [ ] No Z / pWinner / mcap snapshot in Noul state.
- [ ] No change to paper size / SL / TP.

---

## 10. Test plan (implementation PR)

| Fixture | Expect |
|---|---|
| Stage-1 eligible, finite cl ≥ 0.55, active `mcap_enter_first_seen`, Noul returns 0.9 | Row `band=keep`, `noul_called=true`, toast still SPEC emit (shadow mode) |
| Same, Noul returns 0.1 | Row `band=suppress`; toast still SPEC emit (shadow) |
| Same, Noul returns 0.5 | Row `band=mid`, `decision_shadow=follow_spec`; toast follows SPEC |
| Noul throws / timeout / missing key | `band=api_miss`; toast follows SPEC; emit path does not throw |
| `cl_ml_score` null | `skipped_null`, no outbound Noul |
| Growth 50, only signals strategy active (no mcap arm) | No Noul, no shadow row |
| Soft-active off, Noul suppress band | Toast still emits if SPEC passes |
| Any paper / sim-track open path | Zero Noul calls |

---

## 11. Suggested code shape (implementation PR, not this one)

```ts
export type NoulShadowBand =
  | 'suppress'
  | 'mid'
  | 'keep'
  | 'skipped_null'
  | 'api_miss'

export const DEFAULT_NOUL_NO = 0.2
export const DEFAULT_NOUL_YES = 0.8

export function classifyNoulBand(
  noul: number | null,
  opts?: { no?: number; yes?: number; apiMiss?: boolean },
): NoulShadowBand {
  if (opts?.apiMiss) return 'api_miss'
  if (noul == null || !Number.isFinite(noul)) return 'api_miss'
  const no = opts?.no ?? DEFAULT_NOUL_NO
  const yes = opts?.yes ?? DEFAULT_NOUL_YES
  if (noul <= no) return 'suppress'
  if (noul >= yes) return 'keep'
  return 'mid'
}
```

Keep classification pure (no I/O). Call Noul only when `cl_ml_score` is finite and arm scope passes.

---

## 12. Open items (non-blocking)

1. Exact kill-switch spike math (rolling window / absolute rate) — ops fog; product lock is spike → shadow-only.
2. Whether soft-active may ever auto-enable when §7 is met, or always requires human flag flip — prefer **human flag** (`EARLY_ENTER_NOUL_SOFT_ACTIVE`).
3. Sol OHLC density unlock for a later **Score** ticket — research [#55](https://github.com/studentofcoding/reloadsol/issues/55); out of this SPEC body.
4. TypeSafe VPS env layout — task [#56](https://github.com/studentofcoding/reloadsol/issues/56).

---

## 13. Later maps (one-liner)

**Choice** (Raptor vs Jupiter when both return) and **Score** (batched OHLC ranking) are later Wayfinder maps — out of scope for this SPEC except this sentence. Soft-fail for those may use `confidence`; Early Enter **Noul** does not.

---

## 14. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-22 | Soft-fail mid-band | API miss or `NO < noul < YES`; NO=0.2 YES=0.8; never “low confidence”; → SPEC path |
| 2026-09-22 | Noul state | cl-* + flags + `spec_would_pass` + optional symbol; exclude Z/pWinner/mcap snapshot/paper/OHLC/gmgn |
| 2026-09-22 | Null cl score | Log suppress + skip Noul |
| 2026-09-22 | Log sink | `early_enter_noul_shadow`; Admin agreement + mid-band by `strategy_key` |
| 2026-09-22 | Arm scope | `mcap_enter_first_seen` / `mcap_enter_at_80` (+ `_rh`); never paper / other domains |
| 2026-09-22 | Flip bar | N≥500, agreement≥85%, mid≤20%, kill on spike; paper never |
| 2026-09-22 | Jev role | Judgment only; code owns opens/size |

---

## 15. Related docs

- Early Enter soft gate: [SPEC-early-enter-soft-gate-v1.md](./SPEC-early-enter-soft-gate-v1.md)
- Parent map: https://github.com/studentofcoding/reloadsol/issues/49
- Grills: [#50](https://github.com/studentofcoding/reloadsol/issues/50) · [#51](https://github.com/studentofcoding/reloadsol/issues/51) · [#52](https://github.com/studentofcoding/reloadsol/issues/52) · [#53](https://github.com/studentofcoding/reloadsol/issues/53) · [#54](https://github.com/studentofcoding/reloadsol/issues/54)
- Ops creds: [#56](https://github.com/studentofcoding/reloadsol/issues/56)
- Closed-loop / eval: [../04-machine-learning.md](../04-machine-learning.md), `ml/README.md`
- Strategy spine: [../03-strategies-and-automation.md](../03-strategies-and-automation.md)
