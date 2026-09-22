# SPEC — Potential / rug tracker labels, OHLC corpus, Tracker filters, join honesty v1

**Status:** to-spec (docs only)
**Date:** 2026-09-22
**Surface:** `reloadsol` MCap tracker (`token_mcap_tracking`, `/dev/signals?tab=tracker`); OHLC corpus (`signal_ohlc_labels`, `/dev/ohlc-labels`); token-map lane (`TokenMapLane`); Algo Tester open (`/dev/algo-tester?tab=open`)
**Lane:** autotrade & algo
**Depends on:** live `applyAutoLabelsFromMilestones`; `captureSignalOhlcLabel` / `resolveSignalOhlcWindow`; Algo Tester unify (Open / Closed tabs)

**Provenance:** Wayfinder map *potential-rug-labels-tracker-join* (locked 2026-09-22). Implement from this document; do not reopen grilling unless a lock is contradicted by production data after ship.

This PR is documentation only. One implementation PR follows this SPEC (§4).

---

## Implementer checklist (build first)

Do this order. Do **not** start with sim-open changes, list-sync, a new OHLC pipeline, pattern training, or `EVAL_SHADOW`.

1. **Assignment stays the live auto-rule.** `token_mcap_tracking.label` via `applyAutoLabelsFromMilestones` only. Peak growth → `potential`. Drop −40/−80 → `rugged`. Same overwrite protections. Store `potential` / `rugged` (UI may say Rug).
2. **OHLC is an additional label**, not a gate. When that column becomes (or already is) `potential` / `rugged`, capture with the existing 10m window helper. Do not demote or qualify the tracker label from candles.
3. **One-shot backfill** of every `token_mcap_tracking` row (soft overwrite + OHLC capture) plus the **live** capture hook on later transitions.
4. **Reorganize on Tracker.** Label tabs/filters on `/dev/signals?tab=tracker`. `/dev/ohlc-labels` stays the corpus gallery. Do not make `dlmm_potential_list` / `token_rug_list` the v1 surface.
5. **UI honesty** for tracked-without-strategy (seed mint below). Tracked ≠ strategy when `strategyId` is null and source is `token_mcap_tracking`. Deep-link Open positions with mint + domain. “No recent activity” stays on the activity list only. No write-path force-open. No invented outcomes.

---

## 1. Goal

One slice that:

1. Makes **system potential / system rug** mean the existing mcap auto-rules on `token_mcap_tracking.label`.
2. Builds an OHLC **corpus** (target ~300+ cards, later pattern use) whenever those labels are set or backfilled.
3. Lets the operator **filter the Tracker** into Potential, Rug, and the other stored labels.
4. Stops the token map from presenting a tracking row as a strategy open.

Seed mint for the honesty bug: `AVXPQqxd32ABAP5F7shHKNeWBpos9miktdH3uKqgXYJZ` (symbol `suit` on the VPS confirm). Tracked `potential`, **zero** `strategy_outcomes`, token-map link text **Open** to bare `/dev/algo-tester`, activity list **No recent activity**.

### 1.1 Non-goals (out of scope)

- Write-path “tracked ⇒ always open” or “tracked ⇒ sooner open”. Do not relax `getMcapSimOpenSkipReason`, enqueue a sim on insert, or change who gets paper.
- Live (real) trading from potential labels.
- Reworking the OHLC candle pipeline (fetch, interval set, cache, Freeview exclusive upsert).
- OHLC pattern training or matching. Fog until the corpus is ≥ ~300. Not a v1 gate.
- Flipping `EVAL_SHADOW` / eval paper opens, or feeding these labels into closed-loop / pattern training corpora.
- Flowey / non-reloadsol surfaces.
- A new `system` value on `token_mcap_tracking.label`, or copying `token_detect_snapshots.rug_label`.
- Requiring `dlmm_potential_list` or `token_rug_list` membership for the Tracker reorganize.
- Writing `strategy_episodes.rug_label` (schema only today; finalize never writes it).
- Inventing `strategy_outcomes` or sim rows so the seed mint looks open.
- A new human-lock column. Existing overwrite protections are the lock (§5.2).

---

