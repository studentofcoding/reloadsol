# SPEC: Bubblemaps + Jupiter organic rug filter (v1)

**Status:** to-spec handoff (Wayfinder grilling closed). Implement from this document; do not reopen grilling tickets unless a locked decision is contradicted by production data after ship.

**Repo surfaces:** reloadsol (`src/` strategies, BulkTokenBuyer, scout) feeding / mirroring buy_bulk. Solana primary.

**Provenance:** Wayfinder map *Bubblemaps + Jupiter organic rug filter for buy_bulk* (2026-09-16). Locked HITL answers are in §2. Map wins over any pre-lock summary (including a >60 Bubblemaps include that was **amended to >45**).

---

## Implementer checklist (build first)

Do this order. Do **not** start with ML, UI iframes, RH parity, or live execute.

1. **Normalize Bubblemaps to 0–100.** `score100 = round(api * 100)` when the API value is in `[0, 1]`. Never mix 0–1 and 0–100 in logs, flags, or UI copy.
2. **Discovery include:** drop candidates with Bubblemaps `score100 ≤ 45`. This is a hard discovery exclude under rug-recall, not a soft hint.
3. **Evaluate two AND legs** (concentration/cluster vs wash/organic-or-audit) with the vocabulary in §4–§5. One failing leg is **not** a hard rug veto.
4. **Pre-entry hard reject** only when **both** legs fail. Wire this after existing concentration-ban / GMGN security, before sim or live open.
5. **Discovery soft path:** if exactly one leg fails, keep the mint in the universe (unless the include score already dropped it) and **heavily downrank**.
6. **Use Jupiter raw `organicScore`** (0–100) for the wash/organic leg. Do not use `organicScoreLabel`, Axiom fee-invented `organicScore`, or Meteora `estimateOrganicScore`.
7. **Official Bubblemaps Data API only** for per-mint metrics (`X-ApiKey`). Do not scrape v2 UI. Do not treat `supply_stats.bundles` as launch-snipe bundle %.
8. **Flags off by default.** Paper/sim first (`RUG_FILTER=1`). Live requires `RUG_FILTER_LIVE=1` after an explicit ask. Climate Safe-gate and scout observe+paper stay unchanged.
9. **Log a structured verdict** on every evaluated mint (both legs, thresholds, action). This is the shadow dataset for later ML.
10. **ML features are follow-on.** Same signals into `entry-ml-scorer` as shadow features only; do not train a P(rug) model in v1.

No stub files are required by the map. This PR is documentation only.

---

## 1. Goal

Reject Solana discovery/entry candidates that are **rug-likely at the product destination of ~≥80% rug catch**, while still ranking real upside — by combining:

- **Bubblemaps** cluster / decentralization fields (concentration-quality), and
- **Jupiter organic membership** (wash / legitimacy), plus Jupiter **audit** as the alternate wash-leg fail,

with **existing** GMGN / Axiom / concentration-ban / ML risk.

Operationalization of “≥80% rug” for v1 is **not** a calibrated `P(rug)` model. It is the **AND conjunction** in §5, biased toward **rug recall** (higher false positives OK). Post-ship measurement of realized rug-catch is §11.

### 1.1 Non-goals

- Live execute, lifting climate Safe-gate, or lifting scout observe+paper-only.
- Building the Bubblemaps iframe / v2 map as a product surface.
- Replacing climate regime logic (`docs/CLIMATE_GATE.md`).
- Full Robinhood-chain Bubblemaps parity (use RH only when Bubblemaps/Jupiter already return that mint; do not invent RH-only fields).
- Scraping `v2.bubblemaps.io` or shipping the SPA `X-Validation` JWT.
- Equating API `supply_stats.bundles` with UI launch-snipe **bundle %** (that % is **not** in the Data API).
- Using Jupiter organic as a standalone rug detector.
- Replacing OHLC rug rules (`strategies/RUG_SIGNAL.md`, `ohlc-rug-rules.ts`) — those stay shadow unless a later spec says otherwise.
- Training / enforcing a new rug ML model in this v1 slice.

---

## 2. Locked decisions (do not reopen)

