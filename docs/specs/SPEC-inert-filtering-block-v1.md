# SPEC — The inert `filtering` block: nine knobs, no consumer

**Status:** docs-only, for review. Nothing implemented, nothing removed. Written because the config
surface's own worst failure mode turned out to be documented in a source comment and nowhere else.

**Date:** 2026-10-01
**Related:** `SPEC-config-taxonomy-v1.md` (this is its rule 1 — *every value declares its blast radius* —
applied to a block that turned out to have none).

---

## The finding, in the source's own words

`src/strategies/registry.ts:48-53`:

```ts
export const DEFAULT_FILTER_CONFIG: TokenFilterConfig = {
  enabled: true,
  // NOTE: nothing in the trending_bot chain reads `filtering` today — `passesConditions` reads
  // `strategy.conditions`, which is the RH mcap band above. These are env-tunable so that wiring it
  // up does not also mean editing constants, but turning a knob here currently changes nothing.
  mcap: { min: envNumber('RH_FILTER_MCAP_MIN', 350_000), max: envNumber('RH_FILTER_MCAP_MAX', 3_000_000) },
```

That comment is the whole SPEC. Nine fields render as a live editor, persist on save, and are read by no
decision.

## Evidence

| fact | where | verified how |
|---|---|---|
| `passesConditions` reads `strategy.conditions`, not `filtering` | the comment above, written before today | read in `registry.ts` |
| the editor renders 9 fields, tagged with provenance | `StrategyAdminHub.tsx:2797` (`TrendingBotFilterFields`), section at `:2877` | read |
| saving **persists** them | the trending card's save sends `filtering: buildFilteringRef.current()` | read |
| `filtering` is a real, typed config block | `TokenFilterConfig`, 9 fields in the census | `config-census.mjs` |
| it is env-tunable | `RH_FILTER_MCAP_MIN` / `MAX`, `RH_FILTER_PRICE_CHANGE_*` | read |
| the page now discloses it | `Filtering — INERT: nothing reads these today` | commit `be5321b` |

**The precise defect class.** T7 gave these nine fields accurate `stored` / `defaults` provenance, and
that accuracy is the problem: the page can now say *exactly* where a value came from, for a value that
decides nothing. Provenance on an inert control reads as confidence. This is the same shape as
`brain_stop_loss_pct` (written on 726 rows, never applied) and `ml_exit_overlay` (1136 rows, 0 applied) —
a wired-but-inert control is worse than no field, because it accepts intent and discards it.

## The decision this SPEC asks for

**Which of the three, and it is a behaviour decision, not a label:**

1. **Wire it** — `passesConditions` reads `filtering` (bands on mcap, price change 5m/1h/6h, organic
   score, top-holders %). This is what the editor has always implied, and it is the only option that
   makes nine existing knobs real. **Cost:** it changes which tokens enter. That is a live-trading
   behaviour change.
2. **Retire it** — delete the block, its `TokenFilterConfig` type, the `RH_FILTER_*` env keys, and every
   doc mention. **Cost:** deletes a surface someone may have configured against, and the deletion is
   total (per the standing rule: removal means removal, not unreachable code).
3. **Leave it labelled** — status quo as of `be5321b`. **Cost:** nine knobs stay in the UI that a reader
   must learn to ignore; the label is honest but the surface is still noise.

**Recommendation: option 1, shadow-first.** The entry gate is *meant* to filter — `conditions` is a
two-sided RH mcap band doing the job of one, while the richer band sits unused. Wire `filtering` into
`passesConditions` behind a shadow log first: record what filtering *would* have rejected on every would-
be entry without blocking anything, and only enforce once the shadow shows what it costs. That is the
standing rule for measurement vs enforcement, and it applies exactly here.

## Non-goals

- Not touching `conditions` — it is live and correct as the RH band.
- Not changing any value. This SPEC is about which code path reads them.
- Not part of T4's re-cut, though T4 will move this block into a family row eventually; the decision here
  should land first, so the row is built over something real.

## Risks

- **Option 1 is a trading behaviour change.** Shadow-first exists precisely so the decision is made on
  what the filter would have rejected, not on a guess.
- **Option 2 touches the docs.** `README.md`'s env block and any strategy tables mentioning
  `RH_FILTER_*` go with it, or the drift this SPEC is about returns as documentation.

## Verification gate

1. Whatever is chosen, `node scripts/config-census.mjs --only-dull` must still report 141 fields — or
   report the new number with the delta explained (option 2 removes fields by design).
2. Option 1: the shadow log shows rejections on real throughput before any enforcement is enabled, and a
   `..._MODE=shadow|enforce` env plus a kill switch, per the standing pattern.
3. Option 2: no dangling reference to `filtering`, `TokenFilterConfig` or `RH_FILTER_*` — grep, not
   memory.
4. The rendered check is the user's; the page is wallet-gated.