## 2. Locked decisions (do not reopen)

| Decision | Lock | Ticket |
|---|---|---|
| System assignment | **Existing mcap auto-rules only.** Peak growth → `token_mcap_tracking.label = potential`. Drop 40/80 → `rugged`. Same overwrite protections as live `applyAutoLabelsFromMilestones`. | `what-is-system-potential-vs-rug` |
| Vocabulary | Store **`potential` / `rugged`**. UI may say **Rug**. OHLC store stays **`potential` / `rug`** via `toSignalOhlcStoreLabel`. No tracker value `system` or `rug`. | same |
| OHLC role | **Additional labels** when the system sets or backfills potential/rugged. Corpus toward ~300+ for **later** pattern use. **Not** a demote/qualify gate on the tracker label. | `ohlc-verify-recheck-for-system-labels` |
| OHLC window | Exact candle window was left to this SPEC. **Default: reuse the live 10m helper** (§6). Do not invent a second window. | map fog |
| Backfill | **All** `token_mcap_tracking` rows. Soft overwrite (live protections). OHLC capture for resulting **and** existing potential/rugged. **One-shot** job **and** live continuous path. | `backfill-policy-for-system-labels` |
| Reorganize | **MCap Tracker filters/tabs** for potential vs rugged (and the other stored labels). `/dev/ohlc-labels` stays the corpus view. List-sync is **not** the v1 surface. | `reorganize-surface-for-potential-rug` |
| Join bug | **UI honesty only.** Tracked ≠ strategy when `strategyId` is null / source is `token_mcap_tracking`. Open deep-links with mint (+ domain) into Algo Tester. “No recent activity” only for the activity list. No write-path. No invented outcomes. | `tracker-strategies-join-fix-shape` |
| Ship shape | **One SPEC, one implement PR** (§4). | map fog |

Standing (map, not a new ticket): `EVAL_SHADOW` stays shadow. Risk remains a danger heuristic. Early Enter soft gate and Algo Tester unify already shipped; do not reopen them.

---

## 3. As-built (verified in repo before writing this section)

### 3.1 No single `system` label

`TokenLabel` in `src/utils/mcap-tracker.ts`:

`valid` | `traded_live` | `potential` | `rugged` | `watching`

CHECK on `token_mcap_tracking.label` matches that set. There is no `rug` and no `system` on the tracker row.

| Store | Labels | Relation to this SPEC |
|---|---|---|
| `token_mcap_tracking.label` | `valid` · `traded_live` · `potential` · `rugged` · `watching` | **Assignment store** |
| `trading_signals.label` | `watching` · `potential` · `rugged` | Manual/list sync. Not the system assignment |
| `dlmm_potential_list` | membership | Curated list. `markTokenPotential` does **not** set the tracker label |
| `token_rug_list` | membership | `markTokenRug` syncs list + signals + tracker + OHLC `rug` |
| `signal_ohlc_labels.label` | `potential` · `rug` | Corpus. Unique `(token_address, label)` |
| `token_detect_snapshots.rug_label` | `system` (default) · `rug` · `potential` | **Only** place the word `system` exists. Not tracker assignment |
| `strategy_episodes.rug_label` | NULL · `rug` · `potential` | Schema only; finalize never writes it |
| `strategy_outcomes` | no potential/rug column | ML `features` JSON is a different vocabulary |

### 3.2 Auto-rule (the assignment)

`applyAutoLabelsFromMilestones` (`src/utils/mcap-tracker.ts`):

```
if when_drop_40pct OR when_drop_80pct:
  if label is traded_live OR rugged → no change
  else label = rugged
else if peak_growth_percent > 0 AND label is null | valid | watching:
  label = potential
else no change
```

Called from `applyMcapSessionUpdates` after peak + threshold stamps. Drop thresholds are growth ≤ **−40** and ≤ **−80** (`DROP_THRESHOLDS`). Growth milestones are 80 / 120 / 200 and are **not** the potential predicate. Potential is **any positive peak growth**, not “crossed 80%”.

`updateMcapInDatabase` persists `label` when it is non-null and thresholds are included. Auto-label does **not** call `captureSignalOhlcLabel`, `markTokenRug`, or `markTokenPotential`.