| Decision | Lock | Ticket |
|---|---|---|
| Hard reject shape | **AND**, not OR / weighted scorecard. Both legs must fail. Disagreement (e.g. high organic + bad concentration) is **not** a hard veto. | `grilling-eighty-percent-rug-rule` |
| Bias | **Prefer rug recall** over precision. Higher FP OK. No mint/class exceptions (no graduated-only carve-out, no mcap floor exception, no verified-tag bypass). | `grilling-keep-potential` |
| Pipeline | **Staged:** soft at discovery, hard AND at pre-entry, same signals into ML later (shadow → auto). Climate unchanged. | `grilling-pipeline-placement` |
| Score scale | Think and threshold in **0–100**. API `bubblemaps_score` is 0–1; convert with `round(api * 100)`. | `grilling-calibration-thresholds` |
| Include / concentration-quality | **Only include** Bubblemaps score **> 45**. Score **≤ 45** fails this leg **and is dropped at discovery**. Amended 2026-09-16 from an earlier >60 research suggestion. | `grilling-calibration-thresholds` |
| Jupiter organic | Prefer **raw `organicScore`** over `organicScoreLabel`. Organic is **wash/legitimacy**, not rug. Pair with audit. `toporganicscore` is a **potential ranker**, not a rug veto. | `research-jupiter-organic` |
| Bubblemaps API vs UI | Clusters + scores are API-native. Launch-snipe bundle % is **not** API. Do not scrape. | `research-bubblemaps-api` |
| Screener | Undocumented `POST /screener/tokens` exists (SPA JWT). ToS vs Pro key **still open** — default implementation is Pro Data API per mint, not the SPA screener. | `research-bubblemaps-screener` |

**Still recommended defaults (not re-confirmed by HITL; implementer may tune behind flags, not by changing AND shape):**

- Concentration also fails if `top_10_adjusted ≥ 0.20` (20%), **or** existing concentration-ban **> 50%**.
- Wash/organic fails if raw Jupiter `organicScore` is below the current non-graduated floor (**&lt; 70**), **or** `fresh_wallets ≥ 0.70` (70%).
- One failing AND leg → heavy discovery downrank (not hard reject), except score ≤ 45 which is already a discovery **exclude**.

---

## 3. Data sources

### 3.1 Bubblemaps official Data API (required for v1 per-mint)

- **Base:** `https://api.bubblemaps.io`
- **Auth:** header `X-ApiKey` from env `BUBBLEMAPS_API_KEY` (never commit the key). Portal: pro.bubblemaps.io.
- **Chain path:** `solana` (case-sensitive mint). `robinhood` exists in the chain enum; use only when the mint is already on that chain — no extra RH mapping layer.
- **Credits / limits (as of research 2026-09-16):** monthly credits by plan; overage HTTP 429; **10,000 calls/min/IP**. Metrics **25 credits**; map base **25**; holders base **1**.
- **Latency:** cache hit milliseconds; map outliers up to ~1 min; most ≤ ~15s. Prefer **metrics** over full map on the hot path.

| Call | Path | Use |
|---|---|---|
| Metrics (default) | `GET /v0/tokens/metrics/solana/{mint}` | `scores.bubblemaps_score`, `supply_stats.top_10_adjusted`, `supply_stats.fresh_wallets`, optional nakamoto / gini / HHI |
| Map (escalate) | `GET /v0/tokens/map/solana/{mint}?return_clusters=true&return_nodes=false&return_relationships=false` | `clusters[].share` when you need max cluster share |
| Holders (optional) | `GET /v0/tokens/holders/solana/{mint}` | Labels (`is_cex` / `is_dex`) to avoid FP from exchange custody — **not** a v1 hard veto |

**Do not use as launch-snipe bundle %:** `metrics.supply_stats.bundles` = top-10 **clusters** share excluding CEX/DEX (docs). Naming collision with UI “bundle”.

**Null `bubblemaps_score`:** treat as **unknown**. Under rug-recall, unknown **fails the discovery include** (same as ≤ 45). Unknown does **not** by itself complete the pre-entry AND if the wash/organic leg is healthy — log `concentration_unknown` and downrank. Out-of-range values (not in `[0, 1]`) are unknown; do **not** `×100` them into a fake pass.

