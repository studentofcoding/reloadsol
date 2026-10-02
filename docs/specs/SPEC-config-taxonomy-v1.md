# SPEC — Categorise the config surface: by substrate, then by scope

**Status:** **Implemented** — T1–T4 and T6 shipped; **T5 is done as a derived view** (the lifecycle word
ships for cron workers *and* strategies, and retired `search_*` variants are archived in the Config tab).
Not done, and deliberately: a *stored* lifecycle column, and the storage-level collapse of the duplicated
family blocks. The body below is kept as the design record; **§ As built** records what landed and where
the build diverged from the plan.
**Date:** 2026-10-02 (as-built 2026-10-03)
**Provenance:** the `/debug` pass of 2026-10-02 over `/dev/algo-tester?tab=config` (the rendered page's
full text) plus a code read of `AlgoTesterHub.tsx` — the Config tab is a dynamic import, fed by a single
`GET /api/strategies?chain=…`.
**Related:** [SPEC-strategies-algo-tester-unify-v1.md](./SPEC-strategies-algo-tester-unify-v1.md) —
**this is the Config tab's half of that unify and lands inside it, not beside it** ·
[SPEC-strategy-data-pipeline-v1.md](./SPEC-strategy-data-pipeline-v1.md) (one canonical builder, the same
instinct one layer down) · [SPEC-rug-verdict-block-v1.md](./SPEC-rug-verdict-block-v1.md) (where the
"vacuous is not green" rule was first forced)

## As built (2026-10-03)

| task | status | evidence |
|---|---|---|
| **T1** census | **Shipped** | `scripts/config-census.mjs` + baseline `SPEC-config-taxonomy-v1.census.json` — 141 fields across 11 types, **NO_READER 0 / UI_ONLY 0**. Committed and re-run after every slice; unchanged at 141. |
| **T2** vacuity | **Shipped** | The Noul flip-readiness meter no longer renders green when its deciding band is empty — `ok={bars.agreementOk && !vacuousAgreement}` with "· vacuous" beside it; the token funnel states `spec_would_pass is false on all N rows`. Three live cases. |
| **T3** Health tab | **Shipped** | `health` added to `ALGO_TESTER_TABS` / `TAB_LABELS`; a new `AlgoHealthPanel` carries `EarlyEnterNoulShadowPanel` (Noul funnel, peak/token lists, token funnel) and the Workers/cron table + `domain_heartbeat`. Config no longer carries them, and the cron table is one copy (`WorkersTable`), not two. |
| **T4** four scopes | **Shipped** | **Global:** `CombinedScoreWeightsPanel` (v1 defaults shown beside the fields, per-field source). **Family:** a read-only `FamilyDefaultRow` renders each shared block once — gmgn radar / security / exit, signals scoring, mcap exit. **Overrides:** a card shows only the fields it overrode; the rest sits behind a `CardFieldReveal` *"show inherited (N)"* toggle, inherited greyed and overrides bold, and a never-overridden section collapses rather than leaving an empty titled shell. **Switches:** `ExecutionModeSelect` / notify toggles as effect-labelled badges. |
| **T5** lifecycle | **Shipped (derived)** | **Workers:** `disabled → retired`, succeeded → active, never → trial (`b0a9d9d`). **Strategies:** the same rule over `is_active` + the latest closed `strategy_outcomes.exit_at` as `last_success_at` — `src/strategies/strategy-lifecycle.ts`, read via `GET /api/strategies/lifecycle`, rendered by `StrategyLifecycleGrid` on every family's cards. **`search_*`:** an inactive `search_{mcap,gmgn,signals}_*` row folds into a collapsed *"Archived search variants (N) — retired, not deleted"* group. There is no list of "the six" in code — they are DB-only rows spawned by `strategy-search-bandit.ts` — so the predicate is the id prefix + `retired`; a *live* search clone (cap 3) stays in the main grid. **Not done:** nothing is stored (no lifecycle column; flipping `is_active` back un-archives), and the storage-level collapse of the duplicated blocks the SPEC lists last — the family rows (T4) removed the duplication from the page, not from the rows. |
| **T6** source / radius | **Shipped** | **Source (rule 1):** `SourceTag` + the route's `sources` diff. **Radius (rule 2):** stated where the number is — the weights panel's "two mechanisms answer to rug" note, the family-row labels, and the per-card override count. |