Manual `PUT /api/mcap-tracking/label` (and `setMcapTokenLabel`) writes the column directly. `rugged` then calls `markTokenRug` (list + OHLC). `potential` does **not** touch `dlmm_potential_list` and does **not** capture OHLC.

### 3.3 OHLC capture today

`captureSignalOhlcLabel` inserts once per `(token_address, store label)`. `toSignalOhlcStoreLabel`: `potential` → `potential`; `rugged` | `rug` → `rug`.

Window (`src/strategies/signal-ohlc-window.ts`):

| Label | Window |
|---|---|
| `potential` | Track start → earliest of peak price, milestone 200 / 120 / 80, or **`POTENTIAL_MAX_MS` = 10 minutes** (`cap_10m`). No track anchor → last 10m ending now. |
| `rug` | Track start → `status_changed_at`, else now. |

Interval stored as `1m`. Callers today: `markTokenRug`, `markTokenPotential`, and the Freeview upsert fallback. **Not** the mcap auto-label path.

Gallery: `/dev/ohlc-labels` (`OhlcLabelsGallery`) lists `potential` and `rug` cards. It is not the Tracker.

### 3.4 Tracker list has no label filter

`GET /api/mcap-tracking?action=list` (`buildMcapListWhere`) filters chain, search, time, performance, growth, first-mcap. It does **not** filter `label`. `FilterOptions` / `TrackerTab` Filters & Search have no Potential/Rug control. The card does not show `token.label` (CSV export does).

`GET /api/mcap-tracking/label?label=` can list one label. That route is not the Tracker page.

### 3.5 Tracked row rendered as a strategy

`buildStrategyPresence` (`src/strategies/token-locate.ts`), when a `token_mcap_tracking` row exists:

```
domain: mcap_tracker
strategyId: null
strategyName: null
source: token_mcap_tracking
label: <tracker label>
deepLink: links.algoTester   // bare '/dev/algo-tester'
```

`TokenMapLane` prints `strategyName ?? strategyId ?? source` (so the visible name is the table `token_mcap_tracking`) and link text **Open**. Header chip uses `label` when set (so `potential` can show) else `present`.

Activity (`fetchTokenMapActivity`) is last-24h social events, `strategy_outcomes`, and sim-wallet buys/sells. Empty list copy is **No recent activity**. That copy is the activity `<ul>`, not a presence verdict. A tracking row has no activity items of its own.

Algo Tester Open (`AlgoOpenPositionsTab`) filters domain / strategy / sim via `filterAlgoPositions`. It does **not** read `tokenAddress`. The token box is Closed-only (`showToken={query.tab === "closed"}`). A deep link with `tokenAddress` on Open does not filter the grid today.

Sim open is a different gate. `getMcapSimOpenSkipReason` skips `label === 'rugged'` and otherwise requires recency (registry default **240** minutes), mcap band, milestones, max opens. Tracking can last `MAX_TRACKING_AGE_MS` (default **4 days**). A row can be tracked long after it is ineligible to open. This SPEC does not change that.

### 3.6 Seed mint (VPS confirm 2026-09-22, code-consistent)

`AVXPQqxd32ABAP5F7shHKNeWBpos9miktdH3uKqgXYJZ`:

- `token_mcap_tracking`: symbol `suit`, label `potential`, peak growth ~4481%, `when_reach_80pct` set, no drop_40.
- `strategy_outcomes`: **0** rows.
- `trading_records`: one buy on a live-style wallet, not `mcap-tracker-sim` / `mcap-tracker-sim-rh`.

Confirms never mcap-sim-opened. The lane **Open** / empty activity is a read-path honesty bug.

### 3.7 Hypothesis — confirmed

> System potential/rug is the tracker auto-label. OHLC cards and list membership are parallel stores. A tracking row is not a strategy.

---

## 4. Ship shape — one implement PR

**One implementation PR** for labels + backfill + Tracker filters + UI honesty.

No hard split. The four pieces share the tracker label column and do not need a schema migration or an engine change. Honesty does not depend on backfill; filters are useful on whatever labels already exist and become the reorganize surface once backfill has run. Landing them apart would leave the operator with either unlabeled tabs or a still-misleading Open link.