### 3.2 Bubblemaps screener (optional discovery feed only)

`POST https://api.bubblemaps.io/screener/tokens` is the v2 `mode=new` / trending product API. It is **not** OpenAPI Data API v0. Auth is SPA `X-Validation` HS256 JWT (client-embedded secret) ± optional Firebase Bearer.

**v1 default: do not call it** until ToS / Pro-key question is closed. Bring your own mint list (trending, GMGN, Jupiter, scout) and enrich with §3.1.

If later approved, usable fields on each item (API 0–1; convert to 0–100):

- `metrics.scores.bubblemaps_score` / duplicate `bubblemaps_score`
- `metrics.supply_stats.top_10_adjusted`
- `metrics.supply_stats.fresh_wallets`
- `token_ref.chain` / `token_ref.address`, `market.*`, `launchpad`

Not on screener: launch-snipe bundle %, clusters/map, Jupiter organic. Page size ~50; `sort_by` ∈ {`new`,`trending`}; `time_range` ∈ {`5m`,`1h`,`6h`,`24h`,`7d`}; `chains` includes `solana` and `robinhood`. Launchpad id is `pumpfun` (not `pump.fun`).

### 3.3 Jupiter Tokens v2 (required for wash/organic + audit)

Existing client: `src/utils/jupiter-metadata.ts` → `https://lite-api.jup.ag/tokens/v2/search?query={mints}` (comma, up to 100). Keep that for per-mint.

| Field | Scale | Role in this filter |
|---|---|---|
| `organicScore` | 0–100 float | **Wash/organic leg.** Prefer raw. |
| `organicScoreLabel` | `high` \| `medium` \| `low` | Display only. **Never gate.** |
| `audit.isSus` | present **only when true** | Audit fail for wash/organic-or-audit leg. Absence ≠ safe. |
| `audit.mintAuthorityDisabled` / `audit.freezeAuthorityDisabled` | bool | Recommended **penalty / log**; not a locked v1 AND trigger. |
| `audit.topHoldersPercentage` | 0–100 | Parallel concentration (already used on Jupiter path). Does not replace Bubblemaps `top_10_adjusted`. |
| `audit.devBalancePercentage` | 0–100 | Log / ML later. |
| `bondingCurve` / `graduatedPool` | number / address | Existing Axiom split. **Keep Jupiter organic on graduated path** for this filter (today the Axiom success path drops it). |
| `stats{5m,1h,6h,24h}.buyOrganicVolume`, `numOrganicBuyers` | various | Optional wash intensifiers. Do **not** invent organic/total volume ratio as the primary gate (Jupiter advises against ratio-as-filter). |

**Potential ranker (discovery, not veto):**

```http
GET https://api.jup.ag/tokens/v2/toporganicscore/{5m|1h|6h|24h}?limit=50
```

Rank **descending** `organicScore` for potential. Short interval (`5m` / `1h`) for “now”. This feed is unused in buy_bulk today; adding it is optional v1 discovery membership, not required to ship the AND gate.

### 3.4 Existing reloadsol / buy_bulk signals (do not duplicate blindly)

| Signal | Path | Hard today? | Relation to this filter |
|---|---|---|---|
| Concentration-ban | `src/strategies/concentration-ban.ts` `CONCENTRATION_BAN_PCT = 50` | **Hard** (top10 / dev / bundlers **> 50%** → `markTokenRug`) | Recommended extra way to fail **concentration leg** |
| GMGN security | `gmgn-security-gate.ts` `maxTop10HolderRate: 0.2` | Hard when enabled | Stricter top10 on GMGN path; **keep**. This filter does not replace it |
| Jupiter organic in `assessTokenRisk` | `risk-assessment.ts` | Soft Discord/UI | Pre-grad: ≥85 LOW, ≥70 MED, else HIGH. **&lt;70 is the current non-graduated floor** for wash-leg fail |
| Strategy `organicScoreMin` | `canonical-params.ts`, `mcap-sim-track.ts` | Hard when set | Orthogonal strategy band; do not conflate |
| Axiom `organicScore` | `axiom.ts` `calculateFeeToMarketCapRatio` | Soft UI | **Fee heuristic — different name required in logs** (`axiom_fee_organic_score`) |
| DLMM `min_organic_score` | `dlmm/screener.ts` | Hard screen drop | **Meteora heuristic**, not Jupiter |
| Entry-ML / pattern | `entry-ml-scorer.ts`, `ml-entry-shadow.ts` | Shadow default | Consume new features later; do not enforce from this spec |
| OHLC rug | `ohlc-rug-rules.ts` | Shadow (`enforce: false`) | Out of scope |
| Climate | `climateGate.ts`, Header chip, scout | Gate default **off**; scout paper only when **Safe** | **Unchanged** |
| BulkTokenBuyer RiskAnalysis | UI | Soft — HIGH does **not** block buy | When `RUG_FILTER*` is on, the AND veto **does** block the open on enabled modes |