**Where the build diverged from the plan** (kept, because a wrong record is worse than none):

1. **T1's anchor moved.** Not "every key the page renders" but the **exported config types in
   `src/strategies/types.ts`** — a first attempt anchored on `merge-strategy-config-patch.ts` and reported
   that function's *parameters*; deleted, not committed.
2. **T1's result is a scope statement.** The two keys known inert in production (`brain_stop_loss_pct` on
   726 rows, `ml_exit_overlay` on 1136 / applied on 0) sit **outside** those types — in the per-strategy data
   blobs. The trend block's own inert `filtering` editor later became `SPEC-inert-filtering-block-v1.md`,
   and the overlay is covered by `SPEC-ml-shadow-lane-v1.md`; this SPEC labels them, it does not wire them.
3. **T2's premise was half wrong** — the *"Agreement is vacuous: keep band is 0"* banner already existed.
   The defect was the green ✓ meter beside it.
4. **Rule 1 (source) could not be settled in the UI.** A stored value equal to the default is ambiguous
   between *saved* and *falling back*, and the defaults are not in scope at the call sites — so provenance is
   computed at the route (`GET /api/strategies` → `sources`, `diffSource`) and threaded to the cards.
5. **The card override count was family-wide, not per-card.** `sources.<family>` is the whole family's diff
   keyed `<id>.<path>`; the first cut counted all of it. Fixed while wiring T4's second half by slicing to
   the card (`own(...)` in `StrategyConfigTab`).

## Goal

Make the config surface answer three questions at a glance — **what is this value, who owns it, what does
changing it affect** — and make that stay true rather than being tidied once a quarter.

The problem is not that config lives in many places. It is that the page mixes **three kinds of thing**
and never says which is which, and that within the config there are **four scopes** rendered as one flat
column.

## The taxonomy

### Split by substrate first

| substrate | examples | lifecycle |
|---|---|---|
| **Config** | weights, bands, TP/SL, filters | saved to the DB, editable |
| **Runtime switches** | `LIVE_TRADE_ENABLED`, `EVAL_*`, `*_SHADOW` modes | env, deploy-time. **Editing these is a deploy, and the UI must say so** |
| **Evidence** | Noul readiness funnel, peak/token lists, token funnel, cron table, domain heartbeat | read-only, none of it config |

That last row is the largest single source of "all over the places": **five read-only surfaces rendered
inside a config editor.** They belong in a **Health** tab — which is also what actually gets opened daily.

### Then by scope, ordered by blast radius

1. **Global policy** — combined-score weights, the exit standard, the ML overlay tiers. One value, one
   place, default shown beside it.
2. **Family defaults** — the Signals scoring block, the GMGN radar block. This is where duplication dies.
3. **Strategy overrides** — per-strategy only. **Inherited values greyed, overrides in bold**, so a
   strategy with no overrides looks empty. That is what it is.
4. **Runtime switches** — read-only badges with their effect spelled out
   (`LIVE_TRADE_ENABLED=0 → live trading off`), never styled as editable fields.

## Evidence

Measured from the rendered page (2026-10-02).

### The gates are green and vacuous

```
Noul flip-readiness   A >= 85% -> 100.0% (2622/2622) ✓      while: keep band is 0
                      the page's own words: "Agreement is vacuous"
cl confidence         range 0.270-0.416  vs a >= 0.55 threshold   -> unreachable by the population
token funnel          spec_would_pass = false on 135/135 rows
peak list             keep 0 · mid 0 of 1056 mints
7d eval               80 candidates · 12 resolved · 3 correct (25%) · avg score win 0.20 / loss 0.24
```