If review size forces a split after the PR is open, the only safe cut is:

1. Honesty (read path only), then
2. Assignment + OHLC hook + one-shot + Tracker tabs.

Do not split OHLC capture off the label writer. Do not split Tracker tabs onto the list tables.

This docs PR ships the SPEC and the index links only.

---

## 5. Assignment rules

### 5.1 Predicate

Reuse `applyAutoLabelsFromMilestones`. Do not copy the `if` into a second helper.

| Condition | Write |
|---|---|
| `when_drop_40pct` or `when_drop_80pct` set, label not `traded_live` or `rugged` | `rugged` |
| else `peak_growth_percent > 0` and label is null, `valid`, or `watching` | `potential` |
| else | no change |

`traded_live` is never overwritten. `rugged` is never downgraded to `potential`. An existing `potential` is left alone by the potential branch (the predicate does not match).

### 5.2 What “soft overwrite” means

Backfill and live use **this function**, not a looser SQL update.

| Current label | Drop stamp | Peak &gt; 0, no drop | Result |
|---|---|---|---|
| null / `valid` / `watching` | yes | — | `rugged` |
| null / `valid` / `watching` | no | yes | `potential` |
| `potential` | yes | — | `rugged` |
| `potential` | no | yes | stay `potential` |
| `rugged` | either | either | stay `rugged` |
| `traded_live` | either | either | stay `traded_live` |

No new lock column. A manual `watching` or `valid` still flips on the next live tick under the same rules (that is current behavior). A manual `traded_live` or `rugged` sticks.

### 5.3 What assignment does not write

Auto-label and the one-shot job must **not** call `markTokenPotential` or `markTokenRug`.

Those functions sync `dlmm_potential_list` / `token_rug_list` and `trading_signals`. List membership stays a manual/registry path. Tracker tabs read `token_mcap_tracking.label` only.

Do not add `system` to the CHECK. Do not backfill from `token_detect_snapshots`.

Manual `PUT` of `rugged` may keep calling `markTokenRug` (already shipped). That is not the system assignment path.

---

## 6. OHLC additional labels

### 6.1 When to capture

Capture with existing `captureSignalOhlcLabel` (idempotent; `ON CONFLICT DO NOTHING`):

| Path | When | `source` string |
|---|---|---|
| Live auto | `applyAutoLabelsFromMilestones` returned true **and** the new label is `potential` or `rugged`, after the tracker row persisted | `mcap_auto_label` |
| One-shot | After the soft apply, every row whose label **is** `potential` or `rugged` (changed or already) | `mcap_label_backfill` |
| Manual PUT | New label is `potential`. (`rugged` already captures inside `markTokenRug`; do not add a second fetch on that path.) | `mcap_label_manual` |

Fail-soft. A capture error must not fail the mcap price update or the manual label response. Do not call capture on ticks where the label did not change (the one-shot covers rows already labeled).

Map tracker `rugged` → store `rug`. Map `potential` → `potential`. A token that was potential and later rugged keeps **both** gallery rows (normal capture does not delete the other label). Do not use `upsertSignalOhlcLabelFromBars` for this slice (that path deletes the other label).

Do not synthesize a `potential` card for a row whose current label is `rugged` just because peak growth was positive. Capture the **current** tracker label only. The later transition captures `rug` when it happens.

### 6.2 Window default (to-spec; do not re-grill)

**Reuse `resolveCaptureWindowMs` / `resolveSignalOhlcWindow`.** No new constant.

- Potential cap: **10 minutes** (`POTENTIAL_MAX_MS`). End reason stays `peak` | `milestone_200` | `milestone_120` | `milestone_80` | `cap_10m` | `label_now`.
- Rug: track start → status change or now.
- Bars: existing `1m` path inside `captureSignalOhlcLabel` (cache, then narrow fetch, then last-10 fallback). Do not change that pipeline.

Candles do **not** change `token_mcap_tracking.label`. A bad or empty bar set still leaves the tracker label. Empty bars are allowed (the helper already stores `ohlc_source = 'none'`).

### 6.3 Corpus target