**Three “organic” meanings — never mix:**

1. `jupiter_organic_score` — this spec.
2. `axiom_fee_organic_score` — fees vs mcap; not Jupiter.
3. `meteora_organic_proxy` — DLMM holders/fee/TVL heuristic.

---

## 4. Gate vocabulary

Use these names in code, logs, and flags.

| Term | Meaning |
|---|---|
| `score100` | Bubblemaps decentralization score on **0–100**. Higher = more decentralized. |
| `top10_adj_pct` | `top_10_adjusted * 100` (clustered top entities, ignoring CEX/DEX). |
| `fresh_wallets_pct` | `fresh_wallets * 100` (holders &lt; 10 days). |
| **Leg A — concentration / cluster** | Structural supply concentration. Fail = “cluster/concentration looks rug-like.” |
| **Leg B — wash / organic (or audit)** | Activity legitimacy **or** Jupiter audit fail. Fail = “wash/bot or sus audit.” |
| **Hard reject** | Pre-entry veto: **Leg A fail AND Leg B fail**. Candidate must not open (sim or live according to flags). |
| **Discovery exclude** | Drop from the ranked feed. Locked for `score100 ≤ 45` (and unknown score). |
| **Heavy downrank** | Stay in universe but rank below every dual-pass candidate. Used when exactly one AND leg fails. |
| **Disagreement** | One leg fail, one pass. **Not** a hard reject. |

### 4.1 Conversion

```
function toScore100(raw: number | null): number | 'unknown' {
  if (raw == null || !Number.isFinite(raw)) return 'unknown'
  if (raw >= 0 && raw <= 1) return Math.round(raw * 100)
  return 'unknown'  // do not treat 2.48 as 248
}
```

Screener samples have occasionally returned values **> 1** (e.g. `2.48`). Those are unknown, not a pass.

---

## 5. Decision rule

### 5.1 Leg A — concentration / cluster **fails** if any:

| Condition | Status | Notes |
|---|---|---|
| `score100` unknown **or** `score100 ≤ 45` | **Locked** | Also **discovery exclude** |
| `top_10_adjusted ≥ 0.20` | Recommended default | 20% clustered top-10 |
| Existing concentration-ban trips (top10 / dev / bundlers **> 50%**) | Recommended default | Reuse `evaluateConcentrationBan` |

Optional (log / ML, not v1 AND unless a flag turns them on): max `clusters[].share`, low `nakamoto_coefficient`, high gini / HHI.

### 5.2 Leg B — wash / organic (or audit) **fails** if any:

| Condition | Status | Notes |
|---|---|---|
| Jupiter raw `organicScore < 70` | Recommended default | Current non-graduated HIGH floor in `risk-assessment.ts`. Missing organic → treat as fail **only** when `RUG_FILTER_FAIL_CLOSED=1`; else log `organic_unknown` and do **not** complete Leg B (AND cannot fire on a missing wash signal unless fail-closed). |
| `fresh_wallets ≥ 0.70` | Recommended default | 70% fresh wallets |
| `audit.isSus === true` | Recommended default | The “or audit” half of the locked sentence. Absence of the key is not a fail |

Do **not** fail Leg B on `organicScoreLabel === 'low'` alone.

### 5.3 Combine