A rate that can be green only because no input reaches it is a **display defect**. Same class as the
validation harness printing `0/0` as "precision 0.0%", and the third unreachable threshold found today —
after the volume band and the first `coreThreshold=60`.

### Duplication is systematic

| family | strategies | identical block |
|---|---|---|
| Signals | 5 (1 active) | the six scoring values — milestone 15/20/25, stuck 50, stopLoss 100, sellOver100 40. Only `enter score >=` (50 vs 40) and `minGrowth` (0 vs 10) differ |
| GMGN | 4 (1 active) | the fourteen radar values — sticky 50, dump −80, TTL 45, enter 55, drawdown 70, trough 30000, recover 1.5, min radar 45, … |
| MCap | 5 (2 active) | three near-identical `search_mcap_*` variants differing only in TP (150/200/300) |
| Trending | 4 (2 active) | two fully configured but inactive |

**Nine strategies render a complete editing surface that does nothing**, and six are `search_*`
experiments whose results already live in the outcomes table.

### Two domains have stopped producing

```
signals  last closed outcome 07/09   (3.5 weeks)
dlmm     last closed outcome 24/09   (8 days)
```

matching their stale cron jobs exactly (`rh_lp_screen` since 07/09; `dlmm_manage` and
`mcap_tracker_sim_open` since 29/09).

## The four rules that keep it tidy

1. **Every value declares its source** — code default / DB row / env. The page does this for two rows
   ("defaults · draft sum 1.0000", "env shadow, no override") and not for the rest.
2. **Every value declares its blast radius** — global / family / this strategy — so the reach of a save is
   visible *before* it is made.
3. **A green state no input can produce renders as `vacuous`, not ✓.** Band occupancy beside every rate.
4. **Every strategy carries a lifecycle** — `trial | active | retired` — which retires the `search_*`
   experiments and, reused, lets the cron's dead workers stop occupying attention.

## Tasks

*Shipped — see § As built for evidence and the T5 remainder. The list is kept as written.*

**T1 — the census (first, and it is the rule that makes the rest hold).** A script that walks every config
key the page renders, greps the codebase for its reader, and reports three buckets: **read** / **read but
inert** (written, never applied — `brain_stop_loss_pct` on 726 rows, `ml_exit_overlay` on 1136 and applied
on 0) / **no reader at all**. Committed, re-runnable, output stored with this SPEC. Without it the page
drifts back within a month regardless of how it is grouped.

**T2 — vacuity display.** Every rate renders its band occupancy; an empty band renders `vacuous`. Small,
and it is the finding worth leading with.

**T3 — split Health out.** Noul funnel, peak/token lists, token funnel, cron table, domain heartbeat →
their own tab.

**T4 — the four scopes.** Global → family → overrides → runtime switches, inherited greyed, overrides
bold, switches as effect-labelled badges.

**T5 — lifecycle and retirement.** `trial | active | retired`; archive the six `search_*` variants and
collapse the two duplicated blocks into family defaults.

**T6 — the source/radius labels** from rules 1 and 2, rendered consistently.

## Non-goals

- Not changing any *value*: presentation and ownership only. A collapsed family default carries the same
  numbers.
- Not a new page for the config (the unify SPEC owns that surface).
- Not touching enforcement, gate modes, or the dead-worker fix.

## Risks

- **A reorganisation that changes behaviour is worse than the mess.** Every step presentation-only, pinned
  by the existing tests plus the T1 census before and after.
- **Daily-use surface** — land in slices (T1, T2 first, both read-only), not one rewrite.
- **The duplication collapse is the only step touching storage** — it goes last.

## Verification

1. T1's census attached and identical after each step (no key gains or loses a reader).
2. T2: a vacuous rate renders `vacuous` live; a non-vacuous one still renders a number.
3. T4: a strategy with no overrides shows an empty override set — the property that makes today's
   duplication visible as emptiness.
4. Repo gate (`lint` · tests · build) **and the page rendered in a browser** — a config surface is not
   verified by typechecking.