`signal_ohlc_labels` rows with `label IN ('potential','rug')` are the corpus. Aim **~300+** combined so a **later** spec can train or match patterns.

v1 does not block on that count, does not train, and does not read the bars back into the tracker. The one-shot logs the two counts at the end (§7.3). `/dev/ohlc-labels` stays the place to look at cards. Optional header counts on the gallery are fine if they come from the existing list API; not required to close v1.

---

## 7. Backfill (one-shot) + live path

### 7.1 One-shot

New script `scripts/backfill-mcap-labels.ts` (npm script `mcap:backfill-labels` optional). Same host-DB notes as `scripts/backfill-ml-labels.ts` (`DATABASE_URL` / `DATABASE_URL_DIRECT`). Flags: `--dry-run`.

For **every** `token_mcap_tracking` row (all chains):

1. Load the row into an `McapSnapshot`.
2. `reconcileMilestonesFromGrowth` so a stored growth ≤ −40/−80 stamps drop columns the same way a live tick would (existing helper; timestamp is “now” when the column was null — do not invent a historical clock).
3. If `peak_growth_percent` is null or not finite and `mcap_growth_percent` is finite and **greater** than the stored peak, set peak growth from current growth. Do not lower an existing peak. This mirrors `updatePeakMcap` for a peak that was never stored. Do not add a new threshold.
4. `applyAutoLabelsFromMilestones`.
5. If the label, drop stamps, or peak fields changed, `UPDATE` those columns only. Do not reset `first_seen_at` or session age.
6. If the label **after** step 4 is `potential` or `rugged`, capture OHLC (§6) unless `--dry-run`.

Dry-run: no `UPDATE`, no OHLC network. Print the counts below.

OHLC concurrency default **3**. One mint failure increments `ohlc_failed` and continues. Re-run is safe: unchanged labels, `DO NOTHING` on existing gallery rows.

### 7.2 Live continuous

The tracking update that already calls `applyMcapSessionUpdates` / `applyAutoLabelsFromMilestones` is the continuous path. On a true label change to `potential` or `rugged`, capture after persist (§6.1). No cron. No second rule.

`resetTrackingSession` clears milestones and peak and does **not** clear `label` today. Leave that. After a reset, soft overwrite will not demote `rugged` just because the drop stamps were cleared. Do not “fix” that in v1.

### 7.3 Log counts

`scanned`, `label_updated`, `label_unchanged`, `ohlc_captured`, `ohlc_existing`, `ohlc_failed`, `ohlc_potential_total`, `ohlc_rug_total`.

---

## 8. Tracker filters / tabs

Surface: `/dev/signals?tab=tracker` (`TrackerTab`), inside **Filters & Search**.

### 8.1 Controls (to-spec UX)

Single-select chips. Default **All** shows the same rows as today.

| Chip | Query `label` | SQL |
|---|---|---|
| All | omit | no label predicate |
| Potential | `potential` | `label = 'potential'` |
| Rug | `rugged` | `label = 'rugged'` |
| Watching | `watching` | `label = 'watching'` |
| Traded live | `traded_live` | `label = 'traded_live'` |
| Valid | `valid` | `label = 'valid'` |
| Unlabeled | `unlabeled` | `label IS NULL` |

Chip **Rug** displays the stored value `rugged`. Do not write `rug` onto the tracker.

Server-side on `buildMcapListWhere` / `GET action=list` so pagination `total` matches. Unknown `label` → **400** (same idea as `/api/mcap-tracking/label`). Chain, search, time, growth, and mcap filters still AND with this.

Put `label` on `FilterOptions` and the list query string. Sync to the page URL as `label` when not All, so a refresh keeps the tab.

### 8.2 Card chip

Show the display label on the tracker card (today it is CSV-only): Potential, Rug, Watching, Traded live, Valid. Omit the chip when null.

This chip is the tracker label, not an Algo Tester strategy and not an OHLC card.

### 8.3 Gallery

Do not move `/dev/ohlc-labels` into the Tracker. Do not filter the gallery by Tracker tabs. Operators use Tracker to separate potential vs rug **tokens**, and the gallery to inspect captured candles.

---