```
include = (score100 !== 'unknown' && score100 > 45)

legA = !include || top10_adj >= 20 || concentrationBan
legB = (organicScore < 70) || (fresh_wallets >= 0.70) || (audit.isSus === true)

discovery:
  if !include → EXCLUDE
  else if legA && legB → EXCLUDE (both already fail; no point ranking a hard-reject)
  else if legA || legB → KEEP + HEAVY_DOWNRANK
  else → KEEP (normal rank; Jupiter toporganicscore / strategy rankers apply)

pre_entry:
  if legA && legB → HARD_REJECT
  else → PASS this filter (other gates still apply)
```

**Truth table**

| Leg A | Leg B | Discovery | Pre-entry |
|---|---|---|---|
| pass | pass | keep, normal rank | pass |
| fail (`score100 ≤ 45` / unknown) | * | **exclude** | would be A-fail; hard reject only if B also fails (usually never reached) |
| fail (top10 / conc-ban only) | pass | keep, **heavy downrank** | pass (disagreement) |
| pass | fail | keep, **heavy downrank** | pass (disagreement) |
| fail | fail | exclude | **HARD REJECT** |

Heavy-downrank implementation default (not HITL-locked): sort key `rug_filter_rank = base_rank * 0.1` (or send to a “suspect” bucket below all dual-pass rows). Do not silently drop.

---

## 6. Pipeline placement

Climate Safe / Not safe (Header display vs scout paper-only) is **out of this filter**. Do not call `applyClimateToNewRisk` from this work. Do not enable `CLIMATE_GATE_LIVE`.

```
mint appears
  → [Discovery, soft] Bubblemaps include >45; AND-leg features for rank/penalty
  → existing strategy / GMGN / mcap / scout filters (unchanged)
  → [Pre-entry, hard] AND veto on every candidate that would open
  → existing concentration-ban + GMGN security + strategy organic/holders
  → climate (unchanged) / kill switch / capital caps always win
  → open (sim / paper / live per existing execution_mode)
  → [ML follow-on] attach the same features + binary AND label in shadow
```

### 6.1 Where to wire (reloadsol)

| Stage | Suggested hook | Behavior when flags on |
|---|---|---|
| Discovery — trending | `src/strategies/trending-track/cycle.ts` / `filtering.ts` after union pre-filter | Exclude `score100 ≤ 45`; downrank one-leg fails |
| Discovery — GMGN | `src/strategies/gmgn-pipeline.ts` `gateGmgnCandidates` **before or with** concentration-ban | Same; do not replace conc-ban |
| Discovery — mcap snapshots | `src/utils/mcap-tracker.ts` ingest / `mcap-sim-track.ts` skip reasons | Persist Bubblemaps + Jupiter fields on the snapshot when cheap |
| Discovery — scout | `buybulk-datapublic-scout` / `docs/DATA_PUBLIC_SCOUT.md` | Observe-list rank/exclude only. **No live exec.** Paper notes still require climate **Safe** |
| Discovery — optional Jupiter membership | poll `toporganicscore/5m` or `1h` | Potential ranker, then run this filter |
| Pre-entry — mcap / signals / GMGN open | `getMcapSimOpenSkipReason`, signals pipeline, `gmgn-pipeline` before open | `HARD_REJECT` skips the open and logs reason |
| Pre-entry — BulkTokenBuyer | buy click / `executeBulkBuy` path | Block when `RUG_FILTER` (paper) or `RUG_FILTER_LIVE` (live) says so. Today HIGH risk does **not** block — this spec changes that **only** under these flags |
| ML | `canonical-features.ts` `domain_features`, `ml-entry-shadow.ts` | Shadow log; see §7 |

### 6.2 Order vs existing hard gates

Keep current GMGN order: OHLC shadow → concentration-ban → security gate. Insert this filter’s **hard AND** next to concentration-ban (same tick, shared snapshot cache). A concentration-ban trip already fails Leg A; still evaluate Leg B so the AND (and the ML label) is complete.

---

## 7. ML follow-on (not v1 enforce)

Feed the **same** signals into `entry-ml-scorer` / Pattern ML as features. Start **shadow** (log model score vs hard AND). Graduate to automatic only when agreement is good enough **and** existing `ML_GATE_MODE` / `ML_PATTERN_MODE` promotion rules are met (`gate_ready` / `pattern_ready`). This spec does **not** flip those modes.