## 9. Tracker ↔ strategies honesty

### 9.1 Rule

A `token_mcap_tracking` presence row is **tracked**, not a strategy, when `strategyId == null` and `source === 'token_mcap_tracking'`.

Apply that in `buildStrategyPresence` + `TokenMapLane`. Other lanes (signals list, social, DLMM, rug list, real `strategy_outcomes` rows) stay as they are in v1.

### 9.2 Copy and link

| Piece | Today | v1 |
|---|---|---|
| Row title | `token_mcap_tracking` | **Tracked** |
| Link text | `Open` | **Open positions** (must not be the bare word Open) |
| `deepLink` | `/dev/algo-tester` | `/dev/algo-tester?tab=open&domain=mcap_tracker&tokenAddress={mint}` plus `chain` when the locate call was chain-scoped |
| Note under the row | (none) | **Tracked on MCap — not an open strategy** |
| Header chip | tracker label or `present` | keep the tracker label when set (`potential`, display Rug if you map it here too) |
| Activity empty | No recent activity | **unchanged**, and only in the activity list |

`links.algoTester` for this presence row must not stay the bare path. Outcome-group rows keep their existing Closed deep link (`links.strategies` already has `tokenAddress`).

Suggested pure helper (implementation PR):

```ts
export function mcapTrackedAlgoTesterHref(
  mint: string,
  chain?: string | null,
): string {
  const q = new URLSearchParams({
    tab: 'open',
    domain: 'mcap_tracker',
    tokenAddress: mint,
  })
  if (chain) q.set('chain', chain)
  return `/dev/algo-tester?${q.toString()}`
}
```

Optional fields on `StrategyPresence`: `linkLabel?: string`, `note?: string`. Lane uses `linkLabel ?? 'Open'` so other rows keep Open.

### 9.3 Algo Tester must honor the query

Open tab (`AlgoOpenPositionsTab` / `filterAlgoPositions`):

- Accept `tokenAddress`.
- Keep the row when `tokenAddress` is empty.
- When set, keep positions whose `tokenAddress` equals that mint (case-sensitive mint compare as stored).
- Show the token field on Open as well as Closed so the landing query is visible (`showToken` not Closed-only).
- Empty copy names the mint: `No open mcap_tracker positions for {mint}` when domain and mint are set and the list is empty.

Do not insert a position when the list is empty. Closed `tokenAddress` behavior stays the outcomes filter (zero rows for the seed mint is the honest result).

### 9.4 Activity copy

“No recent activity” renders only when that lane’s activity array is empty. Do not move it into the presence header. Do not replace it with a fake sim line. It means the last-24h activity feed (`fetchTokenMapActivity`), not “this mint is untracked.”

### 9.5 Seed acceptance

For `AVXPQqxd32ABAP5F7shHKNeWBpos9miktdH3uKqgXYJZ` with a tracking row and zero mcap outcomes:

- Lane title reads Tracked, not the table name and not a strategy id.
- Href contains `tab=open`, `domain=mcap_tracker`, and the mint.
- Activity list may still say No recent activity.
- Algo Tester Open for that mint shows no position.
- Closed outcomes for that mint stay empty.
- `strategy_outcomes` / `trading_records` row counts for that mint are unchanged by the implementation.

---

## 10. Files to touch (implementation PR, not this one)

| Path | Why |
|---|---|
| `src/utils/mcap-tracker.ts` | Live capture hook after a real auto-label change. Reuse the predicate |
| `src/utils/mcap-tracker-drop-peak.test.ts` | Protections already covered; add “no capture predicate change” only if the helper is split |
| `src/strategies/signal-ohlc-labels.ts` | Call site only; do not rework fetch |
| `src/strategies/signal-ohlc-window.ts` | Citation. No new window |
| `scripts/backfill-mcap-labels.ts` | One-shot |
| `package.json` | Optional `mcap:backfill-labels` |
| `src/app/api/mcap-tracking/route.ts` | `label` on `buildMcapListWhere` |
| `src/app/api/mcap-tracking/label/route.ts` | Capture on manual `potential` if not already covered |
| `src/hooks/useMCapTracker.ts` | Pass `label` |
| `src/components/signals/TrackerTab.tsx` | Tabs + card chip |
| `src/strategies/token-locate.ts` | Tracked presence href + note |
| `src/components/token-locate/TokenMapLane.tsx` | Link text, note; activity copy stays put |
| `src/components/algo-tester/algo-tester-query.ts` | Mint filter + empty copy |
| `src/components/AlgoPositions.tsx` | `AlgoOpenPositionsTab` passes mint |
| `src/components/algo-tester/AlgoTesterHub.tsx` | Token box on Open; pass `tokenAddress` |
| `src/strategies/token-locate.test.ts` / algo-tester query tests | Honesty href + empty mint |

**Do not touch for v1:** `getMcapSimOpenSkipReason`, sim-track worker, `markTokenPotential` list sync, `EVAL_SHADOW`, `strategy_outcomes` writers, OHLC fetch internals, Flowey, detect-snapshot `system` default.

---

## 11. Flags

None required. Assignment is the existing rule; honesty is copy and links.

Do not add a flag that turns potential into a sim-open. Do not enable `EVAL_SHADOW` or `ML_CLOSED_LOOP` from this work.

---

## 12. Acceptance criteria

### Labels

- [ ] Peak growth &gt; 0 sets `potential` only from null / `valid` / `watching`.
- [ ] Drop −40 or −80 sets `rugged` except over `traded_live` and existing `rugged`.
- [ ] `traded_live` and `rugged` are not overwritten by the potential branch.
- [ ] Stored values are `potential` and `rugged` only (no new `system` / `rug` tracker value).
- [ ] Auto path and one-shot do not insert into `dlmm_potential_list` or `token_rug_list`.

### OHLC

- [ ] Capture runs for live transitions and for backfill rows that are potential or rugged.
- [ ] Window is the existing 10m potential helper and existing rug window. Interval stays `1m`.
- [ ] Tracker label does not change because bars are empty or the pattern is unseen.
- [ ] `rugged` is stored on the gallery as `rug`.
- [ ] Second run does not duplicate `(token, label)` rows.

### Backfill

- [ ] Job reads all `token_mcap_tracking` rows.
- [ ] `--dry-run` writes nothing.
- [ ] Re-run is idempotent.
- [ ] One OHLC failure does not abort the scan.

### Tracker

- [ ] Chips: All, Potential, Rug, Watching, Traded live, Valid, Unlabeled.
- [ ] Default All matches today’s list.
- [ ] Rug chip filters `label = 'rugged'`.
- [ ] Pagination total respects the label filter.
- [ ] Card shows the display label.
- [ ] `/dev/ohlc-labels` still renders the corpus.

### Honesty

- [ ] Seed-shaped presence: title Tracked, link not bare `Open`, href has mint + `domain=mcap_tracker` + `tab=open`.
- [ ] Note says it is tracked, not an open strategy.
- [ ] “No recent activity” only when the activity list is empty.
- [ ] Open tab filters to that mint and shows an empty state, not a made-up position.
- [ ] No new `strategy_outcomes` or sim trading record for the seed mint.

### Non-goals held

- [ ] `getMcapSimOpenSkipReason` unchanged.
- [ ] `EVAL_SHADOW` unchanged.
- [ ] No OHLC pattern model.
- [ ] No Flowey edits.

---

## 13. Test plan

No product tests in this docs PR. Implementation PR ships:

### 13.1 Auto-label (extend `mcap-tracker-drop-peak.test.ts`)

Existing cases stay (drop → rugged, peak → potential, `traded_live` sticky, rugged not downgraded). Add only if a wrapper appears:

| Fixture | Expect |
|---|---|
| `watching`, peak 1, no drop | `potential` |
| `potential`, then drop stamp | `rugged` |
| `rugged`, peak 100, drops cleared in memory but label rugged | stay `rugged` |
| `valid`, peak 0, growth 0 | unchanged |

### 13.2 Backfill (unit, DB mocked)

| Row | Expect |
|---|---|
| growth −45, drop columns null, label null | drop_40 stamped, label `rugged` |
| peak null, growth 10, label null | peak set, label `potential` |
| label `traded_live`, drop_80 set | label stays |
| label `potential`, no milestone change | no label UPDATE; OHLC capture still attempted |
| dry-run | zero writes |