Suggested `domain_features` keys (do not overwrite Jupiter `organic_score`):

| Key | Type |
|---|---|
| `bubblemaps_score_100` | number \| null |
| `top10_adjusted_pct` | number \| null |
| `fresh_wallets_pct` | number \| null |
| `cluster_max_share_pct` | number \| null (map escalate) |
| `rug_filter_leg_a` | 0 \| 1 |
| `rug_filter_leg_b` | 0 \| 1 |
| `rug_filter_and_reject` | 0 \| 1 |
| `rug_filter_discovery_action` | `exclude` \| `downrank` \| `keep` |

Retrain is a later stage. v1 success is labeled logs, not a new ONNX head.

---

## 8. Failure modes

| Failure | What to do (v1) |
|---|---|
| Bubblemaps 429 / credit exhaust | Back off. Cache last-good metrics (short TTL, see flags). Missing score = unknown include-fail at discovery; pre-entry AND as §5.2 fail-closed flag |
| Bubblemaps 404 (no holders) | Unknown score → discovery exclude. Do not treat as “decentralized” |
| Bubblemaps timeout / map ≥15s | Skip map escalate; metrics-only. If metrics also missing, unknown |
| Score out of `[0, 1]` | Unknown (screener dirty values). Log raw |
| Jupiter 429 / timeout | Existing `jupiter-metadata.ts` retry. Organic missing: Leg B incomplete unless `RUG_FILTER_FAIL_CLOSED` |
| Graduated path drops Jupiter organic | **Bug relative to this spec.** Always attach Jupiter `organicScore` even when `bondingCurve === 100` / Axiom runs |
| Dual organicScore in UI | Rename Axiom fee score in any new copy; show Jupiter raw for this filter |
| `supply_stats.bundles` used as launch bundle | **Forbidden.** Would mis-fire rugs |
| SPA screener JWT in backend | **Forbidden** until ToS lock. Prefer Pro key |
| Climate / scout paper bypass | **Forbidden.** Safe-gate and observe+paper unchanged |
| RH invented fields | **Forbidden.** If Bubblemaps/Jupiter lack the mint, skip this filter (log `coverage_missing`) rather than synthesizing |
| Hard OR / single-leg veto | **Forbidden.** Disagreement is downrank, not reject |
| Using `organicScoreLabel` | **Forbidden** for gates |
| Live on by default | **Forbidden.** Match climate: paper first |

**Latency budget (not HITL-locked; implementer default):**

- Trending / GMGN / mcap ticks: **metrics only**, TTL cache **≥ 60s** per mint (Bubblemaps maps are slow to change vs 15s mcap ticks).
- Do not call map+holders on every scout poll.
- Hard budget: if metrics not in cache and fetch would exceed **800ms** remaining in the worker, skip and treat as unknown rather than blocking the whole tick.
- Credits: metrics-first; map only on pre-entry candidates that already passed include and need cluster share (optional flag `RUG_FILTER_MAP_ESCALATE=1`, default off).

---

## 9. Rollout flags

Default **all off** (filter not applied). Comment-only in env docs; **no secrets in git**.

| Variable | Default | Meaning |
|---|---|---|
| `RUG_FILTER` | unset/off | `1` / `true` enables discovery include/downrank **and** pre-entry AND on **paper / sim / dry_run** paths |
| `RUG_FILTER_LIVE` | unset/off | `1` / `true` also applies hard AND when `execution_mode` is live / `dry_run=false`. **Ask before setting.** Does not imply climate live |
| `RUG_FILTER_DISCOVERY` | follows `RUG_FILTER` | Set `0` to run pre-entry AND only (no discovery exclude/downrank). Useful for shadowing discovery |
| `RUG_FILTER_FAIL_CLOSED` | unset/off | `1` treats missing Jupiter organic **or** missing Bubblemaps after retries as the corresponding leg **fail**. Default **fail-open on missing wash**, **fail-exclude on missing Bubblemaps include** (rug-recall on concentration quality) |
| `RUG_FILTER_ML_SHADOW` | on when `RUG_FILTER=1` | Attach §7 features / log agreement. Never enforces ML |
| `RUG_FILTER_SCORE_MIN` | `45` | Include threshold on `score100`. Locked product default 45; flag exists so calibration can move without a code edit |
| `RUG_FILTER_TOP10_ADJ_PCT` | `20` | Recommended Leg A extra |
| `RUG_FILTER_ORGANIC_MIN` | `70` | Recommended Leg B Jupiter floor (fail if **below**) |
| `RUG_FILTER_FRESH_WALLETS_PCT` | `70` | Recommended Leg B fresh-wallet fail |
| `RUG_FILTER_MAP_ESCALATE` | unset/off | Fetch map clusters at pre-entry |
| `BUBBLEMAPS_API_KEY` | unset | Pro Data API key. Server-only. Never `NEXT_PUBLIC_*` |
| `BUBBLEMAPS_API_BASE` | `https://api.bubblemaps.io` | Override for tests |