### 13.3 Honesty (unit)

| Input | Expect |
|---|---|
| mint + chain `sol` | href contains `tab=open`, `domain=mcap_tracker`, `tokenAddress`, `chain=sol` |
| mint, no chain | no `chain` param |
| presence source `token_mcap_tracking`, `strategyId` null | `linkLabel` is `Open positions`, note set, title not the table name |
| presence from `strategy_outcomes` with a strategy id | still uses its Closed deep link; link label may stay Open |
| `filterAlgoPositions` with mint | other mints hidden |
| empty open list + mint | copy includes the mint and `mcap_tracker` |

### 13.4 List filter

- `label=rugged` SQL includes `label = $n` and does not return `potential`.
- `label=unlabeled` → `IS NULL`.
- `label=rug` → 400.
- omitted label → no label predicate (All).

---

## 14. Suggested code shape (implementation PR, not this one)

```ts
export function trackerLabelDisplay(label: string | null | undefined): string | null {
  if (label === 'rugged') return 'Rug'
  if (label === 'potential') return 'Potential'
  if (label === 'watching') return 'Watching'
  if (label === 'traded_live') return 'Traded live'
  if (label === 'valid') return 'Valid'
  return null
}

export function isTrackedMcapPresence(row: {
  source: string
  strategyId?: string | null
}): boolean {
  return row.source === 'token_mcap_tracking' && !row.strategyId
}
```

Keep both free of I/O. Backfill imports `applyAutoLabelsFromMilestones` and `reconcileMilestonesFromGrowth` from `mcap-tracker` rather than re-implementing the cuts.

---

## 15. Open items (non-blocking)

1. Gallery header counts — optional.
2. Whether Open’s token box is always visible or only when `tokenAddress` is in the query. Default: **always on Open**, same as Closed, so the operator can clear the mint.
3. Human lock beyond `traded_live` / `rugged` stickiness — not in v1.
4. Pattern spec after corpus ≥ ~300 — separate document, not this implement PR.
5. Whether system labels later join an ML training export — out of scope here.

---

## 16. Decision log

| Date | Item | Outcome |
|---|---|---|
| 2026-09-22 | System assignment | Existing mcap auto-rules; peak → `potential`; drop 40/80 → `rugged`; live overwrite protections |
| 2026-09-22 | Vocabulary | Store `potential` / `rugged`; UI may say Rug; OHLC store `potential` / `rug` |
| 2026-09-22 | OHLC | Additional corpus labels; not a demote/qualify gate |
| 2026-09-22 | OHLC window (this SPEC) | Reuse 10m `POTENTIAL_MAX_MS` + existing rug window; interval `1m` |
| 2026-09-22 | Backfill | All tracker rows; soft overwrite; OHLC for resulting and existing; one-shot + live |
| 2026-09-22 | Reorganize | Tracker tabs; gallery stays corpus; no list-sync requirement |
| 2026-09-22 | Join bug | UI honesty only; mint + domain deep link; no write-path; no invented outcomes |
| 2026-09-22 | Ship shape (this SPEC) | One SPEC, one implement PR |
| 2026-09-22 | As-built | No `system` on the tracker row; auto-label does not capture OHLC; lane Open is bare `/dev/algo-tester`; seed mint has 0 outcomes |

---

## 17. Related docs

- Tracker list: [SPEC-tracker-catch-train-v1.md](./SPEC-tracker-catch-train-v1.md), [SPEC-early-enter-soft-gate-v1.md](./SPEC-early-enter-soft-gate-v1.md)
- Algo Tester desk: [SPEC-strategies-algo-tester-unify-v1.md](./SPEC-strategies-algo-tester-unify-v1.md)
- MCap behavior: [../mcap-tracker.md](../mcap-tracker.md)
- Strategy spine: [../03-strategies-and-automation.md](../03-strategies-and-automation.md)
- Research notes (Wayfinder assets, not in-repo): `as-built-potential-rug-labels-findings.md`, `avx-mint-tracker-without-strategies-findings.md`