**Ask-before-live:** `RUG_FILTER=1` must **not** change live size or live opens. Same pattern as `CLIMATE_GATE` vs `CLIMATE_GATE_LIVE`.

Kill switch, daily-loss, capital caps, strategy `is_active`, and climate (when enabled) **always win**. This filter never increases size and never unpauses an agent.

---

## 10. Test plan

No product implementation in this handoff. Implementer ships tests with the code PR.

### 10.1 Unit (pure verdict)

Table-driven tests for `toScore100` and the truth table in §5.3:

| Fixture | Expect |
|---|---|
| API `0.23` → `score100=23` | discovery exclude (≤45) |
| API `0.45` → `45` | exclude (`>` 45 is include; **not** `≥`) |
| API `0.46` → `46` | include on score; then evaluate other A/B conditions |
| API `0.80`, top10_adj `0.10`, organic `90`, fresh `0.20`, not sus | keep, pass |
| API `0.80`, top10_adj `0.25`, organic `90` | A fail, B pass → downrank, no hard reject |
| API `0.80`, top10_adj `0.10`, organic `40` | A pass, B fail → downrank, no hard reject |
| API `0.30`, organic `40` | exclude + (if evaluated) hard reject |
| `bubblemaps_score: 2.48` | unknown → discovery exclude |
| `null` score | unknown → discovery exclude |
| `organicScoreLabel: 'low'` but raw `80` | must **not** fail Leg B on label |
| `supply_stats.bundles: 0.9` with healthy score/top10/organic | must **not** fail on bundles alone |
| concentration-ban top10 `51%`, organic `90` | A fail, B pass → no hard reject |
| `audit.isSus === true` + `score100=20` | both fail → hard reject |
| `audit.isSus` absent | not a Leg B fail |

### 10.2 Conversion / naming

- Logs and UI copy never print a 0–1 Bubblemaps threshold.
- Axiom fee organic and Meteora organic are not read by the verdict function.

### 10.3 Integration (mocked HTTP)

- Metrics 429 → cache / unknown path; worker tick still completes.
- Jupiter timeout → Leg B incomplete unless fail-closed.
- Graduated (`bondingCurve=100`) response still includes Jupiter `organicScore` on the verdict object.
- GMGN `gateGmgnCandidates` still runs concentration-ban when this filter is off.
- Scout paper POST still 403 when climate is not Safe, with filter on or off.
- BulkTokenBuyer does not call live swap from scout.

### 10.4 Flag matrix

| Flags | Sim open AND-fail | Live open AND-fail | Discovery exclude |
|---|---|---|---|
| all unset | allowed (today) | allowed (today) | no |
| `RUG_FILTER=1` | blocked | allowed | yes |
| `RUG_FILTER=1` + `RUG_FILTER_LIVE=1` | blocked | blocked | yes |
| `RUG_FILTER=1` + `RUG_FILTER_DISCOVERY=0` | blocked | per live flag | no |

### 10.5 Calibration after ship (measures the ≥80% destination)

Not a v1 launch blocker; do not invent labels in this docs PR.

1. Join verdict logs to `strategy_outcomes` + `markTokenRug` / rugged board labels.
2. Define rug-positive: token marked rug **or** training class 0 with dump/concentration close **or** operator rugged tag — document the exact join in the code PR.
3. Report **rug recall** = `AND-reject ∩ rugs / rugs` on a held-out week. Destination: **≥ ~80%**.
4. Report **winner kill rate** = `AND-reject ∩ winners / winners`. No numeric cap locked; recall wins ties.
5. If recall &lt; 80% after two weeks of `RUG_FILTER=1` paper, tune **recommended** thresholds (`TOP10`, `ORGANIC_MIN`, `FRESH`) **behind flags**. Do **not** switch AND → OR without a new grilling ticket.

---

## 11. Open items (non-blocking)

These were explicitly **not** locked. v1 proceeds with the defaults above.

1. **Auth/cost:** Pro Data API key vs SPA screener JWT ToS/abuse; Jupiter Tokens quotas under our poll rates. Default: Pro key + existing Jupiter search; cache to stay inside credits.
2. **How we measure ≥80% rugs** against labeled outcomes / paper notes — §10.5 is the proposed loop, not a HITL lock.
3. **Latency budget** for map+holders / screener poll inside trending/scout cycles — §8 defaults.
4. **Exact heavy-downrank math** when only one AND leg fails — §5.3 default `× 0.1`.
5. **Mint/freeze authority** as Leg B — recommended penalty/log only until a later ticket.
6. **`toporganicscore` scout** as a first-class discovery source — optional.
7. **Bubblemaps coverage on RH** — opportunistic; no parity project.

---

## 12. Decision log (grilling closed)

| Date | Item | Outcome |
|---|---|---|
| 2026-09-16 | Data API vs UI bundle | Clusters + scores API; launch bundle % not API; do not scrape |
| 2026-09-16 | Screener `mode=new` | `POST /screener/tokens` exists; SPA JWT; ToS open |
| 2026-09-16 | Jupiter organic | Raw score = Spot Organic; wash not rug; toporganicscore = potential |
| 2026-09-16 | buy_bulk inventory | Hard conc-ban / security; Jupiter organic soft on Discord; three organics; no Bubblemaps yet |
| 2026-09-16 | ≥80% rule | **AND** conjunction |
| 2026-09-16 | Pipeline | Staged + ML enrichment; climate unchanged |
| 2026-09-16 | Keep potential | Prefer **rug recall**; no exceptions |
| 2026-09-16 | Thresholds | Scale 0–100; include **> 45** (amended from >60); other numbers = recommended defaults |

---

## 13. Suggested code shape (for the implementation PR, not this one)

Pure function, no I/O:

```ts
export type RugFilterVerdict = {
  score100: number | null
  include: boolean
  legA: boolean
  legB: boolean
  discovery: 'exclude' | 'downrank' | 'keep'
  preEntry: 'hard_reject' | 'pass'
  reasons: string[]
}

export function evaluateRugFilter(input: {
  bubblemapsScoreRaw: number | null
  top10Adjusted: number | null      // 0–1
  freshWallets: number | null       // 0–1
  jupiterOrganicScore: number | null // 0–100
  auditIsSus: boolean
  concentrationBan: boolean
  thresholds: { scoreMin: number; top10AdjPct: number; organicMin: number; freshWalletsPct: number }
}): RugFilterVerdict
```

Fetcher + cache live in a small `src/utils/bubblemaps-metrics.ts` (implementation PR). Verdict must stay unit-testable without network.

---

## 14. Related docs

- Climate (unchanged): [CLIMATE_GATE.md](../CLIMATE_GATE.md)
- Scout observe+paper: [DATA_PUBLIC_SCOUT.md](../DATA_PUBLIC_SCOUT.md), [STRATEGY_SCOUT.md](../STRATEGY_SCOUT.md)
- ML shadow/enforce: [ML_GATE_PLAN.md](../ML_GATE_PLAN.md)
- Strategy spine: [03-strategies-and-automation.md](../03-strategies-and-automation.md)
- OHLC rug (different system, shadow): [../strategies/RUG_SIGNAL.md](../../strategies/RUG_SIGNAL.md)
- Existing Jupiter organic bands: `src/utils/risk-assessment.ts`
- Existing concentration hard ban: `src/strategies/concentration-ban.ts`
